import { branchStockAcceptance } from "./fixtures/branch-stock-acceptance.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
import { currentHtmlResource } from "./fixtures/html-resource.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";

import { readProfileSources } from "./fixtures/profile-inputs.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
import { fixtureRequest, selectBusinessResource } from "./fixtures/business-session.mjs";
import { openWorkbenchPage, htmlFrameElement } from "./fixtures/business-page.mjs";

async function branchPageRoot() {
  const sources = await readProfileSources(process.env.GEA_TEST_SOURCE_INPUTS);
  const workbench = sources.find((source) => source.repo === "dsh-agent-workbench");
  assert.ok(workbench, "the fixed Source inputs must name the Workbench asset owner");
  const root = join(workbench.assetRoot, "lib/business/inventory-fc");
  const prompt = JSON.parse(await readFile(join(root, "prompt.json"), "utf8"));
  assert.equal(prompt.consumerCode, "branch-inventory");
  assert.deepEqual(prompt.pageAgents, ["gea-html-inventory-fc", "gea-html-inventory-qll"]);
  return root;
}

async function sessionPreset(app, sessionId) {
  const rows = await readSession(app.runtime, sessionId);
  let preset = rows[0]?.agentPreset;
  for (const row of rows) {
    if (row.type !== "agent-preset/selected") continue;
    assert.equal(typeof row.data.agentPreset, "string");
    preset = row.data.agentPreset;
  }
  return preset;
}
const tool = (name, args) => ({
  tool_calls: [
    {
      index: 0,
      id: randomUUID(),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

test(
  "branch stock filter, quote and two authorized Agents keep separate Sessions",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 240000,
  },
  async (t) => {
    const branchPage = await branchPageRoot();
    const qll = await mkdtemp(join(tmpdir(), "stock-ability-qll-"));
    t.after(() => rm(qll, { recursive: true, force: true }));
    await mkdir(join(qll, "skills"));
    await writeFile(
      join(qll, "skills/SKILL.md"),
      "---\nname: inventory-qll\ndescription: 全链库存\n---\n按授权范围解释库存。\n",
    );
    await writeFile(
      join(qll, "plugin.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "inventory-qll",
        name: "全链库存",
        version: "0.0.0",
        html: "index.html",
        skills: ["skills/SKILL.md"],
        mcp: "mcp.json",
        gea: { consumerCode: "full-chain-inventory", readonly: true, contract: "gea-html-v2" },
      }),
    );
    await writeFile(
      join(qll, "mcp.json"),
      JSON.stringify({
        provider: "gea",
        transport: "host-provided",
        contract: "gea-html-v2",
        consumer: { consumerType: "AGENT", consumerCode: "full-chain-inventory" },
        capabilities: ["governed-sql-read"],
      }),
    );
    await writeFile(
      join(qll, "index.html"),
      "<!doctype html><html><title>全链库存</title><body>固定样本辅助 Agent</body></html>",
    );
    await currentHtmlResource(qll);
    const state = stockState();
    let stockRoute;
    const modelRequests = [];
    installStockRoutes(
      {
        route: (handler) => {
          stockRoute = handler;
        },
      },
      state,
      (body) => {
        modelRequests.push(body);
        const latestUser = body.messages.findLastIndex((message) => message.role === "user");
        const latestText = JSON.stringify(body.messages[latestUser] ?? {});
        const referenceId = latestText.match(/dsh-page:(R[a-f0-9]{12})/)?.[1];
        if (!referenceId && !body.tools.some((entry) => entry.function.name === "gea_page"))
          return { content: "fixture closed-page turn completed" };
        return body.messages.slice(latestUser + 1).some((message) => message.role === "tool")
          ? { content: "已按当前页面解释。" }
          : referenceId
            ? tool("page_reference_read", { id: referenceId })
            : tool("gea_page", { action: "context" });
      },
    );
    let denyQll = false;
    let userId = "9007199254740993";
    let tenantId = "0";
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          baseUrl: base + "/v1",
          model: "fixture",
          apiKeyEnv: "GEA_TEST_MODEL_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      beforeStart: fixtureWorkbench([branchPage, qll]),
      env: { GEA_TEST_MODEL_KEY: "fixture-key" },
    });
    app.route(async (request, response, reply) => {
      if (request.url.pathname.endsWith("/getUserInfo")) {
        reply({
          success: true,
          result: { userInfo: { id: userId, realname: "测试用户", loginTenantId: tenantId } },
        });
        return true;
      }
      if (request.url.pathname.endsWith("/ai/gateway/session")) {
        const body = JSON.parse(request.body);
        state.gateway.push(body);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: !(denyQll && body.consumerCode === "full-chain-inventory") },
            gatewayContext: {
              consumerType: "AGENT",
              consumerCode: body.consumerCode,
              sessionId: "fixture-cube",
              conversationId: body.conversationId,
            },
            delegationToken: "fixture-only",
          },
        });
        return true;
      }
      return stockRoute(request, response, reply);
    });
    await app.login();
    const browser = await testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );

    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1440, height: 1000 },
    });
    t.after(() => context.close());
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date(branchStockAcceptance.fixedTime));
    page.setDefaultTimeout(25000);
    const opens = [],
      contexts = [],
      errors = [];
    let referencePosts = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().endsWith("/api/page-interaction/reference")) referencePosts++;
    });
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/agent-workbench/page") || !response.ok()) return;
      const request = response.request().postDataJSON();
      if (request?.operation === "open") opens.push({ ...request, ...(await response.json()) });
      if (request?.operation === "context") contexts.push(request.parameters);
    });
    await page.goto(app.origin);
    await openWorkbenchPage(page, "分仓库存");
    const frame = htmlFrameElement(page, "inventory-fc").contentFrame();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    const chooser = page.getByRole("combobox", { name: "选择解读能力" });
    await expect(chooser).toBeVisible();
    await expect(chooser.locator("option")).toHaveCount(2);
    await expect.poll(() => typeof opens.at(-1)?.owner).toBe("string");
    const branchSession = opens.at(-1).sessionId;
    const branchOwner = opens.at(-1).owner;
    assert.equal(opens.at(-1).resourceId, "gea-html-inventory-fc");
    await expect.poll(() => sessionPreset(app, branchSession)).toBe("gea-html-inventory-fc");
    const search = frame.getByPlaceholder("搜索 SKU / 产品名称");
    await search.fill("FC001");
    await expect(frame.locator(".replenishment-table tbody")).toContainText("FC001");
    await expect(frame.locator(".replenishment-table tbody")).not.toContainText("FC002");
    await expect.poll(() => contexts.at(-1)?.parts?.pageReference?.scope).toContain("FC001");
    assert.deepEqual(
      contexts.at(-1).parts.branchDraft.visibleReplenishments.map((row) => row.sku),
      ["FC001"],
    );
    assert.equal(contexts.at(-1).parts.data.parameters.draft, undefined);
    assert.equal(contexts.at(-1).parts.branchDraft.quantities, undefined);
    const currentScope = await frame
      .locator("main.agent-root")
      .getAttribute("data-page-reference-scope");
    assert.equal(contexts.at(-1).parts.pageReference.scope, currentScope);
    await page.locator("[data-page-selection-trigger]").click();
    const storedQuote = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/page-interaction/reference") && response.status() === 200,
    );
    await frame
      .locator(".replenishment-table tbody tr")
      .filter({ hasText: "FC001" })
      .first()
      .locator("td")
      .first()
      .click();
    const referenceId = (await (await storedQuote).json()).id;
    await expect(page.locator('[contenteditable="true"]').first()).toContainText(/dsh-page|FC001/);
    assert.equal(referencePosts, 1);
    await frame.locator("body").evaluate((body) => {
      const frameWindow = body.ownerDocument.defaultView;
      const original = frameWindow.fetch.bind(frameWindow);
      frameWindow.fetch = (input, init) => {
        const path = typeof input === "string" ? input : input.url;
        if (!path.includes("/api/warehouse-page")) return original(input, init);
        return new Promise((resolve, reject) => {
          frameWindow.__releaseStockFetch = () => {
            frameWindow.fetch = original;
            Promise.resolve(original(input, init)).then(resolve, reject);
          };
        });
      };
    });
    await search.fill("FC002");
    await expect(frame.locator("main.agent-root")).toHaveAttribute(
      "data-page-reference-ready",
      "false",
    );
    await expect(frame.locator(".business-panel")).toHaveAttribute("aria-busy", "true");
    await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("loading");
    assert.equal(contexts.at(-1).parts.pageReference, undefined);
    assert.equal(contexts.at(-1).parts.branchDraft, undefined);
    assert.equal(referencePosts, 1, "a loading page cannot quote its stale row");
    await frame
      .locator("body")
      .evaluate((body) => body.ownerDocument.defaultView.__releaseStockFetch());
    await expect(frame.locator("main.agent-root")).toHaveAttribute(
      "data-page-reference-ready",
      "true",
    );
    await search.fill("FC001");
    await expect
      .poll(() => {
        const scope = contexts.at(-1)?.parts?.pageReference?.scope;
        return (
          typeof scope === "string" && scope.includes('"search":"FC001"') && scope !== currentScope
        );
      })
      .toBe(true);
    const refreshedScope = contexts.at(-1).parts.pageReference.scope;
    assert.notEqual(
      refreshedScope,
      currentScope,
      "a new ready response owns a new reference scope",
    );
    const promptPage = async (sessionId, expected, prompt = "解释当前筛选的分仓库存") => {
      const selected = await app.remote("session/selectModel", {
        sessionId,
        provider: "gea-analysis",
        model: "fixture",
      });
      assert.equal(selected.ok, true, JSON.stringify(selected));
      const priorRows = await readSession(app.runtime, sessionId);
      const before = priorRows.filter((row) => row.type === "turn/end").length;
      const modelRequestStart = modelRequests.length;
      const sent = await app.remote("session/prompt", {
        requestId: randomUUID(),
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: prompt }],
      });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      const rows = await until(
        () => readSession(app.runtime, sessionId),
        (value) => value.filter((row) => row.type === "turn/end").length > before,
        60000,
      );
      const receipts = readToolResults(rows);
      if (expected === "MENU_WITHDRAWN") {
        const currentRequests = modelRequests.slice(modelRequestStart);
        assert.equal(currentRequests.length, 1);
        assert.ok(
          currentRequests.every(
            (request) => !request.tools.some((entry) => entry.function.name === "gea_page"),
          ),
        );
        const currentRows = rows.slice(priorRows.length);
        assert.equal(currentRows.filter((row) => row.type === "tool/call").length, 0);
        assert.ok(currentRows.some((row) => row.type === "turn/end"));
        assert.match(JSON.stringify(currentRows), /fixture closed-page turn completed/);
        assert.doesNotMatch(
          JSON.stringify(currentRows),
          /USER_PAGE_REFERENCE|FC001|gea-html-inventory-fc/,
        );
      } else {
        assert.ok(
          receipts.every((receipt) => !receipt.isError),
          JSON.stringify(receipts),
        );
        assert.ok(
          receipts.some((receipt) => receipt.text.includes(expected)),
          JSON.stringify(receipts),
        );
      }
    };
    await promptPage(branchSession, "evidenceId");
    await promptPage(
      branchSession,
      "USER_PAGE_REFERENCE",
      `请解释 @[FC001](dsh-page:${referenceId})`,
    );
    const contextsBeforeSwitch = contexts.length;
    await chooser.selectOption("gea-html-inventory-qll");
    await expect.poll(() => opens.at(-1)?.sessionId).not.toBe(branchSession);
    const qllSession = opens.at(-1).sessionId;
    assert.equal(opens.at(-1).resourceId, "gea-html-inventory-fc");
    await expect.poll(() => sessionPreset(app, qllSession)).toBe("gea-html-inventory-qll");
    const releasedOwner = await fixtureRequest(app, "/api/agent-workbench/page", {
      operation: "context",
      owner: branchOwner,
      parameters: {},
    });
    assert.equal(releasedOwner.ok, false);
    assert.equal(releasedOwner.value.error, "PAGE_OWNER_RELEASED");
    assert.notEqual(qllSession, branchSession);
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    await expect.poll(() => contexts.length).toBeGreaterThan(contextsBeforeSwitch);
    await expect
      .poll(() => {
        const parts = contexts.at(-1)?.parts;
        return (
          parts?.queryState?.state === "ready" &&
          typeof parts.pageReference?.scope === "string" &&
          parts.pageReference.scope !== refreshedScope
        );
      })
      .toBe(true);
    await promptPage(qllSession, "evidenceId");
    await promptPage(
      qllSession,
      "REFERENCE_UNAVAILABLE",
      `请解释 @[FC001](dsh-page:${referenceId})`,
    );
    await promptPage(branchSession, "MENU_WITHDRAWN");
    const currentAuthority = await page.evaluate(() =>
      fetch("/api/gea-html/identity")
        .then((response) => response.json())
        .then((value) => value.scope),
    );
    const mismatch = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/agent-workbench/page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      {
        operation: "open",
        pageId: "inventory-fc",
        sessionId: branchSession,
        resourceId: "gea-html-inventory-qll",
      },
    );
    assert.equal(mismatch.status, 400);
    // The old caller-supplied agentPreset field is retired; a forged page resource must be rejected.
    assert.equal(mismatch.value.error, "PAGE_RESOURCE_NOT_ALLOWED");
    const selectedReadonly = await selectBusinessResource(app, "gea-readonly");
    assert.equal(selectedReadonly.preset, "gea-readonly");
    const unsupportedSession = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    assert.equal(unsupportedSession.ok, true, JSON.stringify(unsupportedSession));
    const unsupported = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/agent-workbench/page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      {
        operation: "open",
        pageId: "inventory-fc",
        sessionId: unsupportedSession.value.sessionId,
        resourceId: "gea-html-inventory-fc",
      },
    );
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.value.error, "PAGE_AGENT_PRESET_NOT_ALLOWED");
    denyQll = true;
    const denied = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/agent-workbench/page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      {
        operation: "open",
        pageId: "inventory-fc",
        sessionId: qllSession,
        resourceId: "gea-html-inventory-fc",
      },
    );
    assert.equal(denied.status, 400);
    await app.rpc("logout");
    await expect(chooser).toHaveCount(0);
    tenantId = "1";
    await app.login();
    const tenantScope = await page.evaluate(() =>
      fetch("/api/gea-html/identity")
        .then((response) => response.json())
        .then((value) => value.scope),
    );
    assert.notEqual(tenantScope, currentAuthority);
    const crossIdentity = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/agent-workbench/page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      {
        operation: "open",
        pageId: "inventory-fc",
        sessionId: branchSession,
        resourceId: "gea-html-inventory-fc",
      },
    );
    assert.equal(crossIdentity.status, 400);
    assert.equal(crossIdentity.value.error, "PAGE_SESSION_IDENTITY_MISMATCH");
    await promptPage(
      branchSession,
      "REFERENCE_UNAVAILABLE",
      `请解释 @[FC001](dsh-page:${referenceId})`,
    );
    await app.rpc("logout");
    userId = "9007199254740994";
    tenantId = "0";
    await app.login();
    const userScope = await page.evaluate(() =>
      fetch("/api/gea-html/identity")
        .then((response) => response.json())
        .then((value) => value.scope),
    );
    assert.notEqual(userScope, tenantScope);
    const revokedOwner = await fixtureRequest(app, "/api/agent-workbench/page", {
      operation: "context",
      owner: opens.find((row) => row.sessionId === qllSession).owner,
      parameters: {},
    });
    assert.equal(revokedOwner.ok, false);
    assert.equal(revokedOwner.value.error, "PAGE_OWNER_RELEASED");
    const crossUser = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/agent-workbench/page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      {
        operation: "open",
        pageId: "inventory-fc",
        sessionId: branchSession,
        resourceId: "gea-html-inventory-fc",
      },
    );
    assert.equal(crossUser.status, 400);
    assert.equal(crossUser.value.error, "PAGE_SESSION_IDENTITY_MISMATCH");
    assert.deepEqual(errors, []);
    assert.ok(state.gateway.some((request) => request.consumerCode === "full-chain-inventory"));
    if (process.env.GEA_TICKET07_EVIDENCE) {
      await writeFile(
        process.env.GEA_TICKET07_EVIDENCE,
        JSON.stringify(
          {
            sessions: { branch: branchSession, fullChain: qllSession },
            opens,
            referencePosts,
            contexts: contexts.map((value) => ({
              queryState: value.parts?.queryState,
              filters: value.parts?.pageFilters,
              scope: value.parts?.pageReference?.scope,
              visibleSkus: value.parts?.branchDraft?.visibleReplenishments?.map((row) => row.sku),
            })),
            gatewayConsumers: state.gateway.map((request) => request.consumerCode),
            rejected: {
              mismatch: mismatch.value.error,
              unsupported: unsupported.value.error,
              consumer: denied.value.error,
              crossTenant: crossIdentity.value.error,
              crossUser: crossUser.value.error,
            },
            modelCalls: state.models.length,
          },
          null,
          2,
        ),
      );
    }
  },
);

test(
  "a missing second Agent is omitted and cannot create a page Session",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const branchPage = await branchPageRoot();
    const app = await profile(t, { beforeStart: fixtureWorkbench([branchPage]) });
    const state = stockState();
    installStockRoutes(app, state, () => ({ content: "fixture" }));
    await app.login();
    const selected = await selectBusinessResource(app, "gea-html-inventory-fc");
    assert.equal(selected.preset, "gea-html-inventory-fc");
    const response = await fetch(
      app.origin +
        "/api/agent-manage/resources?" +
        new URLSearchParams({ cwd: app.runtime + "/workspace" }),
      {
        headers: { Cookie: app.cookie, Origin: app.origin },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).find((resource) => resource.id === "gea-html-inventory-fc")
        .interpreters,
      ["gea-html-inventory-fc"],
    );
    const unavailable = await fixtureRequest(app, "/api/agent-manage/resources/select", {
      id: "gea-html-inventory-qll",
      cwd: app.runtime + "/workspace",
    });
    assert.equal(unavailable.ok, false);
    const missing = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-html-inventory-qll",
    });
    assert.equal(missing.ok, false);
  },
);

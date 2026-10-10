import { currentHtmlResource } from "./fixtures/html-resource.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { modelProfile } from "./fixtures/model-profile.mjs";
import { installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";

const branchPage = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
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
    installStockRoutes(
      {
        route: (handler) => {
          stockRoute = handler;
        },
      },
      state,
      (body) => {
        const latestUser = body.messages.findLastIndex((message) => message.role === "user");
        const latestText = JSON.stringify(body.messages[latestUser] ?? {});
        const referenceId = latestText.match(/dsh-page:(R[a-f0-9]{12})/)?.[1];
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
    const app = await modelProfile(t, {
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
      env: {
        GEA_TEST_MODEL_KEY: "fixture-key",
        GEA_HTML_PLUGIN_ROOTS: JSON.stringify([branchPage, qll]),
      },
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
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
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
    page.setDefaultTimeout(25000);
    const opens = [],
      contexts = [],
      errors = [];
    let referencePosts = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (request.url().endsWith("/api/page-interaction/reference")) referencePosts++;
      if (
        !request.url().endsWith("/api/gea-html/inventory-fc/open") &&
        !request.url().endsWith("/api/gea-html/inventory-fc/call")
      )
        return;
      const body = request.postDataJSON();
      if (request.url().endsWith("/open")) opens.push(body);
      if (body.method === "context") contexts.push(body.parameters);
    });
    await page.goto(app.origin);
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/ })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    if (!(await page.getByText("分仓库存", { exact: true }).isVisible()))
      await page.getByText("库存管理", { exact: true }).click();
    await page.getByText("分仓库存", { exact: true }).click();
    const frame = page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]').contentFrame();
    await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
    const chooser = page.getByRole("combobox", { name: "选择解读能力" });
    await expect(chooser).toBeVisible();
    await expect(chooser.locator("option")).toHaveCount(2);
    await expect.poll(() => opens.at(-1)?.agentPreset).toBe("gea-html-inventory-fc");
    const branchSession = opens.at(-1).session;
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
      const before = (await readSession(app.runtime, sessionId)).filter(
        (row) => row.type === "turn/end",
      ).length;
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
      assert.ok(
        receipts.some((receipt) => !receipt.isError && receipt.text.includes(expected)),
        JSON.stringify(receipts),
      );
    };
    await promptPage(branchSession, "evidenceId");
    await promptPage(
      branchSession,
      "USER_PAGE_REFERENCE",
      `请解释 @[FC001](dsh-page:${referenceId})`,
    );
    const contextsBeforeSwitch = contexts.length;
    await chooser.selectOption("gea-html-inventory-qll");
    await expect.poll(() => opens.at(-1)?.agentPreset).toBe("gea-html-inventory-qll");
    const qllSession = opens.at(-1).session;
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
    await promptPage(branchSession, "PAGE_NOT_IN_WORKBENCH");
    const currentAuthority = await page.evaluate(() =>
      fetch("/api/gea-html/identity")
        .then((response) => response.json())
        .then((value) => value.scope),
    );
    const mismatch = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      { session: branchSession, agentPreset: "gea-html-inventory-qll", scope: currentAuthority },
    );
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.value.error, "PAGE_AGENT_SESSION_MISMATCH");
    const unsupportedSession = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-readonly",
    });
    assert.equal(unsupportedSession.ok, true, JSON.stringify(unsupportedSession));
    const unsupported = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      {
        session: unsupportedSession.value.sessionId,
        agentPreset: "gea-readonly",
        scope: currentAuthority,
      },
    );
    assert.equal(unsupported.status, 400);
    assert.equal(unsupported.value.error, "PAGE_AGENT_PRESET_NOT_ALLOWED");
    denyQll = true;
    const denied = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      { session: qllSession, agentPreset: "gea-html-inventory-qll", scope: currentAuthority },
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
    const crossIdentity = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      { session: branchSession, agentPreset: "gea-html-inventory-fc", scope: tenantScope },
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
    const crossUser = await page.evaluate(
      async (body) => {
        const response = await fetch("/api/gea-html/inventory-fc/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, value: await response.json() };
      },
      { session: branchSession, agentPreset: "gea-html-inventory-fc", scope: userScope },
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
    const app = await profile(t, { env: { GEA_HTML_PLUGIN_ROOTS: JSON.stringify([branchPage]) } });
    const state = stockState();
    installStockRoutes(app, state, () => ({ content: "fixture" }));
    await app.login();
    const response = await fetch(app.origin + "/api/gea-html/inventory-fc/agents", {
      headers: { Cookie: app.cookie, Origin: app.origin },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(
      (await response.json()).map((agent) => agent.preset),
      ["gea-html-inventory-fc"],
    );
    const missing = await app.remote("session/create", {
      cwd: app.runtime + "/workspace",
      agentPreset: "gea-html-inventory-qll",
    });
    assert.equal(missing.ok, false);
  },
);

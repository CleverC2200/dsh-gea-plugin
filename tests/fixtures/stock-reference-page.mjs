import { branchStockAcceptance } from "./branch-stock-acceptance.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtureEnvironment } from "./business-session.mjs";
import { openWorkbenchPage, htmlFrameElement } from "./business-page.mjs";
import { testBrowser } from "./test-browser.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { profile, readSession, readToolResults, until } from "../profile.mjs";
import { stockState, installStockRoutes } from "./branch-stock.mjs";

export async function stockReferencePage(
  t,
  { editable = false, holdMessage, environments = false, preparePage } = {},
) {
  const identity = { userId: "9007199254740993", tenantId: "0" };
  const state = stockState();
  if (editable) state.mode = "editable";
  let stockRoute;
  installStockRoutes(
    {
      route: (fn) => {
        stockRoute = fn;
      },
    },
    state,
    (body) => {
      const reference = /dsh-page:(R[a-f0-9]{12})/;
      const index = body.messages.findLastIndex(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          reference.test(message.content),
      );
      assert.notEqual(index, -1, "the fixture must receive a referenced user question");
      const id = reference.exec(body.messages[index].content)[1];
      return body.messages.slice(index + 1).some((message) => message.role === "tool")
        ? { content: "引用读取结束" }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: "function",
                function: { name: "page_reference_read", arguments: JSON.stringify({ id }) },
              },
            ],
          };
    },
  );
  fixtureEnvironment(t, { GEA_TEST_MODEL_KEY: "fixture-key" });
  const app = await profile(t, {
    beforeStart: async ({ runtime }) => {
      const path = resolve(runtime, "home/profiles/plugin-split-validation");
      await mkdir(path, { recursive: true });
      await writeFile(
        resolve(path, "cordis.patch.yml"),
        JSON.stringify([
          {
            id: "agent-workbench",
            config: {
              cwd: runtime + "/workspace",
              htmlRoots: [resolve("../dsh-agent-workbench/lib/business/inventory-fc")],
            },
          },
        ]),
      );
    },
    config: (base) => ({
      ...(environments
        ? {
            environment: "test",
            geaEnvironments: { production: base + "/production", test: base + "/test" },
          }
        : {}),
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
    },
  });
  app.route((request, response, reply) => {
    if (request.url.pathname.endsWith("/getUserInfo")) {
      reply({
        success: true,
        result: {
          userInfo: { id: identity.userId, realname: "测试用户", loginTenantId: identity.tenantId },
        },
      });
      return true;
    }
    return stockRoute(request, response, reply);
  });
  await app.login();
  const binding = await fetch(app.origin + "/api/page-interaction/binding", {
    headers: { Cookie: app.cookie },
  });
  assert.equal(binding.status, 200, "reference binding must be served by the real Host");
  assert.equal(typeof (await binding.json()).generation, "string");
  const browser = await testBrowser(t, () =>
    chromium.launch({ channel: "chrome", headless: true }),
  );
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
  });
  await context.addCookies(
    app.cookie.split("; ").map((pair) => ({
      name: pair.slice(0, pair.indexOf("=")),
      value: pair.slice(pair.indexOf("=") + 1),
      url: app.origin,
    })),
  );
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(branchStockAcceptance.fixedTime));
  page.setDefaultTimeout(20000);
  if (holdMessage)
    await page.addInitScript((messageType) => {
      // Control delivery order while keeping the real iframe event and HTTP response.
      const held = [];
      let hold = true,
        replaying = false;
      window.heldReferenceMessages = held;
      window.releaseReferenceMessages = (type) => {
        if (!type) hold = false;
        const ready = held.filter((event) => !type || event.data.type === type);
        for (const event of ready) held.splice(held.indexOf(event), 1);
        replaying = true;
        for (const event of ready)
          dispatchEvent(
            new MessageEvent("message", {
              data: event.data,
              source: event.source,
              origin: event.origin,
            }),
          );
        replaying = false;
      };
      addEventListener(
        "message",
        (event) => {
          if (
            hold &&
            !replaying &&
            event.data?.protocol === "dsh-page-interaction-v1" &&
            [].concat(messageType).includes(event.data.type)
          ) {
            event.stopImmediatePropagation();
            held.push(event);
          }
        },
        true,
      );
    }, holdMessage);
  const opens = [],
    contexts = [],
    owners = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
    const body = request.postDataJSON();
    if (body.operation === "open" && body.pageId === "inventory-fc") opens.push(body);
    if (body.operation === "context") contexts.push(body.parameters);
  });
  const captureInitialOwner = async (response) => {
    if (
      !response.url().endsWith("/api/agent-workbench/page") ||
      !response.request().postData() ||
      response.request().postDataJSON().operation !== "open" ||
      response.request().postDataJSON().pageId !== "inventory-fc" ||
      !response.ok()
    )
      return;
    owners.push(await response.json());
  };
  page.on("response", captureInitialOwner);
  await preparePage?.(page);
  await page.goto(app.origin);
  await openWorkbenchPage(page, "分仓库存");
  const frame = htmlFrameElement(page, "inventory-fc").contentFrame();
  await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
  await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("ready");
  await expect.poll(() => owners.at(-1)?.owner).toEqual(expect.any(String));
  page.off("response", captureInitialOwner);
  const session = opens.at(-1).sessionId;
  assert.match(session, /^session-[0-9a-f-]{36}$/);
  const quote = async () => {
    const trigger = page.locator("[data-page-selection-trigger]");
    if ((await trigger.getAttribute("aria-pressed")) !== "true") await trigger.click();
    await frame
      .locator(".replenishment-table tbody tr")
      .filter({ hasText: "FC001" })
      .first()
      .locator("td")
      .first()
      .click();
  };
  const readReference = async (id) => {
    const selected = await app.remote("session/selectModel", {
      sessionId: session,
      provider: "gea-analysis",
      model: "fixture",
    });
    if (!selected.ok) throw Error(JSON.stringify(selected));
    const before = (await readSession(app.runtime, session)).filter(
      (row) => row.type === "turn/end",
    ).length;
    const sent = await app.remote("session/prompt", {
      requestId: randomUUID(),
      sessionId: session,
      mode: "queue",
      content: [{ type: "text", text: `读取 @[测试](dsh-page:${id})` }],
    });
    if (!sent.ok) throw Error(JSON.stringify(sent));
    const rows = await until(
      () => readSession(app.runtime, session),
      (rows) => rows.filter((row) => row.type === "turn/end").length > before,
      60000,
    );
    return readToolResults(rows).at(-1);
  };
  return {
    app,
    page,
    frame,
    session,
    identity,
    contexts,
    quote,
    readReference,
    owner: owners.at(-1).owner,
    openRequest: opens.at(-1),
  };
}

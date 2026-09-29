import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { profile, readSession, readToolResults, until } from "../profile.mjs";
import { stockState, installStockRoutes } from "./branch-stock.mjs";

export async function stockReferencePage(t, { editable = false } = {}) {
  const identity = { userId: "9007199254740993", tenantId: "0" };
  const state = stockState();
  if (editable) state.mode = "editable";
  let stockRoute;
  installStockRoutes({ route: fn => { stockRoute = fn; } }, state, body => {
    const index = body.messages.findLastIndex(message => message.role === "user");
    const id = JSON.stringify(body.messages[index]).match(/dsh-page:(R[a-f0-9]{12})/)?.[1];
    return body.messages.slice(index + 1).some(message => message.role === "tool")
      ? { content: "引用读取结束" }
      : { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "page_reference_read", arguments: JSON.stringify({ id }) } }] };
  });
  const app = await profile(t, {
    config: base => ({ analysis: { mode: "model", baseUrl: base + "/v1", model: "fixture", apiKeyEnv: "GEA_TEST_MODEL_KEY", contextWindow: 32768, maxTokens: 2048 } }),
    env: { GEA_TEST_MODEL_KEY: "fixture-key", GEA_HTML_PLUGIN_ROOTS: JSON.stringify([resolve("../dsh-agent-workbench/lib/business/inventory-fc")]) },
  });
  app.route((request, response, reply) => {
    if (request.url.pathname.endsWith("/getUserInfo")) {
      reply({ success: true, result: { userInfo: { id: identity.userId, realname: "测试用户", loginTenantId: identity.tenantId } } });
      return true;
    }
    return stockRoute(request, response, reply);
  });
  await app.login();
  const binding = await fetch(app.origin + "/api/page-interaction/binding", { headers: { Cookie: app.cookie } });
  assert.equal(binding.status, 200, "reference binding must be served by the real Host");
  assert.equal(typeof (await binding.json()).generation, "string");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 1000 } });
  await context.addCookies(app.cookie.split("; ").map(pair => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: app.origin })));
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const opens = [], contexts = [];
  page.on("request", request => {
    if (!request.postData()) return;
    if (request.url().endsWith("/api/gea-html/inventory-fc/open")) opens.push(request.postDataJSON());
    if (request.url().endsWith("/api/gea-html/inventory-fc/call")) {
      const body = request.postDataJSON();
      if (body.method === "context") contexts.push(body.parameters);
    }
  });
  await page.goto(app.origin);
  await page.getByRole("dialog", { name: /内测声明|预览版说明/ }).getByRole("button", { name: "继续", exact: true }).click();
  if (!await page.getByText("分仓库存", { exact: true }).isVisible()) await page.getByText("库存管理", { exact: true }).click();
  await page.getByText("分仓库存", { exact: true }).click();
  const frame = page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]').contentFrame();
  await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
  await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("ready");
  const session = opens.at(-1).session;
  const quote = async () => {
    const trigger = page.locator("[data-page-selection-trigger]");
    if (await trigger.getAttribute("aria-pressed") !== "true") await trigger.click();
    await frame.locator(".replenishment-table tbody tr").filter({ hasText: "FC001" }).first().locator("td").first().click();
  };
  const readReference = async id => {
    const selected = await app.remote("session/selectModel", { sessionId: session, provider: "gea-analysis", model: "fixture" });
    if (!selected.ok) throw Error(JSON.stringify(selected));
    const before = (await readSession(app.runtime, session)).filter(row => row.type === "turn/end").length;
    const sent = await app.remote("session/prompt", { requestId: randomUUID(), sessionId: session, mode: "queue", content: [{ type: "text", text: `读取 @[测试](dsh-page:${id})` }] });
    if (!sent.ok) throw Error(JSON.stringify(sent));
    const rows = await until(() => readSession(app.runtime, session), rows => rows.filter(row => row.type === "turn/end").length > before, 60000);
    return readToolResults(rows).at(-1);
  };
  return { app, page, frame, session, identity, contexts, quote, readReference };
}

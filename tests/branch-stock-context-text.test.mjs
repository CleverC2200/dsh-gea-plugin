import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { stockState, installStockRoutes } from "./fixtures/branch-stock.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
import { openBusinessPage, htmlFrameElement } from "./fixtures/business-page.mjs";

test(
  "same-warehouse loading and failure do not publish retained KPI text as current facts",
  {
    skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
    timeout: 90000,
  },
  async (t) => {
    const app = await profile(t, {
      beforeStart: fixtureWorkbench([resolve("../dsh-agent-workbench/lib/business/inventory-fc")]),
    });
    const state = stockState();
    let stockRoute;
    installStockRoutes(
      {
        route: (handler) => {
          stockRoute = handler;
        },
      },
      state,
      () => ({ content: "fixture" }),
    );
    const held = Promise.withResolvers();
    let waiting = false;
    let holdBase = false;
    app.route(async (request, response, reply) => {
      if (
        holdBase &&
        request.url.pathname.endsWith("/ai/gateway/sql/execute") &&
        /base_supply|p\.base_finish_date/.test(JSON.parse(request.body).sql)
      ) {
        waiting = true;
        await held.promise;
        reply({ success: false, code: 500, message: "固定基地查询失败" }, 503);
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
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    const contexts = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/agent-workbench/page") && request.postData()) {
        const body = request.postDataJSON();
        if (body.operation === "context") contexts.push(body.parameters);
      }
    });
    try {
      await page.goto(app.origin);
      await openBusinessPage(page, "inventory-fc");
      const frame = htmlFrameElement(page, "inventory-fc").contentFrame();
      await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
      await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("ready");
      assert.match(contexts.at(-1).visibleText, /当前库存[\d,]+件/);
      holdBase = true;
      await frame.getByRole("button", { name: /基地资源/ }).click();
      await expect.poll(() => waiting).toBe(true);
      await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("loading");
      const loading = contexts.at(-1);
      // The existing UI deliberately keeps its last snapshot visible during a same-warehouse query.
      assert.match(await frame.locator(".priority-analysis").innerText(), /当前库存[\d,]+件/);
      held.resolve();
      await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("error");
      const error = contexts.at(-1);
      await mkdir(".runtime/branch-stock-evidence", { recursive: true });
      await writeFile(
        ".runtime/branch-stock-evidence/retained-text-context.json",
        JSON.stringify({ loading, error }, null, 2),
      );
      for (const value of [loading, error]) {
        assert.equal(value.parts.queryState.warehouseId, "changsha");
        assert.equal(value.parts.pageFilters.tab, "base");
        assert.equal(value.parts.inventoryInsight, undefined);
        assert.equal(value.visibleText, value.parts.queryState.message);
        assert.doesNotMatch(value.visibleText, /当前库存[\d,]+件/);
      }
    } catch (error) {
      await mkdir(".runtime/branch-stock-evidence", { recursive: true });
      await writeFile(
        ".runtime/branch-stock-evidence/retained-text-debug.json",
        JSON.stringify({ contexts, sql: state.rest.map((value) => value.sql) }, null, 2),
      );
      throw error;
    } finally {
      held.resolve();
    }
  },
);

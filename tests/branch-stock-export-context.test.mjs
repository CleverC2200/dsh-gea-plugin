import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { stockState, installStockRoutes } from "./fixtures/branch-stock.mjs";

for (const pendingState of ["loading", "error", "ready"])
  test(
    `late base CSV cannot overwrite ${pendingState} context after a new query`,
    {
      skip: process.env.GEA_TEST_SOURCE_CORE !== "1",
      timeout: 90000,
    },
    async (t) => {
      const app = await profile(t, {
        env: {
          GEA_HTML_PLUGIN_ROOTS: JSON.stringify([
            resolve("../dsh-agent-workbench/lib/business/inventory-fc"),
          ]),
        },
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
      const exporting = Promise.withResolvers();
      const querying = Promise.withResolvers();
      let phase = "initial",
        heldExports = 0,
        heldQueries = 0,
        failCurrent = pendingState === "error";
      app.route(async (request, response, reply) => {
        if (phase !== "initial" && request.url.pathname.endsWith("/ai/gateway/sql/execute")) {
          const body = JSON.parse(request.body);
          if (/BTRIM\((?:f\.base_group_name|p\.base_name)\) AS base_name/.test(body.sql)) {
            const current = Object.values(body.parameters ?? {}).includes("FC002");
            if (phase !== "base") {
              if (current) {
                heldQueries++;
                await querying.promise;
              } else {
                heldExports++;
                await exporting.promise;
              }
            }
            if (current && failCurrent) {
              reply({ success: false, code: 500, message: "固定新筛选查询失败" }, 503);
            } else {
              const rows = body.sql.includes("f.base_group_name")
                ? [
                    {
                      base_name: current ? "新筛选基地" : "导出原基地",
                      metric_name: "base_available_qty",
                      quantity: current ? 50 : 200,
                      sku_count: 1,
                      source_date: "2026-09-29",
                    },
                    {
                      base_name: current ? "新筛选基地" : "导出原基地",
                      metric_name: "base_in_transit_qty",
                      quantity: 20,
                      sku_count: 1,
                      source_date: "2026-09-29",
                    },
                  ]
                : [];
              reply({
                success: true,
                code: 200,
                result: {
                  requestId: request.headers["x-request-id"],
                  operation: "SELECT",
                  total: rows.length,
                  pageNo: 1,
                  pageSize: 200,
                  rows,
                },
              });
            }
            return true;
          }
        }
        return stockRoute(request, response, reply);
      });
      await app.login();
      const browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      const context = await browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1440, height: 1000 },
        acceptDownloads: true,
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
        if (request.url().endsWith("/api/gea-html/inventory-fc/call") && request.postData()) {
          const body = request.postDataJSON();
          if (body.method === "context") contexts.push(body.parameters);
        }
      });
      try {
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
        phase = "base";
        await frame.getByRole("button", { name: /基地资源/ }).click();
        await expect(frame.getByRole("cell", { name: "导出原基地", exact: true })).toBeVisible();
        await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("ready");
        phase = "export";
        const downloaded = page.waitForEvent("download");
        await frame.getByRole("button", { name: "CSV", exact: true }).click();
        await expect.poll(() => heldExports).toBeGreaterThanOrEqual(2);
        await frame.getByRole("button", { name: /补货确认/ }).click();
        await frame.getByRole("button", { name: /基地资源/ }).click();
        phase = "query";
        const search = frame.getByLabel("基地资源SKU", { exact: true });
        await search.fill("FC002");
        await frame.getByRole("button", { name: "查询", exact: true }).click();
        await expect.poll(() => heldQueries).toBeGreaterThanOrEqual(2);
        await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("loading");
        if (pendingState !== "loading") {
          querying.resolve();
          await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe(pendingState);
        }
        const before = contexts.at(-1);
        exporting.resolve();
        const download = await downloaded;
        const csv = await readFile(await download.path(), "utf8");
        assert.match(csv, /导出原基地/);
        assert.doesNotMatch(csv, /新筛选基地/);
        // The bridge coalesces publication for 350 ms; let the completed export's queued update settle.
        await page.waitForTimeout(700);
        const after = contexts.at(-1);
        await mkdir(".runtime/branch-stock-evidence", { recursive: true });
        await writeFile(
          `.runtime/branch-stock-evidence/export-${pendingState}.json`,
          JSON.stringify({ before, after, csv }, null, 2),
        );
        assert.equal(after.parts.queryState.state, pendingState);
        if (pendingState === "ready") {
          assert.deepEqual(
            after.parts.data,
            before.parts.data,
            "late export cannot replace the newer ready query",
          );
          assert.equal(after.parts.data.parameters.search, "FC002");
          assert.equal(after.parts.data.parameters.pageSize, 10);
        } else {
          assert.equal(
            after.parts.data,
            undefined,
            "a completed export must not republish data from its old query",
          );
          assert.equal(after.parts.inventoryInsight, undefined);
        }
        assert.equal(after.parts.pageFilters.tab, "base");
        failCurrent = false;
        querying.resolve();
        if (pendingState === "error")
          await frame.getByRole("button", { name: "重试读取", exact: true }).click();
        await expect.poll(() => contexts.at(-1)?.parts?.queryState?.state).toBe("ready");
        await expect.poll(() => contexts.at(-1)?.parts?.data?.parameters?.search).toBe("FC002");
        assert.equal(contexts.at(-1).parts.data.parameters.pageSize, 10);
        await expect(frame.getByRole("cell", { name: "新筛选基地", exact: true })).toBeVisible();
      } finally {
        exporting.resolve();
        querying.resolve();
      }
    },
  );

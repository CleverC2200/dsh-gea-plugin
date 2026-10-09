import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { stock, installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";
import { changeThemeSetting } from "./theme-settings.mjs";

const out = resolve(".runtime/branch-stock-evidence");
const migrated = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
const tool = (name, args, id) => ({
  tool_calls: [
    {
      index: 0,
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});
const query = {
  consumerCode: "branch-inventory",
  queries: [
    {
      name: "branch_stock",
      query: {
        dimensions: [
          "branch_stock.material_code",
          "branch_stock.warehouse_name",
          "branch_stock.snapshot_date",
        ],
        measures: ["branch_stock.available_qty"],
        filters: [
          {
            member: "branch_stock.warehouse_name",
            operator: "equals",
            values: ["长沙分仓"],
          },
        ],
        limit: 10,
      },
    },
  ],
};

test(
  "branch stock migration preserves rows and runs authorized page and Agent reads",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 240000 },
  async (t) => {
    await mkdir(out, { recursive: true });
    const browser = await chromium.launch({
      headless: true,
    });
    t.after(() => browser.close());
    const results = [];
    for (const [label, root] of [
      ["legacy", resolve("../dsh-agent-fc-plugin")],
      ["migrated", migrated],
    ]) {
      const state = stockState();
      let step = 0;
      const app = await profile(t, {
        config: (base) => ({
          analysis: {
            mode: "model",
            baseUrl: base + "/v1",
            model: "fixture",
            apiKeyEnv: "GEA_TEST_MODEL_KEY",
            agentCode: "branch-inventory",
            contextWindow: 32768,
            maxTokens: 2048,
          },
        }),
        env: {
          GEA_TEST_MODEL_KEY: "fixture-key",
          GEA_HTML_PLUGIN_ROOTS: JSON.stringify([root]),
        },
      });
      installStockRoutes(app, state, (body) => {
        step++;
        if (step === 1)
          return tool("skill", { name: "inventory-fc", offset: 1, limit: 80 }, "stock-skill");
        if (step === 2) return tool("gea_cube_query", query, "stock-query");
        const receipt = body.messages
          .filter((x) => x.role === "tool")
          .map((x) => x.content)
          .join("\n");
        assert.match(receipt, /100/);
        assert.match(receipt, /30/);
        return {
          content:
            "长沙分仓在2026-09-29固定样本中，FC001可用100件，FC002可用30件，合计130件。依据 inventory-fc Skill 与本轮 Cube 查询回执；这是本地验收样本。",
        };
      });
      await app.login();
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
      page.setDefaultTimeout(25000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(app.origin);
        await page
          .getByRole("dialog", { name: /内测声明|预览版说明/ })
          .getByRole("button", { name: "继续", exact: true })
          .click();
        if (!(await page.getByText("分仓库存", { exact: true }).isVisible()))
          await page.getByText("库存管理", { exact: true }).click();
        await page.getByText("分仓库存", { exact: true }).click();
        const iframe = page.locator('iframe[src*="/api/gea-html/inventory-fc/html"]');
        const frame = iframe.contentFrame();
        await expect(frame.getByText("当前库存", { exact: true })).toBeVisible();
        await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
        const text = await frame.locator("body").innerText();
        assert.ok(state.rest.length > 5);
        assert.ok(state.restConsumers.includes("branch-inventory"));
        results.push({ label, text, restCount: state.rest.length });
        await page.screenshot({
          path: resolve(out, label + "-light.png"),
          fullPage: true,
        });
        if (label === "migrated") {
          await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
          const settings = async (label) => {
            await page.getByRole("button", { name: "账户菜单", exact: true }).click();
            await page.getByRole("menuitem", { name: "设置", exact: true }).click();
            await page.getByRole("button", { name: "通用设置", exact: true }).click();
            await changeThemeSetting(page, label, "preference");
            await page.getByRole("button", { name: "关闭", exact: true }).click();
          };
          for (const [label, color] of [
            ["深色", "rgb(27, 29, 33)"],
            ["浅色", "rgb(247, 248, 250)"],
            ["深色", "rgb(27, 29, 33)"],
          ]) {
            await settings(label);
            await expect(frame.locator("body")).toHaveCSS("background-color", color);
            await expect(page.locator(".gea-agent-welcome")).toHaveCSS(
              "background-color",
              label === "深色" ? "rgb(36, 38, 43)" : "rgb(255, 255, 255)",
            );
          }
          const contrast = await frame.locator(".panel-primary").evaluate((button) => {
            const luminance = (value) => {
              const c = value
                .match(/[\d.]+/g)
                .slice(0, 3)
                .map(Number)
                .map((v) => {
                  v /= 255;
                  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
                });
              return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
            };
            const css = getComputedStyle(button);
            const a = luminance(css.color),
              b = luminance(css.backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          });
          assert.ok(contrast >= 4.5, "enabled filled button must use paired foreground");
          await page.screenshot({
            path: resolve(out, "migrated-dark.png"),
            fullPage: true,
          });
          await page.setViewportSize({ width: 720, height: 1000 });
          const search = frame.getByPlaceholder("搜索 SKU / 产品名称");
          await search.scrollIntoViewIfNeeded();
          await search.fill("FC001");
          await expect(frame.locator(".replenishment-table tbody")).toContainText("FC001");
          await expect(frame.locator(".replenishment-table tbody")).not.toContainText("FC002");
          await search.fill("不存在的SKU");
          await expect(frame.getByText("没有符合当前筛选条件的 SKU")).toBeVisible();
          await search.fill("");
          const suggestion = page.locator(".gea-agent-prompts button").last();
          await suggestion.scrollIntoViewIfNeeded();
          await suggestion.click();
          await expect(page.locator('[contenteditable="true"],textarea').first()).toHaveText(
            await suggestion.innerText(),
          );
          await page.locator('[contenteditable="true"],textarea').first().fill("");
          await page.screenshot({
            path: resolve(out, "migrated-narrow.png"),
            fullPage: true,
          });
          await page.setViewportSize({ width: 1440, height: 1000 });
          // A separate native business session runs the actual tool dispatcher and log receipts.
          const created = await app.remote("session/create", {
            cwd: app.runtime + "/workspace",
            agentPreset: "gea-html-inventory-fc",
          });
          assert.equal(created.ok, true);
          const id = created.value.sessionId;
          await app.remote("session/selectModel", {
            sessionId: id,
            provider: "gea-analysis",
            model: "fixture",
          });
          await app.remote("session/prompt", {
            requestId: randomUUID(),
            sessionId: id,
            mode: "queue",
            content: [
              {
                type: "text",
                text: "按分仓规则说明长沙分仓固定快照两项SKU的可用库存。",
              },
            ],
          });
          const rows = await until(
            () => readSession(app.runtime, id),
            (rows) => rows.some((x) => x.type === "turn/end"),
            60000,
          );
          const receipts = readToolResults(rows);
          assert.equal(receipts.length, 2);
          assert.ok(
            receipts.every((r) => !r.isError),
            JSON.stringify(receipts),
          );
          assert.match(receipts[0].text, /order-net-gap-v3/);
          assert.match(receipts[1].text, /100/);
          assert.equal(state.cube.length, 1);
          assert.ok(state.discovery.some((r) => r.agentCode === "branch-inventory"));
          assert.doesNotMatch(
            JSON.stringify(state.models),
            /fixture-cube-token|fixture-delegation/,
          );
          await writeFile(
            resolve(out, "agent-receipts.json"),
            JSON.stringify(
              {
                receipts,
                discovery: state.discovery,
                cube: state.cube,
                answer: state.models.length,
              },
              null,
              2,
            ),
          );
        }
        assert.deepEqual(errors, []);
      } catch (error) {
        await page.screenshot({
          path: resolve(out, label + "-failure.png"),
          fullPage: true,
        });
        await writeFile(
          resolve(out, label + "-debug.json"),
          JSON.stringify(
            {
              state,
              text: await page.locator("body").innerText(),
              frames: await Promise.all(
                page.frames().map(async (f) => ({
                  url: f.url(),
                  text: await f
                    .locator("body")
                    .innerText()
                    .catch(() => ""),
                })),
              ),
            },
            null,
            2,
          ),
        );
        throw error;
      } finally {
        await context.close();
        await app.stop();
      }
    }
    // Same external rows must retain names, units, totals and calculations.
    assert.equal(results[1].text, results[0].text);
    await writeFile(
      resolve(out, "comparison.json"),
      JSON.stringify({ results, fixture: stock }, null, 2),
    );
  },
);

for (const mode of ["denied", "error", "empty", "empty-error", "missing"]) {
  test(
    "branch page distinguishes " + mode + " data",
    { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000 },
    async (t) => {
      const state = stockState();
      state.mode = mode === "empty-error" ? "empty" : mode;
      const app = await profile(t, {
        env: { GEA_HTML_PLUGIN_ROOTS: JSON.stringify([migrated]) },
      });
      let stockRoute;
      installStockRoutes(
        {
          route: (handler) => {
            stockRoute = handler;
          },
        },
        state,
        () => ({ content: "未连接外部模型" }),
      );
      const heldRead = Promise.withResolvers();
      let waitingForWarehouse = false;
      app.route(async (request, response, reply) => {
        if (
          ["empty", "empty-error"].includes(mode) &&
          request.url.pathname.endsWith("/ai/gateway/sql/execute")
        ) {
          const body = JSON.parse(request.body);
          if (Object.values(body.parameters ?? {}).includes("34")) {
            waitingForWarehouse = true;
            await heldRead.promise;
            if (mode === "empty-error") {
              reply({ success: false, code: 500, message: "固定样本查询失败" }, 503);
              return true;
            }
          }
        }
        return stockRoute(request, response, reply);
      });
      t.after(() => heldRead.resolve());
      await app.login();
      const browser = await chromium.launch({
        headless: true,
      });
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
      const publishedContexts = [];
      page.on("request", (request) => {
        if (!request.url().endsWith("/api/gea-html/inventory-fc/call") || !request.postData())
          return;
        const payload = request.postDataJSON();
        if (payload.method === "context") publishedContexts.push(payload.parameters);
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
      try {
        if (mode === "denied") {
          await expect(page.getByRole("alert").filter({ hasText: "重新连接" })).toBeVisible({
            timeout: 15000,
          });
          assert.equal(state.rest.length, 0);
        } else if (mode === "error") {
          await expect(frame.getByText("无法进入分仓库存", { exact: true })).toBeVisible({
            timeout: 20000,
          });
          await expect(frame.getByText("FC001", { exact: true })).toHaveCount(0);
          if (mode === "denied")
            assert.equal(state.rest.length, 0, "rejected delegation cannot reach SQL");
        } else if (mode === "empty" || mode === "empty-error") {
          await expect(frame.getByText("当前授权范围暂无库存与计划数据")).toBeVisible({
            timeout: 20000,
          });
          await frame.getByRole("button", { name: "选择分仓", exact: true }).click();
          await frame.getByRole("option", { name: "郑州分仓", exact: true }).click();
          await expect.poll(() => waitingForWarehouse).toBe(true);
          await expect
            .poll(() => publishedContexts.at(-1)?.parts?.queryState?.state)
            .toBe("loading");
          const loadingParts = publishedContexts.at(-1).parts;
          assert.equal(loadingParts.queryState.warehouseId, "zhengzhou");
          assert.equal(loadingParts.pageFilters.warehouseId, "zhengzhou");
          assert.equal(loadingParts.data, undefined);
          assert.equal(loadingParts.inventoryInsight, undefined);
          assert.equal(loadingParts.branchDraft, undefined);
          heldRead.resolve();
          if (mode === "empty-error") {
            await expect(frame.getByText("无法进入分仓库存", { exact: true })).toBeVisible();
            await expect
              .poll(() => publishedContexts.at(-1)?.parts?.queryState?.state)
              .toBe("error");
            const errorParts = publishedContexts.at(-1).parts;
            assert.equal(errorParts.data, undefined);
            assert.equal(errorParts.inventoryInsight, undefined);
            assert.equal(errorParts.branchDraft, undefined);
            assert.equal(errorParts.queryState.warehouseId, "zhengzhou");
            assert.ok(errorParts.queryState.message);
            await mkdir(out, { recursive: true });
            await writeFile(
              resolve(out, "loading-error-context.json"),
              JSON.stringify({ loadingParts, errorParts }, null, 2),
            );
            return;
          }
          await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible({
            timeout: 20000,
          });
          await expect(frame.getByRole("button", { name: "选择分仓", exact: true })).toContainText(
            "郑州分仓",
          );
          await expect
            .poll(() => publishedContexts.at(-1)?.parts?.queryState)
            .toEqual({ state: "ready", warehouseId: "zhengzhou" });
          assert.equal(publishedContexts.at(-1).parts.pageFilters.warehouseId, "zhengzhou");
          assert.ok(state.rest.some((request) => Object.values(request.parameters).includes("34")));
          await frame.getByRole("button", { name: "选择分仓", exact: true }).click();
          await frame.getByRole("option", { name: "长沙分仓", exact: true }).click();
          await expect(frame.getByText("当前授权范围暂无库存与计划数据")).toBeVisible();
          await expect.poll(() => publishedContexts.at(-1)?.parts?.queryState?.state).toBe("empty");
          const emptyParts = publishedContexts.at(-1).parts;
          await mkdir(out, { recursive: true });
          await writeFile(
            resolve(out, "empty-return-context.json"),
            JSON.stringify(emptyParts, null, 2),
          );
          assert.equal(emptyParts.queryState.warehouseId, "changsha");
          assert.equal(emptyParts.pageFilters.warehouseId, "changsha");
          assert.equal(emptyParts.data, undefined);
          assert.equal(emptyParts.inventoryInsight, undefined);
          assert.equal(emptyParts.branchDraft, undefined);
          await frame.getByRole("button", { name: "选择分仓", exact: true }).click();
          await frame.getByRole("option", { name: "郑州分仓", exact: true }).click();
          await expect
            .poll(() => publishedContexts.at(-1)?.parts?.queryState)
            .toEqual({ state: "ready", warehouseId: "zhengzhou" });
          await expect
            .poll(() => publishedContexts.at(-1)?.parts?.inventoryInsight?.summary)
            .toMatch(/当前库存/);
          assert.equal(publishedContexts.at(-1).parts.branchDraft.warehouseId, "zhengzhou");
        } else {
          await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible({
            timeout: 20000,
          });
          const row = frame.locator(".replenishment-table tbody tr").filter({ hasText: "FC001" });
          await expect(row.locator("td").nth(3)).toContainText(/待核实|—|-/);
        }
        await mkdir(out, { recursive: true });
        await page.screenshot({
          path: resolve(out, mode + ".png"),
          fullPage: true,
        });
        await writeFile(
          resolve(out, mode + ".json"),
          JSON.stringify(
            {
              mode,
              text:
                mode === "denied"
                  ? await page.locator("body").innerText()
                  : await frame.locator("body").innerText(),
              restCount: state.rest.length,
              queryState: publishedContexts.at(-1)?.parts?.queryState,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await mkdir(out, { recursive: true });
        await writeFile(
          resolve(out, mode + "-debug.txt"),
          (await page.locator("body").innerText()) +
            "\nIFRAME\n" +
            (await frame
              .locator("body")
              .innerText({ timeout: 1000 })
              .catch(() => "")),
        );
        await page
          .screenshot({
            path: resolve(out, mode + "-debug.png"),
            fullPage: true,
            timeout: 5000,
          })
          .catch(() => {});
        throw error;
      } finally {
        heldRead.resolve();
        await browser.close();
        await app.stop();
      }
    },
  );
}

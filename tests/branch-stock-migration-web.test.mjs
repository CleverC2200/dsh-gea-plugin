import { testBrowser } from "./fixtures/test-browser.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { profile, readSession, readToolResults, until } from "./profile.mjs";
import { stock, installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";
import {
  branchStockAcceptance,
  branchStockExpectedText,
} from "./fixtures/branch-stock-acceptance.mjs";
import { readProfileSourceRecords } from "./fixtures/profile-inputs.mjs";
import { changeThemeSetting } from "./theme-settings.mjs";
import {
  htmlFrameElement,
  openWorkbenchPage,
  prepareWorkbenchHtmlRoots,
} from "./fixtures/business-page.mjs";

const out = resolve(".runtime/branch-stock-evidence");
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
  action: "query",
  response_mode: "inline_complete",
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
    const workbench = (await readProfileSourceRecords(process.env.GEA_TEST_SOURCE_INPUTS)).find(
      (source) => source.repo === "dsh-agent-workbench",
    );
    const migrated = resolve(workbench.assets ?? workbench.source, "lib/business/inventory-fc");
    await mkdir(out, { recursive: true });
    const browser = await testBrowser(t, () =>
      chromium.launch({
        channel: "chrome",
        headless: true,
      }),
    );

    // The immutable historical body supplies every business-text byte. Only
    // W 3202a531's refresh button is added to the current full-text expectation.
    // Separate monthly test plans support the unchanged numerical example.
    // Its producer commit is unknown; the original artifact and data Git provenance live in the receipt.
    const original = JSON.parse(
      await readFile(new URL("./fixtures/branch-stock-original.json.raw", import.meta.url), "utf8"),
    );
    assert.deepEqual(original.fixture, stock);
    const legacy = original.results.find((result) => result.label === "legacy");
    assert.equal(typeof legacy?.text, "string");
    const results = [legacy];
    for (const [label, root] of [["migrated", migrated]]) {
      const state = stockState(branchStockAcceptance);
      let step = 0;
      const app = await profile(t, {
        config: (base) => ({
          cubeMcpCodes: { production: "cube" },
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
        beforeStart: prepareWorkbenchHtmlRoots([root]),
        env: { GEA_TEST_MODEL_KEY: "fixture-key" },
      });
      installStockRoutes(app, state, (body) => {
        step++;
        if (step === 1)
          return tool("skill", { name: "inventory-fc", offset: 1, limit: 80 }, "stock-skill");
        if (step === 2) return tool("mcp__gea-gateway__query_business_data", query, "stock-query");
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
      await page.clock.setFixedTime(new Date(branchStockAcceptance.fixedTime));
      page.setDefaultTimeout(25000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.goto(app.origin);
        await openWorkbenchPage(page, "分仓库存");
        const iframe = htmlFrameElement(page, "inventory-fc");
        const frame = iframe.contentFrame();
        await expect(frame.getByText("当前库存", { exact: true })).toBeVisible();
        await expect(frame.getByText("FC001", { exact: true }).first()).toBeVisible();
        await expect(frame.getByRole("button", { name: "刷新", exact: true })).toBeVisible();
        assert.equal(
          await frame.locator("body").evaluate(() => new Date().toISOString()),
          "2026-09-29T04:00:00.000Z",
        );
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
          assert.ok(state.gateway.some((request) => request.consumerCode === "branch-inventory"));
          assert.doesNotMatch(
            JSON.stringify(state.models),
            /fixture-cube-token|fixture-delegation/,
          );
          await writeFile(
            resolve(out, "agent-receipts.json"),
            JSON.stringify(
              {
                receipts,
                gateway: state.gateway,
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
    // Preserve the complete names, units, columns, rows and calculations.
    assert.equal(results[1].text, branchStockExpectedText(results[0].text));
    await writeFile(
      resolve(out, "comparison.json"),
      JSON.stringify({ results, fixture: stock, acceptance: branchStockAcceptance }, null, 2),
    );
  },
);

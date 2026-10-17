import { testBrowser } from "./fixtures/test-browser.mjs";
import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { installStockRoutes, stockState } from "./fixtures/branch-stock.mjs";
import { branchStockAcceptance } from "./fixtures/branch-stock-acceptance.mjs";
import { readProfileSourceRecords } from "./fixtures/profile-inputs.mjs";
import {
  htmlFrameElement,
  openWorkbenchPage,
  prepareWorkbenchHtmlRoots,
} from "./fixtures/business-page.mjs";

const out = resolve(".runtime/branch-stock-evidence");

for (const mode of ["denied", "error", "empty", "empty-error", "missing"]) {
  test(
    "branch page distinguishes " + mode + " data",
    { skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000 },
    async (t) => {
      const workbench = (await readProfileSourceRecords(process.env.GEA_TEST_SOURCE_INPUTS)).find(
        (source) => source.repo === "dsh-agent-workbench",
      );
      const migrated = resolve(workbench.assets ?? workbench.source, "lib/business/inventory-fc");
      const state = stockState();
      state.mode = mode === "empty-error" ? "empty" : mode;
      const app = await profile(t, {
        beforeStart: prepareWorkbenchHtmlRoots([migrated]),
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
      const browser = await testBrowser(t, () =>
        chromium.launch({
          channel: "chrome",
          headless: true,
        }),
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
      const publishedContexts = [],
        contextRequests = [];
      let owner;
      page.on("request", (request) => {
        if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData()) return;
        const payload = request.postDataJSON();
        if (payload.operation === "context") {
          contextRequests.push(payload);
          if (payload.owner === owner) publishedContexts.push(payload.parameters);
        }
      });
      await page.goto(app.origin);
      const opened = page.waitForResponse((response) => {
        const request = response.request();
        if (!request.url().endsWith("/api/agent-workbench/page") || !request.postData())
          return false;
        const input = request.postDataJSON();
        return input.operation === "open" && input.pageId === "inventory-fc";
      });
      await openWorkbenchPage(page, "分仓库存");
      const reply = await opened;
      const pageReply = await reply.json();
      if (mode === "denied") {
        assert.equal(reply.status(), 400);
        assert.match(pageReply.error, /^AGENT_ACCESS_DENIED:/);
      } else {
        assert.equal(reply.status(), 200);
        owner = pageReply.owner;
        assert.match(owner, /^[0-9a-f-]{36}$/);
        publishedContexts.push(
          ...contextRequests
            .filter((request) => request.owner === owner)
            .map((request) => request.parameters),
        );
      }
      const frame = htmlFrameElement(page, "inventory-fc").contentFrame();
      try {
        if (mode === "denied") {
          const failure = page.getByRole("alert").filter({ hasText: "对话操作失败" });
          await expect(failure).toBeVisible({
            timeout: 15000,
          });
          await expect(failure).toHaveAttribute("title", pageReply.error);
          assert.equal(state.rest.length, 0);
          await expect(frame.getByText("FC001", { exact: true })).toHaveCount(0);
        } else if (mode === "error") {
          const failure = frame.getByRole("alert").filter({ hasText: "当前分仓数据尚未就绪" });
          await expect(failure).toBeVisible({
            timeout: 20000,
          });
          await expect(failure).toContainText(
            "数据读取失败，请刷新重试；若仍失败，请查看接口错误详情",
          );
          assert.ok(state.rest.length > 0, "the visible failure follows this profile's SQL read");
          await expect(frame.getByText("FC001", { exact: true })).toHaveCount(0);
          assert.equal(
            publishedContexts.some(
              (context) =>
                context?.parts?.data ||
                context?.parts?.inventoryInsight ||
                context?.parts?.branchDraft,
            ),
            false,
            "failed initial catalog read must not publish inventory facts",
          );
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
            await expect
              .poll(() => publishedContexts.at(-1)?.parts?.queryState?.state)
              .toBe("error");
            const errorParts = publishedContexts.at(-1).parts;
            assert.equal(errorParts.data, undefined);
            assert.equal(errorParts.inventoryInsight, undefined);
            assert.equal(errorParts.branchDraft, undefined);
            assert.equal(errorParts.queryState.warehouseId, "zhengzhou");
            assert.ok(errorParts.queryState.message);
            const failure = frame.getByRole("alert").filter({ hasText: "当前分仓数据尚未就绪" });
            await expect(failure).toBeVisible();
            await expect(failure).toContainText(errorParts.queryState.message);
            await expect(frame.getByText("FC001", { exact: true })).toHaveCount(0);
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

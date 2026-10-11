import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

test(
  "Dashboard shows current SKU totals while monthly baseline and categories retain their own basis",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        analysis: {
          mode: "model",
          source: "direct",
          baseUrl: base + "/v1",
          model: "fixture-model",
          apiKeyEnv: "GEA_V16_MODEL_KEY",
          contextWindow: 32768,
          maxTokens: 2048,
        },
      }),
      env: { GEA_V16_MODEL_KEY: "fixture-key" },
    });
    let modelCalls = 0;
    const plan = {
      planId: "p",
      versionId: "v",
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      orderType: "M",
      dealerCode: "d",
      dealerName: "客户A",
      orgCode: "org",
      orgName: "宝阳销售组",
      provinceCode: "province",
      provinceName: "华南省区",
      areaCode: "area",
      areaName: "华南大区",
      status: 1,
      currentQty: "20",
      currentAmount: "200",
      targetQty: "40",
      targetAmount: "400",
      skuCount: 1,
    };
    const sku = {
      id: "s",
      skuCode: "1001",
      versionId: "v",
      productCategName: "汤圆",
      materialDescription: "黑芝麻汤圆 500g",
      qty: "20",
      baseQty: "10",
      amt: "200",
      amtBase: "100",
      price: "10",
    };
    const otherSku = {
      ...sku,
      id: "s2",
      skuCode: "2001",
      productCategName: "面点",
      materialDescription: "面点测试 SKU",
      qty: "30",
      baseQty: "5",
      amt: "300",
      amtBase: "50",
    };
    let writes = 0;
    let allowApproval = false;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path === "/v1/chat/completions") {
        modelCalls++;
        const body = JSON.parse(req.body);
        const content = JSON.stringify(body.messages);
        const answer = content.includes("r0")
          ? JSON.stringify({ r0: "当前计划高于基准，请结合库存核对。" })
          : "当前计划为 20，月度目标为 40，完成 50%。请核对库存后审批。";
        res.setHeader("Content-Type", "text/event-stream");
        res.end(
          "data: " +
            JSON.stringify({
              id: "reply",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: { content: answer }, finish_reason: null }],
            }) +
            "\n\ndata: " +
            JSON.stringify({
              id: "reply",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n",
        );
        return true;
      }
      if (path.endsWith("/getPermCode")) {
        reply({ success: true, result: { codeList: ["sales-plan:plan:region-approve"] } });
        return true;
      }
      if (path.endsWith("/plans")) {
        const status = req.url.searchParams.get("status");
        const records = status === null || status === "1" ? [plan] : [];
        reply({
          success: true,
          result: {
            records,
            total: records.length,
            pages: 1,
            current: 1,
            size: Number(req.url.searchParams.get("pageSize") || 20),
          },
        });
        return true;
      }
      if (path.endsWith("/plans/p")) {
        reply({
          success: true,
          result: {
            currentVersion: { ...plan, id: "v", effective: true },
            skus: [sku],
            versions: [],
            logs: [],
            actionContext: {
              versionId: "v",
              status: 1,
              nodeOrder: 2,
              allowedActions: ["APPROVE", "REJECT"],
              snapshotHash: "a".repeat(64),
            },
          },
        });
        return true;
      }
      if (path.endsWith("/versions")) {
        reply({
          success: true,
          result: [
            { ...plan, id: "v", effective: true },
            { ...plan, id: "v0", seq: 0, effective: false, targetQty: null, targetAmount: null },
          ],
        });
        return true;
      }
      if (path.endsWith("/versions/v0/skus")) {
        reply({ success: true, result: [{ ...sku, versionId: "v0", qty: "10", amt: "100" }] });
        return true;
      }
      if (path.endsWith("/versions/v/skus")) {
        reply({ success: true, result: [sku, otherSku] });
        return true;
      }
      if (path.endsWith("/actions")) {
        assert.equal(allowApproval, true);
        const body = JSON.parse(req.body);
        assert.equal(body.action, "APPROVE");
        assert.deepEqual(body.adjustments, [{ skuCode: "1001", adjustQty: "2.125" }]);
        writes++;
        plan.status = 2;
        reply({
          success: true,
          result: {
            planId: "p",
            versionId: "v",
            fromStatus: 1,
            toStatus: 2,
            replayed: false,
            requestId: req.headers["x-request-id"],
            traceId: "trace",
            auditId: "audit",
          },
        });
        return true;
      }
    });
    await app.login();
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(app.origin);
    const frame = await openSalesPlan(page);
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await expect(frame.getByRole("button", { name: "保存调整", exact: true })).toHaveCount(0);
    await expect(frame.getByRole("button", { name: "重提", exact: true })).toHaveCount(0);
    // 月初/纠偏入口保留；当前明细汇总仍使用选中的月初范围。
    const header = frame.locator("header").first();
    await expect(header.getByRole("tab", { name: "月初", exact: true })).toBeVisible();
    assert.equal(modelCalls, 0, "opening the workbench must not trigger analysis");

    const totals = frame.getByRole("region", { name: "当前页明细汇总", exact: true });
    await expect(totals).toContainText("¥500");
    await expect(totals).toContainText("50 件");
    await expect(totals).not.toContainText("¥200");
    const monthPlan = frame.getByTestId("regional-approval-month-plan-p");
    await expect(monthPlan.locator("span").first()).toHaveText("¥150");
    // V1.8 #09：达成率改为「细进度条 + 百分比」，百分比前不再带「金额」。
    await expect(frame.locator("tbody").first()).toContainText("37.5%");
    await expect(frame.getByText(/数量 .*%/)).toHaveCount(0);
    await expect(frame.locator("thead")).not.toContainText("AI 核对意见");
    await frame.getByRole("switch").first().click();
    const category = frame.getByTestId("regional-approval-category-row-p-汤圆");
    await category.getByRole("button").click();
    await expect(frame.locator('tbody th[scope="rowgroup"]')).toHaveText("汤圆 · 1 SKU");
    await expect(frame.locator("tbody")).toContainText(["黑芝麻汤圆 500g"]);
    await expect(frame.getByText("面点测试 SKU", { exact: true })).toHaveCount(0);
    await expect(category.locator("xpath=ancestor::tr[1]")).toContainText("¥266.67");
    await expect(category.locator("xpath=ancestor::tr[1]")).toContainText("75.0%");
    await expect(frame.getByRole("textbox", { name: "确认计划量 1001", exact: true })).toHaveCount(
      0,
    );
    await mkdir(".runtime/detail-summary", { recursive: true });
    await page.screenshot({ path: ".runtime/detail-summary/desktop.png", fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: ".runtime/detail-summary/narrow.png", fullPage: true });
    await category.getByRole("button").click();
    await expect(frame.locator('tbody th[scope="rowgroup"]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
  },
);

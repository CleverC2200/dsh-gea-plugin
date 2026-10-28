import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { openReadySalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";

test(
  "Sales plan waits for its real Session owner and keeps detail interaction read-only across resize",
  { timeout: 90000 },
  async (t) => {
    const artifactDirectory = `.runtime/detail-summary/${process.pid}`;
    mkdirSync(artifactDirectory, { recursive: true });
    const started = performance.now();
    let phase = "profile",
      context,
      page,
      completed = false;
    const mark = (next) => {
      phase = next;
      const row = { testName: t.name, phase, elapsedMs: performance.now() - started };
      try {
        appendFileSync(artifactDirectory + "/phases.jsonl", JSON.stringify(row) + "\n");
      } catch (error) {
        t.diagnostic("DETAIL_SUMMARY_PHASE_WRITE_FAILED: " + String(error));
      }
      t.diagnostic(JSON.stringify(row));
    };
    t.after(async () => {
      mark(completed ? "completed" : "failed:" + phase);
      if (!context) return;
      if (!completed && page && !page.isClosed())
        await page
          .screenshot({ path: artifactDirectory + "/failure.png", timeout: 2000 })
          .catch((error) => t.diagnostic("DETAIL_SUMMARY_SCREENSHOT_FAILED: " + String(error)));
      await context.tracing
        .stop({ path: artifactDirectory + (completed ? "/trace.zip" : "/failure-trace.zip") })
        .catch((error) => t.diagnostic("DETAIL_SUMMARY_TRACE_FAILED: " + String(error)));
    });
    mark("browser-launch-start");
    const browserReady = testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );
    browserReady.catch(() => {});
    mark("profile");
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
      planId: "p-jxs-2026-09-00001",
      versionId: "v",
      seq: 1,
      periodId: "period-1",
      planTypeCode: "Y",
      orderType: "M",
      cust_code: 10070026,
      dealerName: "客户A",
      sales_group_code: "org",
      orgName: "宝阳销售组",
      province_region_code: "province",
      provinceName: "华南省区",
      region_code: "area",
      areaName: "华南大区",
      status: 1,
      currentQty: "20",
      currentAmount: "200",
      targetQty: "40",
      targetAmount: "400",
      amountProgress: "37.5",
      shipQty: "15",
      shipAmount: "150",
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
      if (path.endsWith("/plans/p-jxs-2026-09-00001")) {
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
            planId: "p-jxs-2026-09-00001",
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
    mark("login");
    await app.login();
    mark("browser-wait");
    const browser = await browserReady;
    mark("browser-ready");
    mark("browser-context");
    context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1536, height: 920 },
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await context.addCookies(
      app.cookie.split("; ").map((pair) => ({
        name: pair.slice(0, pair.indexOf("=")),
        value: pair.slice(pair.indexOf("=") + 1),
        url: app.origin,
      })),
    );
    page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    mark("page-navigation");
    await page.goto(app.origin);
    mark("sales-plan-open");
    const frame = await openReadySalesPlan(page);
    mark("sales-plan-owner-ready");
    mark("workbench-ready");
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    assert.equal(modelCalls, 0, "opening the workbench must not trigger analysis");

    mark("summary-assertions");
    const totals = frame.getByRole("region", { name: "当前页明细汇总", exact: true });
    await expect(totals).toContainText("¥500");
    mark("category-expand");
    await frame.getByRole("switch").first().click();
    const category = frame.getByTestId("regional-approval-category-row-p-jxs-2026-09-00001-汤圆");
    await category.getByRole("button").click();
    await expect(frame.locator('tbody th[scope="rowgroup"]')).toHaveText("汤圆 · 1 SKU");
    mark("narrow-resize");
    await page.setViewportSize({ width: 1024, height: 768 });
    mark("category-collapse");
    await category.getByRole("button").click();
    await expect(frame.locator('tbody th[scope="rowgroup"]')).toHaveCount(0);
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
    completed = true;
  },
);

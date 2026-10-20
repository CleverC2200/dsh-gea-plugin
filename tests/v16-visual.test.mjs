import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { profile } from "./profile.mjs";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";
import { openReadySalesPlan } from "./fixtures/business-page.mjs";

test(
  "V1.6 visual: compact header, stable progress, inline SKU, drawer and persistent private drafts",
  { timeout: 90000 },
  async (t) => {
    fixtureEnvironment(t, { GEA_V16_MODEL_KEY: "fixture-key" });
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
    let _modelCalls = 0;
    const plan = {
      planId: "p-jxs-2026-09-00001",
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
      mPlanQty: "20",
      mPlanAmount: "200",
      currentQty: "20",
      currentAmount: "200",
      targetQty: "40",
      targetAmount: "400",
      amountProgress: "25",
      shipQty: "10",
      shipAmount: "100",
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
    const unchangedSku = {
      ...sku,
      id: "unchanged",
      skuCode: "1002",
      productCategName: "饺子",
      materialDescription: "无调整测试物料",
      qty: "0",
      baseQty: "0",
      amt: "0",
      amtBase: "0",
    };
    let writes = 0;
    let allowApproval = false;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path === "/v1/chat/completions") {
        _modelCalls++;
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
            skus: [sku, unchangedSku],
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
        reply({ success: true, result: [sku, unchangedSku] });
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
    await page
      .getByRole("dialog", { name: /内测声明|预览版说明/, exact: true })
      .getByRole("button", { name: "继续", exact: true })
      .click();
    await mkdir(".runtime/v16-visual", { recursive: true });
    await mkdir(".runtime/v16-feedback", { recursive: true });
    const shot = async (name) => {
      await page.waitForTimeout(400);
      await page.screenshot({
        path: ".runtime/v16-visual/" + name + ".png",
        fullPage: true,
        animations: "disabled",
      });
    };
    const frame = await openReadySalesPlan(page);
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await expect(frame.getByText("待我审批 1 条", { exact: true })).toHaveCount(0);
    await expect(frame.getByText("审批核对队列", { exact: true })).toHaveCount(0);
    const overview = frame.getByRole("region", { name: "当前页明细汇总" });
    await expect(overview).toContainText("目标金额");
    await expect(overview).toContainText("¥400");
    await expect(overview).toContainText("计划金额");
    await expect(overview).toContainText("¥200");
    await expect(overview).toContainText("差额（计划 − 目标）");
    await expect(overview).toContainText("−¥200");
    await expect(overview).toContainText("计划数量");
    await expect(overview).toContainText("20 件");
    await expect(frame.getByRole("button", { name: "保存调整", exact: true })).toHaveCount(0);
    await expect(frame.getByRole("button", { name: "重提", exact: true })).toHaveCount(0);
    const header = frame.locator("header").first();
    await expect(header.getByRole("tab", { name: "月初", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "建议生成失败", exact: true })).toHaveCount(0);
    await shot("01-02-09-initial");
    const compactHeader = frame
      .getByTestId("regional-approval-workbench")
      .locator("header")
      .first();
    const headerLayout = await compactHeader.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      wrap: getComputedStyle(el).flexWrap,
    }));
    assert.equal(headerLayout.wrap, "nowrap");
    assert.ok(headerLayout.height <= 76, JSON.stringify(headerLayout));
    const readProgress = () =>
      frame.locator('[data-testid^="regional-approval-stage-"] small').allTextContents();
    const before = await readProgress();
    assert.equal(before.length, 5);
    if (!(await frame.getByTestId("regional-approval-flow-lane").isVisible()))
      await frame.getByTestId("regional-approval-flow-toggle").click();
    for (const stage of ["province", "area", "category"])
      await expect(frame.getByTestId("regional-approval-stage-" + stage)).toBeDisabled();
    await frame.getByTestId("regional-approval-stage-region").click();
    assert.deepEqual(await readProgress(), before);
    await frame.getByTestId("regional-approval-stage-region").click();
    await frame.getByRole("tab", { name: "按区域", exact: true }).click();
    const monthPlan = frame.getByTestId("regional-approval-month-plan-p-jxs-2026-09-00001");
    await expect(monthPlan.locator("span").first(), "月计划采用列表 mPlanAmount").toHaveText(
      "¥200",
    );
    await expect(
      monthPlan.locator("small").first(),
      "月计划采用列表 mPlanQty 并显示单位",
    ).toHaveText("20 件");
    await expect(frame.locator("tbody").first()).toContainText("25.0%");
    await expect(frame.locator("tbody").first()).not.toContainText("版本②：¥100 / 10");
    await expect(frame.locator("tbody").first()).not.toContainText("该版本不含月度目标");
    await shot("03-version-comparison");
    await frame.getByRole("button", { name: /查看.*宝阳销售组|宝阳销售组.*调整/ }).click();
    await expect(frame.locator("tbody").first()).toContainText("黑芝麻汤圆 500g");
    await expect(frame.locator('tbody th[scope="rowgroup"]')).toContainText([
      "汤圆 · 1 SKU",
      "饺子 · 1 SKU",
    ]);
    const inline = frame.locator('div[role="region"][tabindex="0"]');
    const skuRow = inline.getByRole("row").filter({ hasText: "黑芝麻汤圆 500g" });
    await expect(skuRow.locator("td").nth(1)).toHaveText("10");
    await expect(skuRow.locator("td").nth(3)).toHaveText("100");
    assert.ok(await inline.evaluate((el) => getComputedStyle(el).maxHeight === "360px"));
    const nav = page.locator(".gea-shell-navigation");
    for (const width of ["64px", "240px", "64px", "240px"]) {
      await nav.evaluate((el, w) => {
        el.style.width = w;
      }, width);
      await expect(nav.locator(".gea-shell-label").first())[
        width === "64px" ? "toBeHidden" : "toBeVisible"
      ]();
    }
    await nav.evaluate((el) => el.style.removeProperty("width"));
    await page.screenshot({ path: ".runtime/v16-feedback/inline-grouped.png", fullPage: true });
    await shot("08-inline");
    await expect(frame.getByRole("button", { name: "查看调整明细", exact: true })).toHaveCount(0);
    await expect(frame.locator(".arco-drawer")).toHaveCount(0);
    const editor = frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true });
    await expect(editor).toHaveValue("20");
    await editor.fill("22.125");
    await expect(frame.locator("td").getByRole("status")).toContainText("正在暂存", {
      timeout: 10000,
    });
    await expect(frame.locator("td").getByRole("status")).toHaveCount(0, { timeout: 10000 });
    await shot("06-autosaved");
    assert.equal(writes, 0);
    const result = await app.rpc("sales-plan/draft", {
      planId: "p-jxs-2026-09-00001",
      versionId: "v",
    });
    assert.equal(result.value.draft.adjustments[0].adjustQty, "2.125");
    const forged = await app.rpc("sales-plan/draft", {
      planId: "p-jxs-2026-09-00001",
      versionId: "v",
      draft: { ...result.value.draft, sourceSnapshot: "f".repeat(64) },
    });
    assert.equal(forged.ok, false, "草稿必须绑定当前版本快照，伪造快照不能保存");
    assert.equal(forged.error.code, "STALE_DRAFT");
    const unchanged = await app.rpc("sales-plan/draft", {
      planId: "p-jxs-2026-09-00001",
      versionId: "v",
    });
    assert.equal(unchanged.value.draft.adjustments[0].adjustQty, "2.125");
    await mkdir(".runtime/v16-feedback", { recursive: true });
    await page.screenshot({ path: ".runtime/v16-feedback/web-desktop.png", fullPage: true });
    await page.reload();
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await frame.getByRole("button", { name: /查看.*宝阳销售组|宝阳销售组.*调整/ }).click();
    await expect(frame.getByRole("button", { name: "查看调整明细", exact: true })).toHaveCount(0);
    await expect(
      frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true }),
    ).toHaveValue("22.125");
    await shot("06-restored");
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: ".runtime/v16-feedback/web-tablet.png", fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
    await page.setViewportSize({ width: 1536, height: 920 });
    await shot("10-expanded");
    await page.getByRole("button", { name: /收起侧边栏|Collapse sidebar/ }).click();
    await shot("10-sidebar-collapsed");
    await expect(page.locator(".gea-shell-navigation .gea-shell-label").first()).toBeHidden();
    // The current owned collapsed brand exposes the public menu expansion action.
    const collapsedMenu = page.getByTitle("展开业务菜单", { exact: true });
    await expect(collapsedMenu).toBeVisible();
    const railWidth = await page
      .locator(".gea-sidebar-rail")
      .evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(railWidth > 0 && railWidth <= 60, "收起后保持窄图标栏");
    await collapsedMenu.click();
    await expect(page.getByRole("button", { name: /收起侧边栏|Collapse sidebar/ })).toBeVisible();
    await expect(page.locator(".gea-shell-navigation [data-nav-icon]")).toHaveCount(0);
    await shot("10-sidebar-restored");
    await expect(page.getByRole("button", { name: "全屏展示", exact: true })).toHaveCount(0);
    await frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"])').click();
    allowApproval = true;
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await expect(frame.getByRole("dialog")).toHaveCount(0);
    await shot("01-approval-completed");
    plan.status = 1;
    let automaticPrepareRequests = 0;
    await page.route("**/api/gea-proof/workbench/prepare", (route) => {
      automaticPrepareRequests++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "GEA_UNAVAILABLE", message: "Unavailable" },
        }),
      });
    });
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await page.waitForTimeout(1200);
    assert.equal(automaticPrepareRequests, 0);
    await expect(page.getByRole("dialog", { name: "建议生成失败", exact: true })).toHaveCount(0);
    await shot("09-no-auto-analysis");
    await page.unroute("**/api/gea-proof/workbench/prepare");
    await page.route("**/api/gea-proof/workbench/query", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: { code: "FORBIDDEN", message: "Forbidden" } }),
      }),
    );
    await frame.getByRole("button", { name: "刷新数据", exact: true }).click();
    await expect(
      frame.getByText("当前账号没有读取该销售计划范围的权限。", { exact: true }),
    ).toBeVisible();
    await shot("05-permission-denied");
  },
);

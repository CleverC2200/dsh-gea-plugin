import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";
import { mkdir } from "node:fs/promises";
import { modelProfile as profile } from "./fixtures/model-profile.mjs";

test(
  "V1.6 Web: compact header, stable progress, inline SKU and approval editing",
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
        reply({ success: true, result: [sku] });
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
    const browser = await testBrowser(t, () =>
      chromium.launch({ channel: "chrome", headless: true }),
    );
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
    // 月初/纠偏切换入口恢复。
    const header = frame.locator("header").first();
    await expect(header.getByRole("tab", { name: "月初", exact: true })).toBeVisible();
    assert.equal(modelCalls, 0, "opening the workbench must not trigger analysis");
    const readProgress = () =>
      frame.locator('[data-testid^="regional-approval-stage-"] small').allTextContents();
    // 节点条始终展示全部五个节点，进度按状态统计，跟当前选中的节点无关。
    await expect
      .poll(readProgress)
      .toEqual(["进度 100%", "进度 0%", "进度 0%", "进度 0%", "进度 0%"]);
    const before = await readProgress();
    assert.equal(before.length, 5);
    // V1.8 #05：流程图默认收起，点标题行右侧的入口展开后才能点各节点。
    if (!(await frame.getByTestId("regional-approval-flow-lane").isVisible()))
      await frame.getByTestId("regional-approval-flow-toggle").click();
    // 角色决定能进哪个节点：没权限的节点置灰不可点。
    for (const stage of ["province", "area", "category"])
      await expect(frame.getByTestId("regional-approval-stage-" + stage)).toBeDisabled();
    // 再点当前节点回「全部节点」，再点一次回本节点；来回切换不重置进度条。
    await frame.getByTestId("regional-approval-stage-region").click();
    assert.deepEqual(await readProgress(), before);
    await frame.getByTestId("regional-approval-stage-region").click();
    assert.deepEqual(await readProgress(), before);
    await frame.getByRole("tab", { name: "按区域", exact: true }).click();
    await expect(frame.getByTestId("regional-approval-status-p")).toHaveText("销售已提报");
    await expect(
      frame.getByTestId("regional-approval-status-p").locator("xpath=ancestor::td[1]"),
    ).toContainText("宝阳销售组");
    await expect(
      frame.getByTestId("regional-approval-status-p").locator("xpath=ancestor::table[1]/thead"),
    ).not.toContainText("审批状态");
    const monthPlan = frame.getByTestId("regional-approval-month-plan-p");
    await expect(monthPlan.locator("span").first()).toHaveText("¥100");
    // 数量带单位：月计划列的数量显示成「10 件」。
    await expect(monthPlan.locator("small").first()).toHaveText("10 件");
    await expect(frame.locator("tbody").first()).toContainText("25.0%");
    await expect(frame.locator("tbody").first()).not.toContainText("版本②：¥100 / 10");
    await expect(frame.locator("tbody").first()).not.toContainText("该版本不含月度目标");
    await frame.getByRole("button", { name: /查看.*宝阳销售组|宝阳销售组.*调整/ }).click();
    await expect(frame.locator("tbody").first()).toContainText("黑芝麻汤圆 500g");
    await expect(frame.locator('tbody th[scope="rowgroup"]')).toContainText("汤圆 · 1 SKU");
    const inline = frame.locator('div[role="region"][tabindex="0"]');
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
    await expect(frame.getByRole("button", { name: "查看调整明细", exact: true })).toHaveCount(0);
    await expect(frame.locator(".arco-drawer")).toHaveCount(0);
    const editor = frame.getByRole("spinbutton", { name: "确认计划量 1001", exact: true });
    await expect(editor).toHaveValue("20");
    await editor.fill("22.125");
    // 明细汇总里的数量；月计划列现在也会显示同一个「22.125 件」，所以要限定在汇总卡里找。
    await expect(
      frame.getByLabel("当前页明细汇总").getByText("22.125 件", { exact: true }),
    ).toBeVisible();
    await expect(
      frame.getByLabel("当前页明细汇总").getByText("¥221.25", { exact: true }),
    ).toBeVisible();
    await expect(frame.getByTestId("regional-approval-month-plan-p")).toContainText("22.125");
    await expect(frame.getByTestId("regional-approval-month-plan-p")).toContainText("¥221.25");
    await expect(frame.getByRole("status").filter({ hasText: "正在暂存" })).toContainText(
      "正在暂存",
      { timeout: 10000 },
    );
    await expect(frame.getByRole("status").filter({ hasText: "正在暂存" })).toHaveCount(0, {
      timeout: 10000,
    });
    assert.equal(writes, 0);
    const result = await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" });
    assert.equal(result.value.draft.adjustments[0].adjustQty, "2.125");
    const forged = await app.rpc("sales-plan/draft", {
      planId: "p",
      versionId: "v",
      draft: { ...result.value.draft, sourceSnapshot: "forged" },
    });
    assert.equal(forged.ok, false, "伪造的草稿快照必须被拒绝，不能覆盖已验证草稿");
    const unchanged = await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" });
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
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.screenshot({ path: ".runtime/v16-feedback/web-tablet.png", fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
    await page.setViewportSize({ width: 1536, height: 920 });
    await frame.locator('label.arco-checkbox:has(input[value="p"])').click();
    allowApproval = true;
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await expect(frame.getByRole("dialog")).toHaveCount(0);
    assert.deepEqual(errors, []);
  },
);

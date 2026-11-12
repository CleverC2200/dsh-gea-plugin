import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

test(
  "action failure dialog shows business copy without response identifiers",
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
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
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      if (path.endsWith("/plans")) {
        const status = req.url.searchParams.get("status");
        const records = status === null || status === "1" ? [plan] : [];
        return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
      }
      if (path.endsWith("/plans/p-jxs-2026-09-00001"))
        return send({
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
        });
      if (path.endsWith("/versions")) return send([{ ...plan, id: "v", effective: true }]);
      if (path.endsWith("/versions/v/skus")) return send([sku]);
      if (path.endsWith("/versions/v/actions")) {
        // 服务端原始报错：带错误码 + 字段名，绝不能出现在界面上。
        reply(
          {
            message: "payload.plan_month 为必填字段",
            errorCode: "NOTIFICATION_PAYLOAD_INVALID",
            code: 409,
            requestId: "req",
          },
          409,
        );
        return true;
      }
      return false;
    });
    await app.login();
    const browser = await chromium.launch({ channel: "chrome", headless: true });
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
    page.setDefaultTimeout(15000);
    const warned = [];
    page.on("console", (message) => {
      if (message.type() === "warning" || message.type() === "warn") warned.push(message.text());
    });
    await page.goto(app.origin);
    const frame = await openSalesPlan(page);
    await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
    await expect(frame.getByRole("combobox", { name: "销售计划周期", exact: true })).toContainText(
      "2026年9月",
    );
    await frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"])').click();
    await expect(
      frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"]) input'),
    ).toBeChecked();
    await expect(frame.getByRole("button", { name: "退回", exact: true })).toBeEnabled();
    // 退回弹窗不会在失败时自动关闭，正好用来核对失败提示文案。
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const dialog = frame.getByRole("dialog");
    await expect(dialog.getByLabel("退回原因（必填）", { exact: true })).toBeVisible();
    await dialog.getByLabel("退回原因（必填）", { exact: true }).fill("测试退回原因");
    await dialog.getByRole("button", { name: "确认退回", exact: true }).click();
    // 上游 409 带着原因码时，不能统一说成"并发冲突、请刷新"——这条是服务端通知载荷被拒，
    await expect(
      dialog.getByText("审批通知未能发送，请联系管理员核对通知配置。", {
        exact: false,
      }),
    ).toBeVisible({ timeout: 20000 });
    const dialogText = await dialog.innerText();
    assert.ok(!dialogText.includes("并发"), `服务端业务拒绝不应被描述成并发冲突：${dialogText}`);
    for (const leak of [
      "payload",
      "plan_month",
      "GEA_HTTP",
      "NOTIFICATION_PAYLOAD_INVALID",
      "必填字段",
    ]) {
      assert.ok(!dialogText.includes(leak), `界面上不应出现「${leak}」，实际：${dialogText}`);
    }
    assert.ok(!dialogText.includes("错误编号"), dialogText);
    assert.ok(warned.some((line) => line.includes("req") && line.includes("plan_month")));

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // 退回请求失败后这一笔没被受理，勾选已经清掉；再点「通过」要重新勾一次。
    await expect(
      frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"]) input'),
    ).not.toBeChecked();
    await frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"])').click();
    await frame.getByRole("button", { name: "通过", exact: true }).click();
    const resultDialog = frame.getByRole("dialog", { name: "处理结果", exact: true });
    await expect(resultDialog).toBeVisible({ timeout: 20000 });
    await expect(resultDialog).toContainText("审批通知未能发送");
    await expect(resultDialog.getByRole("spinbutton")).toHaveCount(0);
    await expect(
      frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"]) input'),
    ).not.toBeChecked();
    const resultText = await resultDialog.innerText();
    for (const leak of [
      "payload",
      "plan_month",
      "GEA_HTTP",
      "NOTIFICATION_PAYLOAD_INVALID",
      "错误编号",
    ])
      assert.ok(!resultText.includes(leak), resultText);
  },
);

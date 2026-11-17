import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

const fixture = async (t, { rejectFails }) => {
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
    regionConfirmedQty: "20",
    amt: "200",
    amtBase: "100",
    price: "10",
  };
  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    if (path.endsWith("/getPermCode")) return send({ codeList: [] });
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
          snapshotHash: "a".repeat(64),
          policy: "role-visible-v1",
          allowedActions: ["SAVE", "APPROVE", "REJECT"],
          roleActions: [{ role: "region", allowedActions: ["SAVE", "APPROVE", "REJECT"] }],
        },
      });
    if (path.endsWith("/versions")) return send([{ ...plan, id: "v", effective: true }]);
    if (path.endsWith("/versions/v/skus")) return send([sku]);
    if (path.endsWith("/versions/v/actions")) {
      writes.push(JSON.parse(req.body));
      if (rejectFails) {
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
      return send({
        planId: "p-jxs-2026-09-00001",
        versionId: "v",
        fromStatus: 1,
        toStatus: 6,
        approvalRole: "region",
        requestId: req.headers["x-request-id"],
        traceId: "t",
        auditId: "a",
        replayed: false,
      });
    }
    return false;
  });
  await app.login();

  const source = (
    await app.rpc("sales-plan/draft", { planId: "p-jxs-2026-09-00001", versionId: "v" })
  ).value;
  const saved = await app.rpc("sales-plan/draft", {
    planId: "p-jxs-2026-09-00001",
    versionId: "v",
    approvalRole: "region",
    draft: {
      planId: "p-jxs-2026-09-00001",
      versionId: "v",
      status: 1,
      sourceSnapshot: source.sourceSnapshot,
      remark: "",
      adjustments: [{ skuCode: "1001", adjustQty: "2" }],
      role: "region",
    },
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));

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
  await page.goto(app.origin);
  const frame = await openSalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();

  const openReject = async () => {
    const box = frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"]) input');
    if (!(await box.isChecked()))
      await frame.locator('label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"])').click();
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const remark = frame.getByLabel("退回原因（必填）", { exact: true });
    await expect(remark).toBeVisible();
    return remark;
  };
  const closeThroughDiscardConfirm = async (remark) => {
    await frame.getByRole("button", { name: "取消", exact: true }).click();

    const discard = frame.getByRole("button", { name: "放弃调整", exact: true });
    await expect(discard).toBeVisible({ timeout: 10000 });
    await discard.click();
    await expect(remark).toHaveCount(0);
  };
  return { frame, writes, openReject, closeThroughDiscardConfirm };
};

test(
  "reject dialog closes through the discard confirmation when unsaved adjustments exist",
  { timeout: 90000 },
  async (t) => {
    const { frame, writes, openReject, closeThroughDiscardConfirm } = await fixture(t, {
      rejectFails: false,
    });
    const remark = await openReject();
    await closeThroughDiscardConfirm(remark);

    assert.deepEqual(writes, []);

    const again = await openReject();
    await frame.getByRole("button", { name: "取消", exact: true }).click();
    const keepEditing = frame.getByRole("button", { name: "继续编辑", exact: true });
    await expect(keepEditing).toBeVisible({ timeout: 10000 });
    await keepEditing.click();
    await expect(again).toBeVisible();
    await expect(frame.getByRole("button", { name: "放弃调整", exact: true })).toHaveCount(0);
  },
);

test(
  "reject dialog still closes after the request failed with a conflict",
  { timeout: 90000 },
  async (t) => {
    const { frame, writes, openReject } = await fixture(t, {
      rejectFails: true,
    });
    const remark = await openReject();
    await remark.fill("测试退回原因");
    await frame.getByRole("button", { name: "确认退回", exact: true }).click();

    await expect(frame.getByRole("dialog", { name: "处理结果", exact: true })).toContainText(
      "审批通知未能发送",
      { timeout: 20000 },
    );
    await expect(frame.getByText(/错误编号/)).toHaveCount(0);
    assert.equal(writes.length, 1);
    const result = frame.getByRole("dialog", { name: "处理结果", exact: true });
    await expect(result.getByRole("spinbutton")).toHaveCount(0);
    await result.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(remark).toHaveCount(0);

    await expect(
      frame.locator('tbody label.arco-checkbox:has(input[value="p-jxs-2026-09-00001"]) input'),
    ).not.toBeChecked();
  },
);

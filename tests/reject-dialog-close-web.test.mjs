import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

/**
 * 退回弹窗关不掉：只要本单据有「未提交的 SKU 调整」，关闭动作会先走
 * 「放弃未提交的调整？」二次确认。那个确认框以前只挂在通过/保存分支上，
 * 退回分支点了 X / 取消只会把状态设成"要确认"，界面上什么都不出现——
 * 用户看到的就是"报错了就关不掉"。
 *
 * 这里预置一份未提交调整，把「取消关闭」和「确认退回失败后再取消关闭」
 * 两条路径都钉住：必须出现确认框，点「放弃调整」后弹窗真的消失。
 */
const fixture = async (t, { rejectFails }) => {
  const app = await profile(t);
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
    if (path.endsWith("/plans/p"))
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
        planId: "p",
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
  // 真实场景里用户先在表里改过数量；这里直接把同一份草稿存进 Host。
  const source = (await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" })).value;
  const saved = await app.rpc("sales-plan/draft", {
    planId: "p",
    versionId: "v",
    approvalRole: "region",
    draft: {
      planId: "p",
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
    app.cookie
      .split("; ")
      .map((pair) => ({
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
    // 关闭弹窗不会自动取消勾选，第二次打开前先确认这一行是选中的。
    const box = frame.locator('label.arco-checkbox:has(input[value="p"]) input');
    if (!(await box.isChecked()))
      await frame.locator('label.arco-checkbox:has(input[value="p"])').click();
    await frame.getByRole("button", { name: "退回", exact: true }).click();
    const remark = frame.getByLabel("退回原因（必填）", { exact: true });
    await expect(remark).toBeVisible();
    return remark;
  };
  const closeThroughDiscardConfirm = async (remark) => {
    await frame.getByRole("button", { name: "取消", exact: true }).click();
    // 修复前这里永远等不到：确认框没被渲染，弹窗看起来像卡死。
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
    // 只是关闭，不该发出任何审批写请求。
    assert.deepEqual(writes, []);
    // 继续编辑：确认框关掉，退回弹窗还在。
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
    const { frame, writes, openReject, closeThroughDiscardConfirm } = await fixture(t, {
      rejectFails: true,
    });
    const remark = await openReject();
    await remark.fill("测试退回原因");
    await frame.getByRole("button", { name: "确认退回", exact: true }).click();
    // 失败提示按上游原因码给说法（这里是通知载荷被拒），不再统一说"并发、请刷新"；
    // 这条用例只关心"失败之后弹窗还关不关得掉"，所以只等失败提示出来。
    await expect(frame.getByText(/错误编号：[A-Z0-9]{6}/)).toBeVisible({ timeout: 20000 });
    assert.equal(writes.length, 1);
    await closeThroughDiscardConfirm(remark);
    // 报错后这一批没被受理，勾选不能留在界面上（否则用户看到"还选中着"容易再点一次）。
    await expect(
      frame.locator('tbody label.arco-checkbox:has(input[value="p"]) input'),
    ).not.toBeChecked();
  },
);

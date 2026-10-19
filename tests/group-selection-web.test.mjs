import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";
import { testBrowser } from "./fixtures/test-browser.mjs";

const plans = [
  {
    planId: "p1",
    versionId: "v1",
    seq: 1,
    periodId: "period-1",
    planTypeCode: "Y",
    orderType: "M",
    dealerCode: "d1",
    dealerName: "客户1",
    orgCode: "org-a",
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
  },
  {
    planId: "p2",
    versionId: "v2",
    seq: 1,
    periodId: "period-1",
    planTypeCode: "Y",
    orderType: "M",
    dealerCode: "d2",
    dealerName: "客户2",
    orgCode: "org-a",
    orgName: "宝阳销售组",
    provinceCode: "province",
    provinceName: "华南省区",
    areaCode: "area",
    areaName: "华南大区",
    status: 1,
    currentQty: "30",
    currentAmount: "300",
    targetQty: "40",
    targetAmount: "400",
    skuCount: 1,
  },
  {
    planId: "p3",
    versionId: "v3",
    seq: 1,
    periodId: "period-1",
    planTypeCode: "Y",
    orderType: "M",
    dealerCode: "d3",
    dealerName: "客户3",
    orgCode: "org-b",
    orgName: "烟台经销组",
    provinceCode: "province",
    provinceName: "华南省区",
    areaCode: "area",
    areaName: "华南大区",
    status: 1,
    currentQty: "10",
    currentAmount: "100",
    targetQty: "40",
    targetAmount: "400",
    skuCount: 1,
  },
];
const skuFor = (versionId) => ({
  id: "s-" + versionId,
  skuCode: "1001",
  versionId,
  productCategName: "汤圆",
  qty: "20",
  baseQty: "10",
  amt: "200",
  amtBase: "100",
  price: "10",
});
/** 回执必须带真实身份：客户端会按 planId/versionId/状态链逐项核对，拼接错就会被判成“结果未知”。 */
const planIdForVersion = (versionId) => "p" + versionId.slice(1);

const openWorkbench = async (t) => {
  const app = await profile(t);
  const writes = [];
  const statuses = new Map();
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
      const records = status === null || status === "1" ? plans : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    const detail = /\/plans\/(p\d)$/.exec(path);
    if (detail) {
      const plan = plans.find((row) => row.planId === detail[1]);
      return send({
        currentVersion: {
          ...plan,
          id: plan.versionId,
          status: statuses.get(plan.versionId) ?? plan.status,
          effective: true,
        },
        skus: [skuFor(plan.versionId)],
        versions: [],
        logs: [],
        actionContext: {
          versionId: plan.versionId,
          status: statuses.get(plan.versionId) ?? 1,
          nodeOrder: 2,
          allowedActions: ["APPROVE", "REJECT"],
          snapshotHash: "a".repeat(64),
        },
      });
    }
    const versions = /\/plans\/(p\d)\/versions$/.exec(path);
    if (versions) {
      const plan = plans.find((row) => row.planId === versions[1]);
      return send([{ ...plan, id: plan.versionId, effective: true }]);
    }
    const skus = /\/plans\/versions\/(v\d)\/skus$/.exec(path);
    if (skus) return send([skuFor(skus[1])]);
    const action = /\/versions\/(v\d)\/actions$/.exec(path);
    if (action) {
      const body = JSON.parse(req.body);
      writes.push(body);
      // 通过走到下一节点（1→2）；退回回到上一个节点对应的退回码（1→6）。
      const toStatus = body.action === "REJECT" ? 6 : 2;
      statuses.set(action[1], toStatus);
      return send({
        planId: planIdForVersion(action[1]),
        versionId: action[1],
        fromStatus: 1,
        toStatus,
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
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  const frame = await openSalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  const groupBox = frame.locator('tbody label.arco-checkbox:has(input[value*="group:"])').first();
  await expect(groupBox).toBeVisible();
  return { frame, groupBox, writes };
};

test("多选批量通过：勾选 3 笔一次性逐笔提交", { timeout: 90000 }, async (t) => {
  const { frame, groupBox, writes } = await openWorkbench(t);
  const single = frame.locator('tbody label.arco-checkbox:has(input[value="p3"])').first();
  await expect(single).toBeVisible();
  await single.click();
  await groupBox.click();
  await expect(frame.getByRole("button", { name: "通过", exact: true })).toBeEnabled();

  await frame.getByRole("button", { name: "通过", exact: true }).click();
  const dialog = frame.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("提交所选计划（3）");
  await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click();

  await expect(dialog).toContainText("成功 3 笔");
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((body) => body.action).sort(), ["APPROVE", "APPROVE", "APPROVE"]);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(single.locator("input")).not.toBeChecked();
});

test("批量里一笔冲突不影响其它笔，结果逐笔说明原因", { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const writes = [];
  const statuses = new Map();
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
      const records = status === null || status === "1" ? plans : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    const detail = /\/plans\/(p\d)$/.exec(path);
    if (detail) {
      const plan = plans.find((row) => row.planId === detail[1]);
      return send({
        currentVersion: {
          ...plan,
          id: plan.versionId,
          status: statuses.get(plan.versionId) ?? plan.status,
          effective: true,
        },
        skus: [skuFor(plan.versionId)],
        versions: [],
        logs: [],
        actionContext: {
          versionId: plan.versionId,
          status: statuses.get(plan.versionId) ?? 1,
          nodeOrder: 2,
          allowedActions: ["APPROVE", "REJECT"],
          snapshotHash: "a".repeat(64),
        },
      });
    }
    const versions = /\/plans\/(p\d)\/versions$/.exec(path);
    if (versions) {
      const plan = plans.find((row) => row.planId === versions[1]);
      return send([{ ...plan, id: plan.versionId, effective: true }]);
    }
    const skus = /\/plans\/versions\/(v\d)\/skus$/.exec(path);
    if (skus) return send([skuFor(skus[1])]);
    const action = /\/versions\/(v\d)\/actions$/.exec(path);
    if (action) {
      writes.push({ versionId: action[1], body: JSON.parse(req.body) });
      // 第二笔已经被别人推到下一节点：并发冲突。
      if (action[1] === "v2") {
        reply({ message: "状态已变化", errorCode: "SALES_PLAN_CONFLICT", requestId: "r" }, 409);
        return true;
      }
      statuses.set(action[1], 2);
      return send({
        planId: planIdForVersion(action[1]),
        versionId: action[1],
        fromStatus: 1,
        toStatus: 2,
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
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  const frame = await openSalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  const groupBox = frame.locator('tbody label.arco-checkbox:has(input[value*="group:"])').first();
  await expect(groupBox).toBeVisible();
  await groupBox.click();
  await frame.getByRole("button", { name: "通过", exact: true }).click();

  const dialog = frame.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click();

  const result = dialog;
  await expect(result).toContainText("成功 1 笔");
  await expect(result).toContainText("失败 1 笔");
  // 失败的那笔要能看出是哪一个，并且不能只给技术错误码。
  await expect(result).toContainText("宝阳销售组");
  const text = await result.innerText();
  for (const leak of ["GEA_HTTP", "payload", "SALES_PLAN_CONFLICT"])
    assert.equal(text.includes(leak), false, leak);
  assert.equal(writes.length, 2);
});

test("多选批量退回：共用一个退回原因，逐笔带上", { timeout: 90000 }, async (t) => {
  const { frame, groupBox, writes } = await openWorkbench(t);
  await groupBox.click();
  const reject = frame.getByRole("button", { name: "退回", exact: true });
  await expect(reject).toBeEnabled();
  await reject.click();

  const dialog = frame.getByTestId("regional-approval-batch-action-dialog");
  await expect(dialog).toBeVisible();
  const confirm = frame.getByRole("button", { name: "确认批量退回", exact: true });
  // 退回原因必填。
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("批量审批备注").fill("促销依据待补充");
  await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(frame.getByTestId("regional-approval-batch-result")).toContainText("成功 2 笔");
  assert.equal(writes.length, 2);
  for (const body of writes) {
    assert.equal(body.action, "REJECT");
    assert.equal(body.remark, "促销依据待补充");
  }
});

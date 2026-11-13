import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

const plan = (id, province_region_code) => ({
  planId: id,
  versionId: "v" + id.slice(-1),
  seq: 1,
  periodId: "period-1",
  planTypeCode: "Y",
  orderType: "M",
  cust_code: 10070026 + Number(id.slice(-1)),
  dealerName: "客户" + id.slice(-1),
  belong_base: "base-" + id.slice(-1),
  region_code: "area-" + id.slice(-1),
  areaName: "大区" + id.slice(-1),
  sales_group_code: "org-" + id.slice(-1),
  orgName: "组织" + id.slice(-1),
  province_region_code,
  provinceName: "省区" + province_region_code,
  status: 1,
  currentQty: "20",
  currentAmount: "200",
  targetQty: "40",
  targetAmount: "400",
  skuCount: 1,
});
const SUCCESS_PROVINCES = ["0013"];
const plans = [
  plan("p-jxs-2026-09-00001", "0013"),
  plan("p-jxs-2026-09-00002", "0013"),
  plan("p-jxs-2026-09-00003", "0055"),
  plan("p-jxs-2026-09-00004", "0034"),
  plan("p-jxs-2026-09-00005", "0041"),
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

const UPSTREAM_NOTIFICATION_PAYLOAD_INVALID = {
  success: false,
  message: "payload.plan_month 为必填字段",
  code: 409,
  result: null,
  errorCode: "NOTIFICATION_PAYLOAD_INVALID",
  category: "CONFLICT",
  retryable: false,
};

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
    if (path.endsWith("/getPermCode")) return send({ codeList: [] });
    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      const records = status === null || status === "1" ? plans : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }

    const notifications = plans.map((row) => ({
      id: "n-" + row.planId,
      approval: {
        bizKey: `sales-plan:version:${row.versionId}`,
        instanceId: "i-" + row.planId,
        actionable: true,
      },
    }));
    const notification = /\/notifications\/(n-p-jxs-2026-09-\d{5})$/.exec(path);
    if (notification) {
      const item = notifications.find((row) => row.id === notification[1]);
      return send(item);
    }
    if (path.endsWith("/notifications"))
      return send({ items: notifications, total: notifications.length });
    const detail = /\/plans\/(p-jxs-2026-09-\d{5})$/.exec(path);
    if (detail) {
      const row = plans.find((item) => item.planId === detail[1]);
      return send({
        currentVersion: {
          ...row,
          id: row.versionId,
          status: statuses.get(row.versionId) ?? row.status,
          effective: true,
        },
        skus: [skuFor(row.versionId)],
        versions: [],
        logs: [],

        workflowApproval: {
          versionId: row.versionId,
          notificationId: "n-" + row.planId,
          instanceId: "i-" + row.planId,
          actionable: true,
        },
      });
    }
    const versions = /\/plans\/(p-jxs-2026-09-\d{5})\/versions$/.exec(path);
    if (versions) {
      const row = plans.find((item) => item.planId === versions[1]);
      return send([{ ...row, id: row.versionId, effective: true }]);
    }
    const skus = /\/plans\/versions\/(v\d)\/skus$/.exec(path);
    if (skus) return send([skuFor(skus[1])]);
    const action = /\/versions\/(v\d)\/actions$/.exec(path);
    if (action) {
      const row = plans.find((item) => item.versionId === action[1]);
      writes.push({ province_region_code: row.province_region_code, body: JSON.parse(req.body) });
      if (!SUCCESS_PROVINCES.includes(row.province_region_code)) {
        reply(UPSTREAM_NOTIFICATION_PAYLOAD_INVALID, 409);
        return true;
      }
      statuses.set(row.versionId, 2);
      return send({
        planId: row.planId,
        versionId: row.versionId,
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
  const rowBox = (planId) =>
    frame.locator(`tbody label.arco-checkbox:has(input[value="${planId}"])`).first();
  await expect(rowBox("p-jxs-2026-09-00001")).toBeVisible();
  return { frame, rowBox, writes };
};

const batchApprove = async ({ frame, rowBox }, planIds, remark) => {
  for (const planId of planIds) await rowBox(planId).click();
  await frame.getByRole("button", { name: "通过", exact: true }).click();
  const dialog = frame.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("批量审批备注").fill(remark);
  await expect(dialog.locator("label.arco-checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "确认提交", exact: true }).click();
  await expect(frame.getByRole("dialog")).toBeVisible();
};

test("同一请求在不同省区得到不同上游结果时，客户端逐笔如实呈现", { timeout: 120000 }, async (t) => {
  const ctx = await openWorkbench(t);
  const { frame, writes } = ctx;

  await batchApprove(ctx, ["p-jxs-2026-09-00001", "p-jxs-2026-09-00002"], "456");
  await expect(frame.getByRole("dialog")).toContainText("成功 2 笔");
  await frame.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(frame.getByRole("dialog")).toBeHidden();

  await batchApprove(
    ctx,
    ["p-jxs-2026-09-00003", "p-jxs-2026-09-00004", "p-jxs-2026-09-00005"],
    "456",
  );
  const result = frame.getByRole("dialog");
  await expect(result).toContainText("成功 0 笔");
  await expect(result).toContainText("失败 3 笔");
  for (const name of ["组织3", "组织4", "组织5"]) await expect(result).toContainText(name);

  assert.equal(writes.length, 5);
  const bodies = new Set(writes.map((item) => JSON.stringify(item.body)));
  assert.equal(bodies.size, 1, `客户端报文应完全一致，实际: ${[...bodies].join(" | ")}`);
  const [body] = bodies;
  assert.equal(
    body,
    JSON.stringify({
      action: "APPROVE",
      expectedStatus: 1,
      remark: "456",
      notification: {
        title: "需求预测审批待处理",
        content: "一份月初需求预测已通过区域审批，请查看并按最新内容处理。",
      },
    }),
  );

  const text = await result.innerText();
  for (const leak of [
    "GEA_HTTP",
    "payload",
    "plan_month",
    "NOTIFICATION_PAYLOAD_INVALID",
    "必填字段",
  ]) {
    assert.equal(text.includes(leak), false, leak);
  }
});

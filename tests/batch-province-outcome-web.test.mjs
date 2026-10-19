import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "./profile.mjs";
import { openSalesPlan } from "./fixtures/business-page.mjs";

/**
 * 线上现象：同一个批量通过动作，省区 0013 的两笔成功，省区 0055 / 0034 / 0041 的三笔
 * 被上游以 409 NOTIFICATION_PAYLOAD_INVALID（payload.plan_month 为必填字段）拒绝。
 *
 * 这里在本地把两种上游结果都摆出来，验证「客户端发出的报文是否一致」以及
 * 「混合结果是否逐笔如实呈现」——用来把差异范围收敛到服务端。
 */
const plan = (id, provinceCode) => ({
  planId: id,
  versionId: "v" + id.slice(1),
  seq: 1,
  periodId: "period-1",
  planTypeCode: "Y",
  orderType: "M",
  dealerCode: "d" + id.slice(1),
  dealerName: "客户" + id.slice(1),
  baseName: "base-" + id.slice(1),
  areaCode: "area-" + id.slice(1),
  areaName: "大区" + id.slice(1),
  orgCode: "org-" + id.slice(1),
  orgName: "组织" + id.slice(1),
  provinceCode,
  provinceName: "省区" + provinceCode,
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

/** 上游真实响应：通知 payload 里缺 plan_month，被服务端的通知 schema 拦下。 */
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
    // 服务端把每一笔都派给了当前用户：Host 读详情时会来通知中心匹配这一条。
    const notifications = plans.map((row) => ({
      id: "n-" + row.planId,
      approval: {
        bizKey: `sales-plan:version:${row.versionId}`,
        instanceId: "i-" + row.planId,
        actionable: true,
      },
    }));
    const notification = /\/notifications\/(n-p\d)$/.exec(path);
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
        // 服务端把这一笔派给当前用户：这是本账号唯一的审批身份来源。
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
      writes.push({ provinceCode: row.provinceCode, body: JSON.parse(req.body) });
      if (!SUCCESS_PROVINCES.includes(row.provinceCode)) {
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

  // 第一轮：省区 0013 的两笔——上游接受。
  await batchApprove(ctx, ["p-jxs-2026-09-00001", "p-jxs-2026-09-00002"], "456");
  await expect(frame.getByRole("dialog")).toContainText("成功 2 笔");
  await frame.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(frame.getByRole("dialog")).toBeHidden();

  // 第二轮：另外三个省区的三笔——上游以通知 payload 校验失败拒绝。
  await batchApprove(
    ctx,
    ["p-jxs-2026-09-00003", "p-jxs-2026-09-00004", "p-jxs-2026-09-00005"],
    "456",
  );
  const result = frame.getByRole("dialog");
  await expect(result).toContainText("成功 0 笔");
  await expect(result).toContainText("失败 3 笔");
  for (const name of ["客户3", "客户4", "客户5"]) await expect(result).toContainText(name);

  // 关键结论：客户端五次提交的报文完全一致，唯一差别是目标版本（在 URL 上）。
  assert.equal(writes.length, 5);
  const bodies = new Set(writes.map((item) => JSON.stringify(item.body)));
  assert.equal(bodies.size, 1, `客户端报文应完全一致，实际: ${[...bodies].join(" | ")}`);
  const [body] = bodies;
  assert.equal(body, JSON.stringify({ action: "APPROVE", expectedStatus: 1, remark: "456" }));

  // 上游的技术文案不进界面。
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

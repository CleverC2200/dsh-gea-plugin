import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "../profile.mjs";
import { testBrowser } from "./test-browser.mjs";
import { openSalesPlan } from "./business-page.mjs";

/** 审批人员重审当前退回版本：不依赖客户重提凭据，不生成新版本。 */
const PLAN_A = "p-jxs-2026-10-00001";
const PLAN_B = "p-jxs-2026-10-00002";
const PLAN_C = "p-jxs-2026-10-00003";

const fixture = async (t, { role = "region", returnedStatus = 7, denyApproval = false } = {}) => {
  const app = await profile(t, { roles: [{ code: `sales_plan_${role}_approver`, name: role }] });
  const state = new Map([
    [
      PLAN_A,
      {
        versionId: "v1",
        seq: 1,
        status: returnedStatus,
        dealerCode: "456",
        name: "乌鲁木齐退回区域",
      },
    ],
    [PLAN_B, { versionId: "v2", seq: 1, status: 7, dealerCode: "457", name: "济南退回区域" }],
    [PLAN_C, { versionId: "v3", seq: 1, status: 1, dealerCode: "458", name: "沈阳待审批" }],
  ]);
  const submitted = [];
  const approved = [];
  const rejected = [];
  const attempts = [];
  const version = (planId, effective = true) => {
    const row = state.get(planId);
    return {
      id: row.versionId,
      planId,
      periodId: "20261001",
      planTypeCode: "Y",
      orderType: "M",
      status: row.status,
      effective,
      seq: row.seq,
      dealerCode: row.dealerCode,
      targetQty: "1.000",
      targetAmount: "12.34",
    };
  };
  const sku = (planId) => ({
    id: "s-" + planId,
    versionId: state.get(planId).versionId,
    skuCode: "789",
    productCategName: "Category",
    baseQty: "1.000",
    qty: "2.000",
    price: "12.3400",
    amt: "24.68",
    amtBase: "12.34",
  });
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    if (path.endsWith("/getPermCode"))
      return send({ codeList: [`sales-plan:plan:${role}-approve`] });
    if (path.endsWith("/periods"))
      return send({
        records: [
          { periodId: "20261001", periodMonth: "2026-10", planTypeCode: "Y", status: "OPEN" },
        ],
        total: 1,
        current: 1,
        size: 100,
      });
    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      const records = [...state.keys()]
        .filter((planId) => status === null || status === String(state.get(planId).status))
        .map((planId) => {
          const row = state.get(planId);
          return {
            planId,
            versionId: row.versionId,
            seq: row.seq,
            periodId: "20261001",
            planTypeCode: "Y",
            orderType: "M",
            status: row.status,
            dealerCode: row.dealerCode,
            dealerName: row.name,
            orgName: row.name,
            orgCode: "org-" + planId,
            currentQty: "2.000",
            currentAmount: "24.68",
            targetQty: "1.000",
            targetAmount: "12.34",
            skuCount: 1,
          };
        });
      return send({
        records,
        total: records.length,
        current: 1,
        size: Number(req.url.searchParams.get("pageSize") || 20),
        pages: 1,
      });
    }
    const detail = /\/plans\/(p-jxs-2026-10-\d+)$/.exec(path);
    if (detail) {
      const planId = detail[1];
      const current = version(planId);
      return send({
        currentVersion: current,
        versions: [current],
        skus: [sku(planId)],
        logs: [],
        actionContext: {
          versionId: current.id,
          status: current.status,
          policy: "role-visible-v1",
          allowedActions: [],
          roleActions: [{ role, allowedActions: [] }],
          snapshotHash: "a".repeat(64),
        },
      });
    }

    const versionSkus = /\/versions\/([^/]+)\/skus$/.exec(path);
    if (versionSkus) {
      const planId = [...state.entries()].find(([, row]) => row.versionId === versionSkus[1])?.[0];
      return send(planId ? [sku(planId)] : []);
    }
    const action = /\/versions\/(v[123])\/actions$/.exec(path);
    if (action) {
      const body = JSON.parse(req.body);
      assert.ok(["APPROVE", "REJECT"].includes(body.action));
      const [planId, row] = [...state.entries()].find(([, row]) => row.versionId === action[1]);
      assert.equal(body.approvalRole, role);
      assert.equal(body.approvalPolicy, "role-visible-v1");
      assert.equal(body.expectedSnapshot, "a".repeat(64));
      assert.equal(body.expectedStatus, row.status);
      attempts.push(body);
      if (denyApproval && body.action === "APPROVE") {
        reply({ success: false, message: "当前用户不具备审批权限" }, 403);
        return true;
      }
      const fromStatus = row.status;
      const rejectTarget = { region: 6, province: 7, area: 8, category: 9 }[role];
      row.status = body.action === "REJECT" ? rejectTarget : 2;
      (body.action === "REJECT" ? rejected : approved).push({ planId, body });
      return send({
        planId,
        versionId: row.versionId,
        fromStatus,
        toStatus: row.status,
        approvalRole: role,
        requestId: req.headers["x-request-id"],
        traceId: "t",
        auditId: "a",
        replayed: false,
      });
    }
    if (
      path.endsWith("/api/v1/internal/sales-plans") ||
      path.endsWith("/api/v1/internal/auth/token")
    ) {
      submitted.push(path);
      reply({ success: false }, 403);
      return true;
    }
    return false;
  });
  await app.login();
  assert.equal(
    (await app.rpc("status")).value.resubmitConnected,
    false,
    "审批重审不应依赖重提服务凭据",
  );
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
  await expect(frame.getByTestId("regional-approval-flow-toggle")).toBeVisible();
  return { frame, submitted, approved, rejected, attempts };
};

export { fixture, PLAN_A, PLAN_B, PLAN_C };

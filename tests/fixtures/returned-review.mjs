import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { profile } from "../profile.mjs";
import { testBrowser } from "./test-browser.mjs";
import { openReadySalesPlan } from "./business-page.mjs";

export const PLAN_A = "p-jxs-2026-10-00001";
export const PLAN_B = "p-jxs-2026-10-00002";
export const PLAN_C = "p-jxs-2026-10-00003";

export const fixture = async (
  t,
  {
    role = "region",
    returnedStatus = 7,
    denySubmit = false,
    endedReject = false,
    readbackFailure = false,
    serviceReady = true,
    shortened = false,
    unknownOnce = false,
    normalBatch = false,
    sameIdPeriod = false,
    originalSubmitter = "9007199254740993",
  } = {},
) => {
  const app = await profile(t, {
    roles: role === "customer" ? [] : [{ code: `sales_plan_${role}_approver`, name: role }],
    config: serviceReady
      ? {
          serviceAccounts: {
            production: {
              clientIdEnv: "GEA_SUBMIT_CLIENT",
              clientSecretEnv: "GEA_SUBMIT_SECRET",
              tenantId: "0",
              allowedUserIds: ["9007199254740993"],
            },
          },
        }
      : {},
    env: { GEA_SUBMIT_CLIENT: "fixture", GEA_SUBMIT_SECRET: "fixture-secret" },
  });
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
    [
      PLAN_B,
      {
        versionId: "v2",
        seq: 1,
        status: 7,
        dealerCode: "457",
        name: "济南退回区域",
      },
    ],
    [
      PLAN_C,
      {
        versionId: "v3",
        seq: 1,
        status: 1,
        dealerCode: "458",
        name: "沈阳待审批",
      },
    ],
  ]);
  const submitted = [];
  const logs = [];
  let readbackBlocked = readbackFailure;
  const submittedQuantities = new Map();
  const submitReceipts = new Map();
  if (normalBatch) state.get(PLAN_B).status = 1;
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
      submitter: originalSubmitter,
      returnReason: "请核对数量与继承确认值",
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
    qty: submittedQuantities.get(planId) ?? "2.000",
    regionConfirmedQty: returnedStatus >= 7 ? "1.250" : null,
    regionConfirmedAmount: returnedStatus >= 7 ? "15.43" : null,
    provinceConfirmedQty: returnedStatus >= 8 ? "1.500" : null,
    provinceConfirmedAmount: returnedStatus >= 8 ? "18.51" : null,
    areaConfirmedQty: returnedStatus >= 9 ? "1.750" : null,
    areaConfirmedAmount: returnedStatus >= 9 ? "21.60" : null,
    price: "12.3400",
    amt: submittedQuantities.get(planId) === "3.000" ? "37.02" : "24.68",
    amtBase: "12.34",
  });
  const rowVersions = (planId, current) =>
    current.seq === 1
      ? [current]
      : [
          current,
          {
            ...current,
            id: { [PLAN_A]: "v1", [PLAN_B]: "v2", [PLAN_C]: "v3" }[planId],
            seq: 1,
            status: returnedStatus,
            effective: false,
          },
        ];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    if (shortened && path.endsWith("/ai/gateway/sql/execute")) {
      const body = JSON.parse(req.body);
      const rows = ["0", "1", "3", "4", "Y"].map((node, index) => ({
        id: index + 1,
        type_code: "Y",
        examine_level: String(index),
        node_num: node,
      }));
      reply({
        success: true,
        code: 200,
        result: {
          requestId: req.headers["x-request-id"],
          operation: "SELECT",
          tables: ["agents_scm_plan_workflow_config"],
          total: rows.length,
          pageNo: body.pageNo,
          pageSize: body.pageSize,
          rows,
        },
      });
      return true;
    }
    const send = (result) => {
      reply({ success: true, result });
      return true;
    };
    if (path.endsWith("/getPermCode"))
      return send({ codeList: [`sales-plan:plan:${role}-approve`] });
    if (path.endsWith("/periods"))
      return send({
        records: [
          ...(sameIdPeriod
            ? [
                {
                  periodId: "20261001",
                  periodMonth: "2026-10",
                  planTypeCode: "DC",
                  status: "OPEN",
                },
              ]
            : []),
          {
            periodId: "20261001",
            periodMonth: "2026-10",
            planTypeCode: "Y",
            status: "OPEN",
          },
        ],
        total: sameIdPeriod ? 2 : 1,
        current: 1,
        size: 100,
      });
    if (path.endsWith("/plans")) {
      const status = req.url.searchParams.get("status");
      const type = req.url.searchParams.get("planTypeCode");
      const records = [...state.keys()]
        .filter(
          (planId) =>
            (!type || type === "Y") &&
            (status === null || status === String(state.get(planId).status)),
        )
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
            provinceCode: "province-" + planId,
            provinceName: row.name,
            areaCode: "area-" + planId,
            areaName: row.name,
            currentQty: "2.000",
            currentAmount: "24.68",
            targetQty: "1.000",
            targetAmount: "12.34",
            skuCount: 1,
          };
        });
      if (sameIdPeriod && !type && status === null)
        records.unshift({
          ...records[0],
          planId: "p-jxs-2026-10-99999",
          versionId: "other-type-version",
          planTypeCode: "DC",
          orgName: "DC周期来源",
          dealerName: "DC周期来源",
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
        versions: rowVersions(planId, current),
        skus: readbackBlocked && submitted.length && planId === PLAN_A ? [] : [sku(planId)],
        logs: logs.filter((log) => log.planId === planId),
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
      if (endedReject && planId === PLAN_A && body.action === "REJECT") {
        reply(
          {
            success: false,
            code: 409,
            message: "该版本审批实例已经结束",
            errorCode: "SALES_PLAN_APPROVAL_STATE_INVALID",
            category: "CONFLICT",
            retryable: false,
            requestId: req.headers["x-request-id"],
            traceId: req.headers["x-request-id"],
          },
          409,
        );
        return true;
      }
      if (body.action === "APPROVE" && row.status >= 6) {
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
    if (path.endsWith("/api/v1/internal/auth/token"))
      return send({
        access_token: "fixture-service",
        token_type: "Bearer",
        expires_in: 600,
        scope: "sales-plan:write",
      });
    if (path.endsWith("/api/v1/internal/sales-plans")) {
      const body = JSON.parse(req.body);
      const planId = [...state.entries()].find(
        ([, row]) => row.dealerCode === body.dealerCode,
      )?.[0];
      assert.ok(planId);
      submitted.push({
        planId,
        body,
        key: req.headers["idempotency-key"],
        requestId: req.headers["x-request-id"],
      });
      const prior = submitReceipts.get(planId);
      if (prior) return send({ ...prior, replayed: true });
      if (denySubmit === true || denySubmit === planId) {
        reply({ success: false, message: "提报窗口已关闭，请联系业务管理员" }, 403);
        return true;
      }
      assert.equal(body.status, returnedStatus - 5);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].price, "12.3400");
      const row = state.get(planId);
      row.versionId = planId === PLAN_A ? "v-new" : "v-new-b";
      row.seq = 2;
      row.status = body.status;
      const nodes = shortened ? [1, 3, 4] : [1, 2, 3, 4];
      row.nextActor = { 1: "region", 2: "province", 3: "area", 4: "category" }[
        nodes.find((node) => node >= body.status)
      ];
      submittedQuantities.set(planId, body.items[0].qty);
      logs.push({
        planId: planId,
        versionId: row.versionId,
        actionCode: "RESUBMIT",
        requestId: req.headers["x-request-id"],
      });
      const submitReceipt = {
        planId: planId,
        versionId: row.versionId,
        seq: 2,
        status: body.status,
        requestId: req.headers["x-request-id"],
        traceId: "t",
        auditId: "a",
        replayed: false,
      };
      submitReceipts.set(planId, submitReceipt);
      if (unknownOnce && planId === PLAN_A) {
        reply({ message: "结果暂时未知" }, 502);
        return true;
      }
      return send(submitReceipt);
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
  const frame = await openReadySalesPlan(page);
  await expect(frame.getByTestId("regional-approval-workbench")).toBeVisible();
  await expect(frame.getByTestId("regional-approval-flow-toggle")).toBeVisible();
  return {
    app,
    frame,
    page,
    submitted,
    approved,
    rejected,
    attempts,
    state,
    allowReadback: () => {
      readbackBlocked = false;
    },
  };
};

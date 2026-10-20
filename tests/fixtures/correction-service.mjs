import assert from "node:assert/strict";

const roles = ["region", "province", "area", "category"];
const suffixes = [
  "AdjAddQty",
  "AdjCutQty",
  "AdjAddAmount",
  "AdjCutAmount",
  "ConfirmedQty",
  "ConfirmedAmount",
];

export function correctionService({ versionId = "v", monthlyApproved = true } = {}) {
  let revision = 0;
  let status = 1;
  let responseMode = "normal";
  const planId = "p-jxs-2026-09-00001";
  const logs = [];
  const writes = [];
  const receipts = [];
  const replay = new Map();
  const sku = {
    id: "1",
    versionId,
    skuCode: "123",
    skuName: "冻结基准SKU",
    productCategName: "水饺",
    qty: "30",
    corrBaseQty: "30",
    baseQty: "30",
    price: "2",
    amt: "60",
    amtBase: "60",
    adjAddQty: "2",
    adjCutQty: "0",
  };
  const nodeIndex = () => (status >= 7 && status <= 9 ? status - 7 : status - 1);
  const baseline = (index) => {
    for (let i = index; i >= 0; i--)
      if (sku[roles[i] + "ConfirmedQty"] != null) return Number(sku[roles[i] + "ConfirmedQty"]);
    return Number(sku.qty);
  };
  const version = () => ({
    id: versionId,
    planId,
    seq: 1,
    periodId: "20260901",
    planTypeCode: "Y",
    orderType: responseMode === "monthly" ? "M" : "Z",
    dealerCode: "123",
    dealerName: "纠偏客户",
    orgCode: "o1",
    orgName: "纠偏销售组",
    provinceCode: "pr1",
    provinceName: "纠偏省区",
    areaCode: "a1",
    areaName: "纠偏大区",
    status,
    effective: true,
    targetAmount: "100",
    targetQty: "30",
    currentQty: String(baseline(3)),
    currentAmount: String(baseline(3) * 2),
    skuCount: 1,
    submitter: "another",
  });
  const allowedActions = () =>
    !monthlyApproved || responseMode === "monthly"
      ? []
      : status >= 1 && status <= 4
        ? ["APPROVE", "REJECT"]
        : status >= 7 && status <= 9
          ? ["REJECT"]
          : [];
  const detail = () => ({
    currentVersion: version(),
    actionContext: {
      versionId,
      status,
      nodeOrder: status >= 1 && status <= 4 ? status + 1 : nodeIndex() + 2,
      allowedActions: allowedActions(),
      snapshotHash: revision.toString(16).padStart(64, "0"),
    },
    skus: [{ ...sku }],
    versions: [version()],
    logs: structuredClone(logs),
  });
  return {
    detail,
    writes,
    receipts,
    setResponseMode(mode) {
      assert.ok(["normal", "monthly", "wrong-period"].includes(mode));
      responseMode = mode;
    },
    route(req, _res, reply) {
      const path = req.url.pathname;
      if (path.endsWith("/getPermCode")) {
        reply({
          success: true,
          result: { codeList: roles.map((role) => "sales-plan:plan:" + role + "-approve") },
        });
        return true;
      }
      if (path.endsWith("/sql/execute")) {
        const request = JSON.parse(req.body);
        const field = request.sql.includes("agents_order_execute_isontime_mi")
          ? "ship_qty"
          : request.sql.includes("agents_scm_cust_deliv_daily_di")
            ? "ship_amount"
            : undefined;
        if (!field) return false;
        reply({
          success: true,
          result: {
            operation: "SELECT",
            rows: [{ cust_code: "123", [field]: field === "ship_qty" ? "10" : "30" }],
            total: 1,
            returnedColumns: ["cust_code", field],
            rejectedColumns: [],
          },
        });
        return true;
      }
      if (path.endsWith("/plans")) {
        const query = req.url.searchParams;
        const requestedStatus = query.get("status");
        const statuses = query.get("statuses")?.split(",").map(Number);
        const records =
          (requestedStatus !== null && Number(requestedStatus) !== status) ||
          (statuses && !statuses.includes(status))
            ? []
            : [
                {
                  ...version(),
                  versionId,
                  periodId:
                    responseMode === "wrong-period" && query.has("periodId")
                      ? "20260902"
                      : "20260901",
                  monthlyApproved,
                  hasCorrection: responseMode !== "monthly",
                  mPlanAmount: "60",
                  mPlanQty: "30",
                },
              ];
        reply({
          success: true,
          result: { records, total: records.length, size: 200, current: 1, pages: 1 },
        });
        return true;
      }
      if (path.endsWith("/plans/" + planId)) {
        reply({ success: true, result: detail() });
        return true;
      }
      if (path.endsWith("/plans/" + planId + "/versions")) {
        reply({ success: true, result: [version()] });
        return true;
      }
      if (path.endsWith("/plans/" + planId + "/logs")) {
        reply({ success: true, result: structuredClone(logs) });
        return true;
      }
      if (path.endsWith("/versions/" + versionId + "/skus")) {
        reply({ success: true, result: [{ ...sku }] });
        return true;
      }
      if (!path.endsWith("/versions/" + versionId + "/actions")) return false;
      const body = JSON.parse(req.body);
      assert.ok(
        Object.keys(body).every((key) =>
          ["action", "expectedStatus", "remark", "adjustments", "notification"].includes(key),
        ),
      );
      const key = req.headers["idempotency-key"];
      assert.ok(key);
      assert.ok(req.headers["x-request-id"]);
      const prior = replay.get(key);
      if (prior) {
        assert.deepEqual(body, prior.body);
        reply({ success: true, result: { ...prior.receipt, replayed: true } });
        return true;
      }
      if (body.expectedStatus !== status) {
        reply({ message: "计划状态已变化" }, 409);
        return true;
      }
      if (!allowedActions().includes(body.action)) {
        reply({ message: "月初未终审或当前节点不可执行该操作" }, 403);
        return true;
      }
      const index = nodeIndex();
      const node = roles[index];
      const from = status;
      if (body.action === "REJECT") {
        assert.ok(body.remark?.trim());
        assert.equal(body.adjustments, undefined);
        for (const suffix of suffixes) sku[node + suffix] = null;
        status = index + 6;
      } else {
        assert.ok(!body.adjustments || body.adjustments.length === 1);
        if (body.adjustments?.length) assert.equal(body.adjustments[0].skuCode, "123");
        const delta = Number(body.adjustments?.[0]?.adjustQty ?? "0");
        const quantity = baseline(index) + delta;
        if (!Number.isFinite(delta) || quantity < 0) {
          reply({ message: "纠偏后计划数量不可为负" }, 400);
          return true;
        }
        sku[node + "AdjAddQty"] = String(Math.max(0, delta));
        sku[node + "AdjCutQty"] = String(Math.max(0, -delta));
        sku[node + "AdjAddAmount"] = (Math.max(0, delta) * 2).toFixed(2);
        sku[node + "AdjCutAmount"] = (Math.max(0, -delta) * 2).toFixed(2);
        sku[node + "ConfirmedQty"] = String(quantity);
        sku[node + "ConfirmedAmount"] = String(quantity * 2);
        status++;
      }
      revision++;
      writes.push(structuredClone(body));
      const log = {
        id: String(revision),
        planId,
        versionId,
        fromStatus: from,
        toStatus: status,
        actionCode: body.action,
        requestId: req.headers["x-request-id"],
        traceId: "trace",
        operatorCode: "reviewer",
        remark: body.remark,
        actionAt: new Date().toISOString(),
        nodeOrder: index + 2,
        decisionJson: JSON.stringify([
          Object.fromEntries([
            ["skuCode", "123"],
            ...suffixes.map((suffix) => [
              suffix[0].toLowerCase() + suffix.slice(1),
              sku[node + suffix] ?? null,
            ]),
          ]),
        ]),
      };
      logs.push(log);
      const receipt = {
        planId,
        versionId,
        fromStatus: from,
        toStatus: status,
        requestId: log.requestId,
        traceId: "trace",
        auditId: "sales-plan-log:" + revision,
        replayed: false,
      };
      receipts.push(receipt);
      replay.set(key, { body: structuredClone(body), receipt });
      reply({ success: true, result: receipt });
      return true;
    },
  };
}

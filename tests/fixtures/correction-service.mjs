/** External GEA contract fixture. These proposed correction fields are not a claim of deployment. */
import assert from "node:assert/strict";
import { MockDmsWriteback } from "@cleverc2200/dsh-agent-workbench/dms-mock";
export function correctionService() {
  let revision = 0,
    status = 1;
  const logs = [];
  const writes = [];
  let mock;
  const sku = {
    id: "1",
    versionId: "v",
    skuCode: "123",
    productCategName: "测试SKU",
    qty: "30",
    baseQty: "30",
    price: "2",
    amt: "60",
    amtBase: "60",
    adjAddQty: "2",
    adjCutQty: "0",
  };
  const version = () => ({
    id: "v",
    planId: "p-jxs-2026-09-00001",
    seq: 1,
    periodId: "20260901",
    planTypeCode: "Y",
    orderType: "Z",
    dealerCode: "123",
    dealerName: "纠偏客户",
    status,
    effective: true,
    targetAmount: "100",
    targetQty: "30",
    currentQty: "30",
    currentAmount: "60",
    skuCount: 1,
    submitter: "another",
  });
  const detail = () => ({
    currentVersion: version(),
    actionContext: {
      versionId: "v",
      status,
      nodeOrder: status >= 6 ? status - 5 : status + 1,
      allowedActions: [1, 2, 3, 4, 7, 8, 9].includes(status) ? ["SAVE", "APPROVE", "REJECT"] : [],
      snapshotHash: revision.toString(16).padStart(64, "0"),
    },
    correctionContext: { contract: "absolute-net-v1", monthlyApproved: true, approvalOpen: true },
    skus: [{ ...sku }],
    versions: [],
    logs: [...logs],
    ...(mock ? { dmsMock: { source: "DMS_MOCK", ...mock.read() } } : {}),
  });
  const receiver = {
    detail,
    writes,
    deliver(outcome) {
      mock.deliver(outcome);
      status = mock.read().plan.status;
      revision++;
    },
    reconcile() {
      mock.reconcile();
      status = mock.read().plan.status;
      revision++;
    },
    route(req, res, reply) {
      const path = req.url.pathname;
      if (path.endsWith("/getPermCode")) {
        reply({
          success: true,
          result: {
            codeList: ["region", "province", "area", "category"].map(
              (role) => `sales-plan:plan:${role}-approve`,
            ),
          },
        });
        return true;
      }
      if (path.endsWith("/plans")) {
        const requestedStatus = req.url.searchParams.get("status");
        if (requestedStatus !== null && Number(requestedStatus) !== status) {
          reply({
            success: true,
            result: { records: [], total: 0, size: 20, current: 1, pages: 1 },
          });
          return true;
        }
        const orderType = req.url.searchParams.get("orderType") ?? "Z";
        reply({
          success: true,
          result: {
            records: [
              {
                ...version(),
                versionId: "v",
                orderType,
                monthlyApproved: true,
                hasCorrection: true,
                mPlanAmount: "60",
                mPlanQty: "30",
                shipAmount: "30",
                amountProgress: "50",
                shipQty: "10",
                corrPlanAmount: "64",
              },
            ],
            total: 1,
            size: 20,
            current: 1,
            pages: 1,
          },
        });
        return true;
      }
      if (path.endsWith("/plans/p-jxs-2026-09-00001")) {
        reply({ success: true, result: detail() });
        return true;
      }
      if (path.endsWith("/versions/v/skus")) {
        reply({ success: true, result: [sku] });
        return true;
      }
      if (path.endsWith("/versions/v/actions")) {
        const body = JSON.parse(req.body);
        // 此夹具模拟旧版动作接口，只接收基础字段。快照与绝对净量契约由 Host
        // 在出站前校验，拒绝过期快照的场景由 correction-host 覆盖。
        assert.equal(body.expectedSnapshot, undefined);
        assert.equal(body.adjustmentMode, undefined);
        assert.ok(
          Object.keys(body).every((key) =>
            ["action", "expectedStatus", "remark", "adjustments", "notification"].includes(key),
          ),
        );
        assert.equal(body.expectedStatus, status);
        const node = ["", "region", "province", "area", "category"][
          status >= 6 ? status - 6 : status
        ];
        const from = status;
        if (body.action === "REJECT") {
          for (const suffix of [
            "AdjAddQty",
            "AdjCutQty",
            "AdjAddAmount",
            "AdjCutAmount",
            "ConfirmedQty",
            "ConfirmedAmount",
          ])
            sku[node + suffix] = null;
          status = (status >= 6 ? status - 6 : status) + 5;
        } else {
          // Worked fixture uses integer quantities and price 2; expectations remain literal in tests.
          const delta = Number(body.adjustments[0].adjustQty);
          if (30 + delta < 0) {
            reply({ message: "negative" }, 400);
            return true;
          }
          sku[node + "AdjAddQty"] = String(Math.max(0, delta));
          sku[node + "AdjCutQty"] = String(Math.max(0, -delta));
          sku[node + "AdjAddAmount"] = (Math.max(0, delta) * 2).toFixed(2);
          sku[node + "AdjCutAmount"] = (Math.max(0, -delta) * 2).toFixed(2);
          if (body.action === "APPROVE") {
            sku[node + "ConfirmedQty"] = String(30 + delta);
            sku[node + "ConfirmedAmount"] = String((30 + delta) * 2);
            status = (status >= 6 ? status - 6 : status) + 1;
          }
        }
        revision++;
        writes.push(body);
        const log = {
          id: String(revision),
          planId: "p-jxs-2026-09-00001",
          versionId: "v",
          fromStatus: from,
          toStatus: status,
          actionCode: body.action,
          requestId: req.headers["x-request-id"],
          traceId: "trace",
          operatorCode: "reviewer",
          remark: body.remark,
          actionAt: new Date().toISOString(),
        };
        logs.push(log);
        if (status === 5)
          mock = new MockDmsWriteback({
            planId: "p-jxs-2026-09-00001",
            versionId: "v",
            typeCode: "Y",
            orderType: "Z",
            status,
            skus: [
              {
                skuCode: "123",
                qty: "30",
                addQty: sku.categoryAdjAddQty,
                cutQty: sku.categoryAdjCutQty,
              },
            ],
          });
        reply({
          success: true,
          result: {
            planId: "p-jxs-2026-09-00001",
            versionId: "v",
            fromStatus: from,
            toStatus: status,
            requestId: log.requestId,
            traceId: "trace",
            auditId: "sales-plan-log:" + revision,
            replayed: false,
          },
        });
        return true;
      }
    },
  };
  return receiver;
}

import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "correction SAVE binds absolute adjustments to a fresh eligible Z version and refuses stale snapshots",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    let writes = 0;
    let eligible = true;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans/z")) {
        reply({
          success: true,
          result: {
            currentVersion: {
              id: "v",
              planId: "z",
              orderType: "Z",
              planTypeCode: "Y",
              effective: true,
              status: 1,
              submitter: "different",
            },
            actionContext: {
              versionId: "v",
              status: 1,
              nodeOrder: 2,
              allowedActions: ["SAVE", "APPROVE", "REJECT"],
              snapshotHash: "a".repeat(64),
            },
            correctionContext: {
              contract: "absolute-net-v1",
              monthlyApproved: eligible,
              approvalOpen: true,
            },
            skus: [
              {
                id: "1",
                versionId: "v",
                skuCode: "123",
                qty: "30",
                price: "2",
                adjAddQty: "2",
                adjCutQty: "0",
              },
            ],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/versions/v/actions")) {
        writes++;
        assert.equal(JSON.parse(req.body).adjustments[0].adjustQty, "8");
        reply({ success: true, result: { saved: true } });
        return true;
      }
    });
    const payload = {
      planId: "z",
      versionId: "v",
      requestId: "r",
      idempotencyKey: "key",
      request: {
        action: "SAVE",
        expectedStatus: 1,
        expectedSnapshot: "a".repeat(64),
        adjustmentMode: "ABSOLUTE_NET",
        adjustments: [{ skuCode: "123", adjustQty: "8" }],
      },
    };
    assert.equal((await app.rpc("sales-plan/action", payload)).ok, true);
    assert.equal(writes, 1);
    assert.equal(
      (
        await app.rpc("sales-plan/action", {
          ...payload,
          request: { ...payload.request, expectedSnapshot: "b".repeat(64) },
        })
      ).ok,
      false,
    );
    eligible = false;
    assert.equal(
      (
        await app.rpc("sales-plan/action", {
          ...payload,
          idempotencyKey: "denied",
        })
      ).ok,
      false,
    );
    assert.equal(writes, 1);
  },
);

test(
  "unknown correction result retries the same validated body and key after the upstream snapshot changes",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    let accepted = false,
      reads = 0;
    const bodies = [];
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans/z")) {
        reads++;
        reply({
          success: true,
          result: {
            currentVersion: {
              id: "v",
              planId: "z",
              orderType: "Z",
              planTypeCode: "Y",
              effective: true,
              status: accepted ? 2 : 1,
              submitter: "other",
            },
            actionContext: {
              versionId: "v",
              status: accepted ? 2 : 1,
              nodeOrder: accepted ? 3 : 2,
              allowedActions: ["APPROVE"],
              snapshotHash: (accepted ? "b" : "a").repeat(64),
            },
            correctionContext: {
              contract: "absolute-net-v1",
              monthlyApproved: true,
              approvalOpen: true,
            },
            skus: [
              {
                id: "1",
                versionId: "v",
                skuCode: "123",
                qty: "30",
                price: "2",
                adjAddQty: "2",
                adjCutQty: "0",
              },
            ],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/versions/v/actions")) {
        bodies.push([req.headers["idempotency-key"], req.body]);
        if (!accepted) {
          accepted = true;
          res.destroy();
        } else reply({ success: true, result: { replayed: true } });
        return true;
      }
    });
    const cmd = {
      planId: "z",
      versionId: "v",
      requestId: "r",
      idempotencyKey: "same",
      request: {
        action: "APPROVE",
        expectedStatus: 1,
        expectedSnapshot: "a".repeat(64),
        adjustmentMode: "ABSOLUTE_NET",
        adjustments: [{ skuCode: "123", adjustQty: "2" }],
      },
    };
    assert.equal((await app.rpc("sales-plan/action", cmd)).ok, false);
    assert.equal((await app.rpc("sales-plan/action", cmd)).ok, true);
    assert.equal(reads, 1);
    assert.deepEqual(bodies[0], bodies[1]);
  },
);

test(
  "Host uses the current environment workflow for a newly configured correction type",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    let writes = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/sql/execute")) {
        const body = JSON.parse(req.body);
        const rows = ["0", "1", "4", "Y"].map((n, i) => ({
          id: i + 1,
          type_code: "NEW",
          examine_level: String(i),
          node_num: n,
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
      if (req.url.pathname.endsWith("/plans/z")) {
        reply({
          success: true,
          result: {
            currentVersion: {
              id: "v",
              planId: "z",
              orderType: "Z",
              planTypeCode: "NEW",
              effective: true,
              status: 1,
              submitter: "other",
            },
            actionContext: {
              versionId: "v",
              status: 1,
              nodeOrder: 2,
              allowedActions: ["APPROVE"],
              snapshotHash: "a".repeat(64),
            },
            correctionContext: {
              contract: "absolute-net-v1",
              monthlyApproved: true,
              approvalOpen: true,
            },
            skus: [
              {
                id: "1",
                versionId: "v",
                skuCode: "123",
                qty: "30",
                price: "2",
                adjAddQty: "2",
                adjCutQty: "0",
              },
            ],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/versions/v/actions")) {
        writes++;
        reply({ success: true, result: { approved: true } });
        return true;
      }
    });
    const result = await app.rpc("sales-plan/action", {
      planId: "z",
      versionId: "v",
      requestId: "r",
      idempotencyKey: "new-type",
      request: {
        action: "APPROVE",
        expectedStatus: 1,
        expectedSnapshot: "a".repeat(64),
        adjustmentMode: "ABSOLUTE_NET",
        adjustments: [{ skuCode: "123", adjustQty: "2" }],
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(writes, 1);
  },
);

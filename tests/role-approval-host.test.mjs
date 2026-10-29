import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "Host binds role writes to fresh permission and capability evidence while refusing stale, terminal and downgraded requests",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let mode = "supported",
      writes = 0,
      status = 2;
    const snapshot = "a".repeat(64);
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      if (path.endsWith("/plans/p"))
        return send({
          currentVersion: {
            id: "v",
            planId: "p",
            status,
            effective: mode !== "ineffective",
            planTypeCode: "Y",
          },
          skus: [],
          versions: [],
          logs: [],
          actionContext: {
            versionId: "v",
            status,
            nodeOrder: 3,
            snapshotHash: mode === "stale" ? "b".repeat(64) : snapshot,
            allowedActions: ["APPROVE"],
            ...(mode === "legacy"
              ? {}
              : {
                  policy: "role-visible-v1",
                  roleActions: [
                    {
                      role: "region",
                      allowedActions: mode === "current-node-only" ? [] : ["APPROVE", "REJECT"],
                    },
                  ],
                }),
          },
        });
      if (path.endsWith("/versions/v/actions")) {
        writes++;
        const body = JSON.parse(req.body);
        assert.equal(body.action, "APPROVE");
        assert.equal(body.approvalRole, "region");
        assert.equal(body.approvalPolicy, "role-visible-v1");
        assert.equal(body.expectedSnapshot, snapshot);
        return send({
          planId: "p",
          versionId: "v",
          fromStatus: status,
          toStatus: status,
          approvalRole: "region",
          requestId: req.headers["x-request-id"],
          traceId: "t",
          auditId: "a",
          replayed: false,
        });
      }
      if (path.endsWith("/notifications")) return send({ items: [], total: 0 });
    });
    await app.login();
    let attempt = 0;
    const action = (patch = {}) =>
      app.rpc("sales-plan/action", {
        planId: "p",
        versionId: "v",
        requestId: `r${++attempt}`,
        idempotencyKey: `role:${attempt}`,
        request: {
          action: "APPROVE",
          approvalRole: "region",
          approvalPolicy: "role-visible-v1",
          expectedStatus: status,
          expectedSnapshot: snapshot,
          ...patch,
        },
      });
    for (status of [2, 7]) {
      for (const scenario of ["legacy", "stale", "ineffective"]) {
        mode = scenario;
        assert.equal((await action()).ok, false, scenario);
      }
    }
    mode = "supported";
    // 未提报、待回写、回写完成都不是审批动作，仍然写不了。
    for (status of [0, 5, 10]) assert.equal((await action()).ok, false, `status ${status}`);
    assert.equal(writes, 0);
    for (status of [6, 7, 8, 9]) {
      assert.equal(
        (await action({ approvalRole: "category" })).ok,
        false,
        "未授予的角色不能借退回态写入",
      );
      assert.equal(
        (await action({ approvalPolicy: undefined })).ok,
        false,
        "退回态不能绕过已协商的角色契约",
      );
      const result = await action();
      assert.equal(result.ok, false, JSON.stringify(result));
    }
    assert.equal(writes, 0);
    status = 6;
    const returnedSave = await app.rpc("sales-plan/action", {
      planId: "p",
      versionId: "v",
      requestId: `r${++attempt}`,
      idempotencyKey: `role:${attempt}`,
      request: { action: "SAVE", expectedStatus: 6, expectedSnapshot: snapshot },
    });
    assert.equal(returnedSave.ok, false, "returned SAVE");
    status = 2;
    writes = 0;
    assert.equal((await action({ approvalRole: "category" })).ok, false);
    assert.equal((await action({ approvalRole: undefined, approvalPolicy: undefined })).ok, false);
    assert.equal(writes, 0);
    mode = "current-node-only";
    assert.equal((await action()).ok, true);
    assert.equal(writes, 1);
    mode = "supported";
    assert.equal((await action()).ok, true);
    assert.equal(writes, 2);
    const deniedDowngrade = await action({ approvalPolicy: undefined });
    assert.equal(deniedDowngrade.ok, false);
    assert.equal(writes, 2);
  },
);

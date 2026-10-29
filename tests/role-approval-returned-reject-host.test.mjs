import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "Host allows a returned regional plan to be rejected once more toward the customer",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const snapshot = "a".repeat(64);
    let writes = 0;
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      if (path.endsWith("/plans/p"))
        return send({
          currentVersion: { id: "v", planId: "p", status: 7, effective: true, planTypeCode: "Y" },
          skus: [],
          versions: [],
          logs: [],
          actionContext: {
            versionId: "v",
            status: 7,
            nodeOrder: 2,
            snapshotHash: snapshot,
            allowedActions: ["REJECT"],
          },
        });
      if (path.endsWith("/versions/v/actions")) {
        const body = JSON.parse(req.body);
        assert.equal(body.action, "REJECT");
        assert.equal(body.expectedStatus, 7);
        assert.equal(body.remark, "继续退回客户核对");
        writes++;
        return send({
          planId: "p",
          versionId: "v",
          fromStatus: 7,
          toStatus: 6,
          requestId: req.headers["x-request-id"],
          traceId: "t",
          auditId: "a",
          replayed: false,
        });
      }
      return false;
    });
    await app.login();
    const result = await app.rpc("sales-plan/action", {
      planId: "p",
      versionId: "v",
      requestId: "repeat-reject",
      idempotencyKey: "repeat-reject",
      request: {
        action: "REJECT",
        approvalRole: "region",
        expectedStatus: 7,
        expectedSnapshot: snapshot,
        remark: "继续退回客户核对",
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.toStatus, 6);
    assert.equal(writes, 1);
  },
);

import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "a version that moved on reports a refreshable conflict instead of a permission error",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let writes = 0;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:region-approve"] });
      // 提交时重新读到的版本已经被别人推到下一节点（状态 1 → 2）。
      if (path.endsWith("/plans/p"))
        return send({
          currentVersion: { id: "v", planId: "p", status: 2, effective: true, planTypeCode: "Y" },
          skus: [],
          versions: [],
          logs: [],
          actionContext: {
            versionId: "v",
            status: 2,
            snapshotHash: "a".repeat(64),
            policy: "role-visible-v1",
            allowedActions: [],
            roleActions: [{ role: "province", allowedActions: ["APPROVE", "REJECT"] }],
          },
        });
      if (path.endsWith("/versions/v/actions")) {
        writes++;
        return send({});
      }
    });
    await app.login();
    const result = await app.rpc("sales-plan/action", {
      planId: "p",
      versionId: "v",
      requestId: "stale-version",
      idempotencyKey: "stale-version",
      request: { action: "REJECT", approvalRole: "region", expectedStatus: 1, remark: "退回原因" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GEA_HTTP_409");
    assert.match(result.error.message, /请刷新权威队列/);
    assert.equal(writes, 0);
  },
);

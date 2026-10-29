import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "Host accepts approval backed by an assigned task, matching the upstream camelCase bizKey",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let writes = 0;
    let keyShape = "camel";
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode")) return send({ codeList: [] });
      if (path.endsWith("/plans/p"))
        return send({
          currentVersion: { id: "v", planId: "p", status: 1, effective: true, planTypeCode: "Y" },
          skus: [],
          versions: [],
          logs: [],
        });
      const approval =
        keyShape === "camel"
          ? { bizKey: "sales-plan:version:v", instanceId: "i", actionable: true }
          : { biz_key: "sales-plan:version:v", instance_id: "i", actionable: true };
      if (path.endsWith("/notifications/n")) return send({ id: "n", approval });
      if (path.endsWith("/notifications"))
        return send({ items: [{ id: "n", approval }], total: 1 });
      if (path.endsWith("/versions/v/actions")) {
        writes++;
        const body = JSON.parse(req.body);
        assert.equal(body.action, "APPROVE");
        assert.equal(body.approvalRole, undefined, "上游报文只发接口文档声明的字段");
        assert.equal(body.approvalPolicy, undefined);
        assert.equal(body.expectedSnapshot, undefined);
        return send({
          planId: "p",
          versionId: "v",
          fromStatus: 1,
          toStatus: 1,
          approvalRole: "region",
          requestId: req.headers["x-request-id"],
          traceId: "t",
          auditId: "a",
          replayed: false,
        });
      }
    });
    await app.login();
    const approve = (key) =>
      app.rpc("sales-plan/action", {
        planId: "p",
        versionId: "v",
        requestId: key,
        idempotencyKey: key,
        request: { action: "APPROVE", approvalRole: "region", expectedStatus: 1 },
      });
    const camel = await approve("workflow-task-camel");
    assert.equal(camel.ok, true, JSON.stringify(camel));
    assert.equal(writes, 1);
    // 上游换成蛇形字段时同样要认得出来，避免再次静默失效。
    keyShape = "snake";
    const snake = await approve("workflow-task-snake");
    assert.equal(snake.ok, true, JSON.stringify(snake));
    assert.equal(writes, 2);
  },
);

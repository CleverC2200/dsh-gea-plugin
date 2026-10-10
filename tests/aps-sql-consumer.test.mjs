import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { profile } from "./profile.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";
test(
  "APS aps uses authenticated Agent delegation and denies obsolete consumer",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      beforeStart: fixtureWorkbench([
        resolve("../dsh-agent-workbench/lib/business/inventory-apsplan"),
      ]),
    });
    await app.login();
    let delegated,
      sessions = 0,
      queries = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/agent/session")) {
        sessions++;
        delegated = JSON.parse(req.body);
        reply({
          success: true,
          result: { accessDecision: { allowed: true }, delegationToken: "fixture-aps-delegation" },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/ai/gateway/sql/execute")) {
        queries++;
        reply({
          success: true,
          result: { rows: [{ records: 0 }], total: 1, pageNo: 1, pageSize: 200 },
        });
        return true;
      }
    });
    const result = await app.rpc("plugin/sql", {
      consumerCode: "aps",
      sql: "SELECT COUNT(*) AS records FROM agents_scm_safety_stock",
      parameters: {},
      resultShape: "rows",
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(delegated.agentCode, "aps");
    assert.equal(sessions, 1);
    assert.equal(queries, 1);
    assert.deepEqual(result.value.rows, [{ records: 0 }]);
    const obsolete = await app.rpc("plugin/sql", {
      consumerCode: "aps-plan-collaboration",
      sql: "SELECT COUNT(*) AS records FROM agents_scm_safety_stock",
    });
    assert.ok(obsolete.error);
    assert.equal(obsolete.error.code, "GEA_PLUGIN_CONSUMER_NOT_ALLOWED");
    assert.equal(sessions, 1);
    assert.equal(queries, 1);
  },
);

test(
  "uninstalled APS and obsolete consumers are denied before Agent delegation or SQL",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    let sessions = 0,
      queries = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/agent/session")) {
        sessions++;
        reply({
          success: true,
          result: { accessDecision: { allowed: true }, delegationToken: "fixture-aps-delegation" },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/ai/gateway/sql/execute")) {
        queries++;
        reply({
          success: true,
          result: { rows: [{ records: 0 }], total: 1, pageNo: 1, pageSize: 200 },
        });
        return true;
      }
    });
    for (const consumerCode of ["aps", "aps-plan-collaboration"]) {
      const result = await app.rpc("plugin/sql", {
        consumerCode,
        sql: "SELECT COUNT(*) AS records FROM agents_scm_safety_stock",
      });
      assert.equal(result.error?.code, "GEA_PLUGIN_CONSUMER_NOT_ALLOWED");
    }
    assert.equal(sessions, 0);
    assert.equal(queries, 0);
  },
);

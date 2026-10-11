import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "APS mock stays before wire while a readable Agent delegates SQL and obsolete APS consumer is denied",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    let delegated,
      queries = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/agent/session")) {
        delegated = JSON.parse(req.body);
        reply({
          success: true,
          result: {
            accessDecision: { allowed: true },
            delegationToken: "fixture-aps-delegation",
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/ai/gateway/sql/execute")) {
        queries++;
        reply({
          success: true,
          result: {
            rows: [{ records: 0 }],
            total: 1,
            pageNo: 1,
            pageSize: 200,
          },
        });
        return true;
      }
    });
    const sql = "SELECT COUNT(*) AS records FROM agents_scm_safety_stock";
    // Public prepare builds the actual APS package in mock mode. It has no SQL channel.
    const aps = await app.rpc("plugin/sql", {
      consumerCode: "aps",
      sql,
      parameters: {},
      resultShape: "rows",
    });
    assert.equal(aps.error?.code, "GEA_CAPABILITY_MOCK_ONLY", JSON.stringify(aps));
    assert.equal(delegated, undefined);
    assert.equal(queries, 0);
    // Keep the authenticated Agent/SQL-success assertions on an actual readable package.
    const result = await app.rpc("plugin/sql", {
      consumerCode: "full-chain-inventory",
      sql,
      parameters: {},
      resultShape: "rows",
    });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(delegated.agentCode, "full-chain-inventory");
    assert.equal(delegated.channel, "AI_PORTAL");
    assert.equal(typeof delegated.conversationId, "string");
    assert.ok(delegated.conversationId.length > 0);
    assert.equal(queries, 1);
    assert.deepEqual(result.value.rows, [{ records: 0 }]);
    const obsolete = await app.rpc("plugin/sql", {
      consumerCode: "aps-plan-collaboration",
      sql,
    });
    assert.ok(obsolete.error);
    assert.equal(queries, 1);
  },
);

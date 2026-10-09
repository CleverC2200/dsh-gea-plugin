import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "expired cached SQL delegation is renewed once without failing the page",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, { bundle: true });
    await app.login();
    let sessions = 0;
    const sqlTokens = [];
    let failureMode = "coded-expiry";
    let sessionBase = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/ai/gateway/agent/session")) {
        if (failureMode === "login-expired") {
          reply({ message: "login expired" }, 401);
          return true;
        }
        sessions++;
        reply({
          success: true,
          result: { accessDecision: { allowed: true }, delegationToken: `delegation-${sessions}` },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/ai/gateway/sql/execute")) {
        sqlTokens.push(req.headers["x-delegation-token"]);
        if (
          failureMode === "coded-expiry" &&
          req.headers["x-delegation-token"] === "delegation-1" &&
          sqlTokens.length > 1
        )
          reply(
            {
              success: false,
              errorCode: "AI_GATEWAY_SESSION_EXPIRED",
              message: "delegation expired",
            },
            401,
          );
        else if (failureMode === "bare-401" && req.headers["x-delegation-token"] === "delegation-2")
          reply({ message: "unauthorized" }, 401);
        else if (failureMode === "forbidden")
          reply(
            {
              success: false,
              errorCode: "AI_GATEWAY_DATA_PERMISSION_DENIED",
              message: "forbidden",
            },
            403,
          );
        else if (
          failureMode === "first-token-expiry" &&
          (Number(String(req.headers["x-delegation-token"]).split("-").at(-1)) - sessionBase) %
            2 ===
            1
        )
          reply(
            {
              success: false,
              errorCode: "AI_GATEWAY_SESSION_EXPIRED",
              message: "delegation expired",
            },
            401,
          );
        else if (failureMode === "login-expired") reply({ message: "delegation expired" }, 401);
        else
          reply({
            success: true,
            result: { rows: [{ records: 1 }], total: 1, pageNo: 1, pageSize: 200 },
          });
        return true;
      }
    });
    const query = () =>
      app.rpc("plugin/sql", {
        consumerCode: "branch-inventory",
        sql: "SELECT COUNT(*) AS records FROM agents_scm_safety_stock",
        parameters: {},
        resultShape: "rows",
      });
    assert.equal((await query()).error, undefined);
    const result = await query();
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.value.rows, [{ records: 1 }]);
    assert.equal(sessions, 2);
    assert.deepEqual(sqlTokens, ["delegation-1", "delegation-1", "delegation-2"]);
    failureMode = "bare-401";
    assert.equal((await query()).error, undefined);
    assert.equal(sessions, 3);
    assert.deepEqual(sqlTokens.slice(-2), ["delegation-2", "delegation-3"]);
    failureMode = "forbidden";
    const denied = await query();
    assert.equal(denied.error?.code, "AI_GATEWAY_DATA_PERMISSION_DENIED");
    assert.equal(sessions, 3);
    assert.equal(sqlTokens.at(-1), "delegation-3");
    // Each installed SQL consumer uses the same host renewal path. A fresh
    // delegation can expire on its first query as well as after being cached.
    failureMode = "first-token-expiry";
    sessionBase = sessions;
    for (const consumerCode of [
      "base-safety-stock",
      "dealer-inventory-replenishment",
      "full-chain-inventory",
      "aps",
      "customer-inventory-preview",
      "orderfulfillment-preview",
    ]) {
      const current = await app.rpc("plugin/sql", {
        consumerCode,
        sql: "SELECT COUNT(*) AS records FROM agents_scm_safety_stock",
        parameters: {},
        resultShape: "rows",
      });
      assert.equal(current.error, undefined, `${consumerCode}: ${JSON.stringify(current.error)}`);
      assert.deepEqual(current.value.rows, [{ records: 1 }]);
    }
    assert.equal(sessions, sessionBase + 12);
    failureMode = "login-expired";
    assert.equal((await query()).error?.code, "GEA_HTTP_401");
    assert.equal((await app.rpc("status")).value.authenticated, false);
  },
);

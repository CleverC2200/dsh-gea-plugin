import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { profile } from "./profile.mjs";
import { fixtureWorkbench } from "./fixtures/workbench-profile.mjs";

test(
  "expired cached SQL delegation is renewed once without failing the page",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      bundle: true,
      beforeStart: fixtureWorkbench(
        ["fc", "aqkc", "dealer", "qll", "apsplan", "customer", "orderfulfillment"].map((id) =>
          resolve(`../dsh-agent-workbench/lib/business/inventory-${id}`),
        ),
      ),
    });
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
          result: {
            accessDecision: { allowed: true },
            delegationToken: `delegation-${sessions}`,
          },
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
            result: {
              rows: [{ records: 1 }],
              total: 1,
              pageNo: 1,
              pageSize: 200,
            },
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
    // Installed real SQL consumers share the host renewal path. A fresh
    // delegation can expire on its first query as well as after being cached.
    failureMode = "first-token-expiry";
    sessionBase = sessions;
    const aps = JSON.parse(
      await readFile(
        resolve("../dsh-agent-workbench/lib/business/inventory-apsplan/capability.json"),
        "utf8",
      ),
    );
    assert.equal(aps.data.mock, true, "the CI APS build is explicitly mock-only");
    const customer = JSON.parse(
      await readFile(
        resolve("../dsh-agent-workbench/lib/business/inventory-customer/capability.json"),
        "utf8",
      ),
    );
    assert.notEqual(customer.data.mock, true, "customer inventory is a governed reader");
    assert.equal(customer.data.consumerCode, "customer_inventory");
    assert.ok(customer.data.tables.includes("agents_scm_cust_jxc_ai_daliy_d"));
    for (const consumerCode of [
      "base-safety-stock",
      "dealer-inventory-replenishment",
      "full-chain-inventory",
      "aps",
      customer.data.consumerCode,
      "orderfulfillment-preview",
    ]) {
      const sessionsBefore = sessions,
        queriesBefore = sqlTokens.length;
      const current = await app.rpc("plugin/sql", {
        consumerCode,
        sql:
          consumerCode === customer.data.consumerCode
            ? "SELECT COUNT(*) AS records FROM agents_scm_cust_jxc_ai_daliy_d"
            : "SELECT COUNT(*) AS records FROM agents_scm_safety_stock",
        parameters: {},
        resultShape: "rows",
      });
      if (["aps", "orderfulfillment-preview"].includes(consumerCode)) {
        assert.equal(current.error?.code, "GEA_CAPABILITY_MOCK_ONLY");
        assert.equal(sessions, sessionsBefore);
        assert.equal(sqlTokens.length, queriesBefore);
        continue;
      }
      assert.equal(current.error, undefined, `${consumerCode}: ${JSON.stringify(current.error)}`);
      assert.deepEqual(current.value.rows, [{ records: 1 }]);
      assert.equal(sessions, sessionsBefore + 2);
      assert.equal(sqlTokens.length, queriesBefore + 2);
    }
    assert.equal(sessions, sessionBase + 8);
    failureMode = "login-expired";
    assert.equal((await query()).error?.code, "GEA_HTTP_401");
    assert.equal((await app.rpc("status")).value.authenticated, false);
  },
);

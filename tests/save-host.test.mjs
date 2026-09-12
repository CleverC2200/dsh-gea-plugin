import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "SAVE requires a freshly read server capability for the same effective version and snapshot",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    let mode = "allowed";
    let writes = 0;
    const snapshot = "a".repeat(64);
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans/p")) {
        if (mode === "expired") {
          reply({ message: "expired" }, 401);
          return true;
        }
        reply({
          success: true,
          result: {
            currentVersion: {
              id: mode === "old" ? "other" : "v",
              planId: "p",
              status: 10,
              effective: mode !== "ineffective",
            },
            actionContext:
              mode === "absent"
                ? undefined
                : {
                    versionId: "v",
                    status: 10,
                    allowedActions: mode === "denied" ? [] : ["SAVE"],
                    snapshotHash:
                      mode === "changed" ? "b".repeat(64) : snapshot,
                  },
            skus: [],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/versions/v/actions")) {
        writes++;
        assert.equal(req.headers["x-tenant-id"], "0");
        assert.ok(req.headers["x-access-token"]);
        const body = JSON.parse(req.body);
        assert.equal(body.expectedSnapshot, snapshot);
        assert.equal(body.action, "SAVE");
        if (mode === "conflict") {
          reply({ message: "changed concurrently" }, 409);
          return true;
        }
        if (mode === "backend-denied") {
          reply({ message: "permission denied" }, 403);
          return true;
        }
        if (mode === "lost") {
          mode = "changed";
          res.destroy();
          return true;
        }
        if (mode === "timeout") return true;
        reply({
          success: true,
          result: {
            planId: "p",
            versionId: "v",
            fromStatus: 10,
            toStatus: 10,
            requestId: "r",
            traceId: "t",
            auditId: "sales-plan-log:1",
            replayed: false,
          },
        });
        return true;
      }
    });
    const save = (patch) =>
      app.rpc("sales-plan/action", {
        planId: "p",
        versionId: "v",
        requestId: "r",
        idempotencyKey: "save-intent",
        request: {
          action: "SAVE",
          expectedStatus: 10,
          expectedSnapshot: snapshot,
          adjustments: [{ skuCode: "1", adjustQty: "1.000" }],
          ...patch,
        },
      });
    for (const [scenario, code] of [
      ["absent", "GEA_HTTP_403"],
      ["denied", "GEA_HTTP_403"],
      ["old", "GEA_HTTP_409"],
      ["ineffective", "GEA_HTTP_409"],
      ["changed", "GEA_HTTP_409"],
    ]) {
      mode = scenario;
      assert.equal((await save()).error.code, code);
    }
    assert.equal(writes, 0);
    mode = "allowed";
    assert.equal(
      (await save({ expectedStatus: 5 })).error.code,
      "GEA_HTTP_400",
    );
    assert.equal(writes, 0);
    assert.equal((await save()).ok, true);
    assert.equal(writes, 1);
    mode = "conflict";
    assert.equal((await save()).error.code, "GEA_HTTP_409");
    assert.equal(writes, 2);
    mode = "backend-denied";
    assert.equal((await save()).error.code, "GEA_HTTP_403");
    assert.equal(writes, 3);
    mode = "lost";
    assert.equal((await save()).ok, false);
    assert.equal(writes, 4);
    assert.equal((await save()).error.code, "GEA_HTTP_409");
    assert.equal(writes, 4);
    mode = "timeout";
    assert.equal((await save()).ok, false);
    assert.equal(writes, 5);
    mode = "expired";
    assert.equal((await save()).ok, false);
    assert.equal(writes, 5);
    assert.equal((await app.rpc("status")).value.authenticated, false);
  },
);

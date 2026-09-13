import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "workbench refreshes an exact-version assigned task and fails closed without hiding detail",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let mode = "assigned";
    const meta = {
      biz_key: "sales-plan:version:v",
      instance_id: "i",
      actionable: true,
    };
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans/p")) {
        reply({
          success: true,
          result: {
            currentVersion: {
              id: "v",
              planId: "p",
              status: 1,
              effective: true,
            },
            skus: [],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/notifications")) {
        const second = req.url.searchParams.get("pageNo") === "2";
        reply({
          success: true,
          result: {
            items: second ? [{ id: "n", approval: meta }] : [{ id: "other" }],
            total: 101,
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/notifications/n")) {
        assert.equal(req.method, "GET");
        assert.ok(req.headers["x-access-token"]);
        assert.equal(req.headers["x-tenant-id"], "0");
        if (mode === "failed") reply({ message: "Unavailable" }, 503);
        else
          reply({
            success: true,
            result: {
              id: "n",
              approval: {
                ...meta,
                actionable: mode !== "handled",
                biz_key:
                  mode === "wrong" ? "sales-plan:version:other" : meta.biz_key,
              },
            },
          });
        return true;
      }
    });
    await app.login();
    const read = () =>
      app.rpc("workbench/query", { kind: "detail", query: { planId: "p" } });
    assert.deepEqual((await read()).value.workflowApproval, {
      versionId: "v",
      notificationId: "n",
      instanceId: "i",
      actionable: true,
    });
    for (mode of ["handled", "wrong", "failed"]) {
      const result = await read();
      assert.equal(result.ok, true);
      assert.equal(result.value.currentVersion.id, "v");
      assert.equal(result.value.workflowApproval, undefined);
    }
  },
);

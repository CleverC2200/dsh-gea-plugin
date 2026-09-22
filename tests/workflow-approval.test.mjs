import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "detail reads never scan notifications and never attach an approval identity",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let notificationReads = 0;
    app.route((req, res, reply) => {
      if (req.url.pathname.includes("/api/v1/notifications")) {
        notificationReads += 1;
        reply({
          success: true,
          result: {
            items: [
              {
                id: "n",
                approval: {
                  biz_key: "sales-plan:version:v",
                  instance_id: "i",
                  actionable: true,
                },
              },
            ],
            total: 1,
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/plans/p")) {
        reply({
          success: true,
          result: {
            currentVersion: {
              id: "v",
              planId: "p",
              status: 1,
              planTypeCode: "Y",
              effective: true,
            },
            skus: [],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      return false;
    });
    await app.login();
    const result = await app.rpc("workbench/query", {
      kind: "detail",
      query: { planId: "p" },
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.currentVersion.id, "v");
    assert.equal(result.value.workflowApproval, undefined);
    assert.equal(notificationReads, 0);
  },
);

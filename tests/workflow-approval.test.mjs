import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

/**
 * 上游 approval 段的业务键是驼峰 `bizKey`。历史上按 `biz_key` 读取，导致
 * 「服务端把任务派给我」这条审批身份来源一直静默失效；这里把它钉住。
 */
test(
  "an actionable task assigned to this user is matched by the upstream camelCase bizKey",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    let status = 1;
    let effective = true;
    let notificationCalls = 0;
    let notificationMode = "ok";
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans/p")) {
        reply({
          success: true,
          result: {
            currentVersion: { id: "v", planId: "p", status, effective, planTypeCode: "Y" },
            skus: [],
            versions: [],
            logs: [],
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/notifications")) {
        notificationCalls += 1;
        if (notificationMode === "failed") {
          reply({ message: "Unavailable" }, 503);
          return true;
        }
        reply({
          success: true,
          result: {
            items: [
              {
                id: "n",
                approval: {
                  instanceId: "i",
                  actionable: true,
                  bizKey: "sales-plan:version:v",
                },
              },
            ],
            total: 1,
          },
        });
        return true;
      }
      if (req.url.pathname.endsWith("/notifications/n")) {
        if (notificationMode === "failed") {
          reply({ message: "Unavailable" }, 503);
          return true;
        }
        reply({
          success: true,
          result: {
            id: "n",
            approval: {
              instanceId: "i",
              actionable: true,
              bizKey: "sales-plan:version:v",
            },
          },
        });
        return true;
      }
      return false;
    });
    await app.login();
    const read = () => app.rpc("workbench/query", { kind: "detail", query: { planId: "p" } });

    const assigned = await read();
    assert.equal(assigned.ok, true);
    assert.equal(assigned.value.currentVersion.id, "v");
    assert.deepEqual(assigned.value.workflowApproval, {
      versionId: "v",
      notificationId: "n",
      instanceId: "i",
      actionable: true,
    });

    // 退回态同样要能认；已完成/未提交/待回写不在此列。
    for (const returned of [7, 8, 9]) {
      status = returned;
      assert.equal((await read()).value.workflowApproval?.actionable, true);
    }
    for (const skip of [0, 5, 6, 10]) {
      status = skip;
      assert.equal((await read()).value.workflowApproval, undefined);
    }

    // 版本失效时不再认这张任务。
    status = 1;
    effective = false;
    assert.equal((await read()).value.workflowApproval, undefined);

    // 通知接口读失败不能把业务详情一起打掉，只是不授予审批能力。
    effective = true;
    notificationMode = "failed";
    const failed = await read();
    notificationCalls += 0;
    assert.equal(failed.ok, true);
    assert.equal(failed.value.currentVersion.id, "v");
    assert.equal(failed.value.workflowApproval, undefined);
    assert.ok(notificationCalls >= 1);
  },
);

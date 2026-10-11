import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

/**
 * 通知只是提醒：它既不授予审批身份，也不参与节点判定。
 * 身份只认账号角色，所以读业务详情时不该再去扫通知中心——既省一趟接口，
 * 也保证通知服务抖动时不会把详情和审批一起打掉。这条把「不再耦合」钉住。
 */
const appWithCounter = async (t, options) => {
  const app = await profile(t, options);
  let notificationReads = 0;
  app.route((req, res, reply) => {
    const path = req.url.pathname;
    if (path.endsWith("/notifications")) {
      notificationReads += 1;
      reply({ success: true, result: { items: [], total: 0 } });
      return true;
    }
    // 上游故意派了同版本可处理任务：新口径下它不能变成审批身份。
    if (path.endsWith("/plans/p")) {
      reply({
        success: true,
        result: {
          currentVersion: { id: "v", planId: "p", status: 2, effective: true, planTypeCode: "Y" },
          skus: [],
          versions: [],
          logs: [],
          workflowApproval: {
            versionId: "v",
            notificationId: "n",
            instanceId: "i",
            actionable: true,
          },
        },
      });
      return true;
    }
    return false;
  });
  await app.login();
  return { app, reads: () => notificationReads };
};

test(
  "reading a plan detail never scans notifications for approval identity",
  { timeout: 60000 },
  async (t) => {
    const { app, reads } = await appWithCounter(t, {
      roles: [{ code: "sales_plan_region_approver", name: "区域审批" }],
    });
    const value = (await app.rpc("workbench/query", { kind: "detail", query: { planId: "p" } }))
      .value;
    assert.equal(value.currentVersion.id, "v");
    // 通知字段已从投影里删除：上游塞什么都不再冒出来当审批依据。
    assert.equal(value.workflowApproval, undefined);
    assert.equal(reads(), 0);
  },
);

test(
  "a plan detail stays readable when the account has no approval role and no notification",
  { timeout: 60000 },
  async (t) => {
    const { app, reads } = await appWithCounter(t, { roles: [] });
    const result = await app.rpc("workbench/query", { kind: "detail", query: { planId: "p" } });
    assert.equal(result.ok, true);
    assert.equal(result.value.currentVersion.id, "v");
    assert.equal(result.value.workflowApproval, undefined);
    assert.equal(reads(), 0);
  },
);

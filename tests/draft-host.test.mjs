import test from "./fixtures/source-test.mjs";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "Host saves a private draft for every shape the workbench can edit",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    const snapshot = "a".repeat(64);
    const sku = {
      id: "s",
      skuCode: "1001",
      versionId: "v",
      qty: "22",
      regionConfirmedQty: null,
      provinceConfirmedQty: "8",
      amt: "1132.72",
      price: "141.59",
    };
    let mode = "multi-role";
    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode")) return send({ codeList: [] });
      if (path.endsWith("/notifications/n"))
        return send({
          id: "n",
          approval: { biz_key: "sales-plan:version:v", instance_id: "i", actionable: true },
        });
      if (path.endsWith("/notifications"))
        return send(
          mode === "workflow-task"
            ? {
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
              }
            : { items: [], total: 0 },
        );
      if (path.endsWith("/plans/p")) {
        const actionContext =
          mode === "workflow-task"
            ? undefined
            : {
                versionId: "v",
                status: 2,
                snapshotHash: snapshot,
                policy: "role-visible-v1",
                allowedActions: [],
                roleActions: (mode === "multi-role" ? ["region", "province"] : ["region"]).map(
                  (role) => ({ role, allowedActions: ["SAVE", "APPROVE", "REJECT"] }),
                ),
              };
        return send({
          currentVersion: { id: "v", planId: "p", status: 2, effective: true, planTypeCode: "Y" },
          skus: [sku],
          versions: [],
          logs: [],
          ...(actionContext ? { actionContext } : {}),
        });
      }
      return false;
    });
    await app.login();
    const draftOf = async () =>
      (await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" })).value;
    const source = await draftOf();
    assert.equal(typeof source.sourceSnapshot, "string");
    const write = (approvalRole, adjustQty, extra = {}) =>
      app.rpc("sales-plan/draft", {
        planId: "p",
        versionId: "v",
        ...(approvalRole ? { approvalRole } : {}),
        draft: {
          planId: "p",
          versionId: "v",
          status: 2,
          sourceSnapshot: source.sourceSnapshot,
          remark: "",
          adjustments: [{ skuCode: "1001", adjustQty }],
          ...(approvalRole ? { role: approvalRole } : {}),
        },
        ...extra,
      });

    const multiRole = await write("province", "2");
    assert.equal(multiRole.ok, true, JSON.stringify(multiRole));
    assert.deepEqual((await draftOf()).draft.adjustments, [{ skuCode: "1001", adjustQty: "2" }]);

    assert.equal((await write(undefined, "2")).ok, true);

    const regionView = await write("region", "-12");
    assert.equal(regionView.ok, true, JSON.stringify(regionView));
    assert.deepEqual((await draftOf()).draft.adjustments, [{ skuCode: "1001", adjustQty: "-12" }]);

    const negative = await write("province", "-20");
    assert.equal(negative.ok, false, "负数结果仍必须被拒绝");
    assert.deepEqual((await draftOf()).draft.adjustments, [{ skuCode: "1001", adjustQty: "-12" }]);

    const forged = await write("province", "2", {
      draft: {
        planId: "p",
        versionId: "v",
        status: 2,
        sourceSnapshot: "forged",
        remark: "",
        adjustments: [{ skuCode: "1001", adjustQty: "2" }],
        role: "province",
      },
    });
    assert.equal(forged.ok, false);
    assert.deepEqual((await draftOf()).draft.adjustments, [{ skuCode: "1001", adjustQty: "-12" }]);

    assert.equal((await write("admin", "2")).ok, false);

    mode = "workflow-task";
    const workflowTask = await write("province", "2");
    assert.equal(workflowTask.ok, true, JSON.stringify(workflowTask));
  },
);

test(
  "Host stores a private draft for a readable returned plan without approval capability",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);

    app.route((req, _res, reply) => {
      const path = req.url.pathname;
      const send = (result) => {
        reply({ success: true, result });
        return true;
      };
      if (path.endsWith("/getPermCode"))
        return send({ codeList: ["sales-plan:plan:province-approve"] });
      if (path.endsWith("/notifications")) return send({ items: [], total: 0 });
      if (path.endsWith("/plans/p"))
        return send({
          currentVersion: { id: "v", planId: "p", status: 8, effective: true, planTypeCode: "Y" },
          skus: [
            {
              id: "s",
              skuCode: "1001",
              versionId: "v",
              qty: "22",
              regionConfirmedQty: "8",
              amt: "1132.72",
              price: "141.59",
            },
          ],
          versions: [],
          logs: [],
        });
      return false;
    });
    await app.login();
    const source = (await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" })).value;
    const result = await app.rpc("sales-plan/draft", {
      planId: "p",
      versionId: "v",
      approvalRole: "province",
      draft: {
        planId: "p",
        versionId: "v",
        status: 8,
        sourceSnapshot: source.sourceSnapshot,
        remark: "",
        adjustments: [{ skuCode: "1001", adjustQty: "2" }],
        role: "province",
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(
      (await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" })).value.draft.adjustments,
      [{ skuCode: "1001", adjustQty: "2" }],
    );

    const negative = await app.rpc("sales-plan/draft", {
      planId: "p",
      versionId: "v",
      approvalRole: "province",
      draft: {
        planId: "p",
        versionId: "v",
        status: 8,
        sourceSnapshot: source.sourceSnapshot,
        remark: "",
        adjustments: [{ skuCode: "1001", adjustQty: "-20" }],
        role: "province",
      },
    });
    assert.equal(negative.ok, false, "负数结果仍必须被拒绝");
    const forged = await app.rpc("sales-plan/draft", {
      planId: "p",
      versionId: "v",
      approvalRole: "province",
      draft: {
        planId: "p",
        versionId: "v",
        status: 8,
        sourceSnapshot: "forged",
        remark: "",
        adjustments: [{ skuCode: "1001", adjustQty: "2" }],
        role: "province",
      },
    });
    assert.equal(forged.ok, false, "伪造快照仍必须被拒绝");
    assert.deepEqual(
      (await app.rpc("sales-plan/draft", { planId: "p", versionId: "v" })).value.draft.adjustments,
      [{ skuCode: "1001", adjustQty: "2" }],
    );
  },
);

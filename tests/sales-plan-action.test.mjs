import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

const output = await build({
  entryPoints: ["src/host/business.ts"],
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
  logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", output.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);

function fixture(t, actionReply) {
  const business = new module.exports.Business({
    geaBaseUrl: "https://localhost",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    inputByteBudget: 30000,
    pageSize: 20,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://localhost",
    auth: {
      token: "fixture-token",
      tenantId: "1",
      name: "Test",
      id: "user-1",
      username: "test",
      roles: [{ code: "sales_plan_category_approver", name: "品类审批" }],
    },
  });
  t.after(() => business.dispose());
  let status = 4,
    effective = true,
    writes = 0,
    attempt = 0;
  const snapshot = "a".repeat(64);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(url).pathname;
    let result;
    if (path.endsWith("/getPermCode")) result = { codeList: ["sales-plan:plan:category-approve"] };
    else if (path.endsWith("/plans/p"))
      result = {
        currentVersion: {
          id: "v",
          planId: "p",
          status,
          effective,
          planTypeCode: "Y",
        },
        skus: [],
        versions: [],
        logs: [],
        actionContext: {
          versionId: "v",
          status,
          nodeOrder: 5,
          allowedActions: ["SAVE"],
          snapshotHash: snapshot,
          policy: "role-visible-v1",
          roleActions: [{ role: "category", allowedActions: ["SAVE"] }],
        },
      };
    else if (path.endsWith("/actions")) {
      writes++;
      if (actionReply) return actionReply(url, init);
      result = {
        planId: "p",
        versionId: "v",
        fromStatus: status,
        toStatus: status,
        requestId: init.headers["X-Request-Id"],
        traceId: "trace",
        auditId: "audit",
        replayed: false,
      };
    } else if (path.endsWith("/agent/session"))
      result = {
        accessDecision: { allowed: true },
        delegationToken: "fixture-delegation",
        gatewayContext: { sessionId: "fixture-session" },
      };
    else if (path.endsWith("/current-user/resolve"))
      result = {
        success: true,
        roles: [{ code: "sales_plan_category_approver", name: "品类审批" }],
      };
    else if (path.endsWith("/sql/execute")) {
      const body = JSON.parse(init.body);
      const rows = ["0", "1", "2", "3", "4", "Y"].map((node, level) => ({
        id: level + 1,
        type_code: "Y",
        examine_level: String(level),
        node_num: node,
      }));
      result = {
        requestId: init.headers["X-Request-Id"],
        operation: "SELECT",
        tables: ["agents_scm_plan_workflow_config"],
        total: rows.length,
        pageNo: body.pageNo,
        pageSize: body.pageSize,
        rows,
      };
    } else throw Error("Unexpected fixture route: " + path);
    return Response.json({ success: true, code: 200, result });
  });
  const payload = (patch = {}) => ({
    planId: "p",
    versionId: "v",
    requestId: `save-${++attempt}`,
    idempotencyKey: `save-${attempt}`,
    request: {
      action: "SAVE",
      expectedStatus: status,
      expectedSnapshot: snapshot,
      adjustments: [{ skuCode: "789", adjustQty: "1.000" }],
      ...patch,
    },
  });
  return {
    business,
    payload,
    writes: () => writes,
    status: (value) => {
      status = value;
    },
    effective: (value) => {
      effective = value;
    },
  };
}

test("SAVE refuses 0, 5 and 10 even when the server advertises matching SAVE capabilities", async (t) => {
  const f = fixture(t);
  for (const status of [0, 5, 10]) {
    f.status(status);
    for (const role of [undefined, "category"])
      await assert.rejects(
        f.business.salesPlanAction(
          f.payload({
            approvalRole: role,
            ...(role ? { approvalPolicy: "role-visible-v1" } : {}),
          }),
          new AbortController().signal,
        ),
      );
  }
  assert.equal(f.writes(), 0);
});

test("SAVE requires a role and refuses historical versions with matching status and capabilities", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.business.salesPlanAction(f.payload(), new AbortController().signal),
    /角色/,
  );
  f.effective(false);
  await assert.rejects(
    f.business.salesPlanAction(
      f.payload({
        approvalRole: "category",
        approvalPolicy: "role-visible-v1",
      }),
      new AbortController().signal,
    ),
  );
  assert.equal(f.writes(), 0);
});

test("explicit role SAVE keeps its snapshot, authorization and one idempotent intent", async (t) => {
  const f = fixture(t);
  const payload = f.payload({
    approvalRole: "category",
    approvalPolicy: "role-visible-v1",
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const receipt = await f.business.salesPlanAction(payload, signal);
  assert.equal(receipt.toStatus, 4);
  assert.deepEqual(await f.business.salesPlanAction(payload, signal), receipt);
  assert.equal(f.writes(), 1);
  await assert.rejects(
    f.business.salesPlanAction(
      {
        ...payload,
        request: { ...payload.request, remark: "different intent" },
      },
      signal,
    ),
    /幂等键/,
  );
  await assert.rejects(
    f.business.salesPlanAction(
      f.payload({
        approvalRole: "category",
        approvalPolicy: "role-visible-v1",
        expectedSnapshot: "b".repeat(64),
      }),
      signal,
    ),
    /依据已变化/,
  );
  assert.equal(f.writes(), 1);
});

test("a late approval 401 cannot expire a replacement login", async (t) => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = fixture(t, async () => {
    entered();
    await new Promise((done) => {
      release = done;
    });
    return Response.json({ message: "old login expired" }, { status: 401 });
  });
  await f.business.refreshApprovalRoles(new AbortController().signal);
  const pending = f.business.salesPlanAction(
    f.payload({
      approvalRole: "category",
      approvalPolicy: "role-visible-v1",
    }),
    new AbortController().signal,
  );
  await started;
  f.business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://localhost",
    auth: {
      token: "replacement-token",
      tenantId: "1",
      name: "Replacement",
      id: "user-2",
      username: "replacement",
    },
  });
  release();
  await assert.rejects(pending);
  assert.equal(f.business.status().authenticated, true);
  assert.equal(f.business.status().user.id, "user-2");
  assert.equal(f.writes(), 1);
});

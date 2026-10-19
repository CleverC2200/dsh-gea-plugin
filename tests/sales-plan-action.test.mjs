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

function fixture(t, actionReply, detailGate) {
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
    if (path.endsWith("/plans/p")) await detailGate?.();
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

test("unavailable employee resubmission refuses before token exchange, internal submission or approval", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.business.salesPlanSubmit(
      {
        source: { planId: "p", versionId: "v" },
        requestId: "resubmit-unavailable",
        idempotencyKey: "resubmit-unavailable",
        request: {
          orderType: "M",
          status: 2,
          periodId: "20261001",
          periodMonth: "2026-10",
          planTypeCode: "Y",
          channelCode: "jxs",
          dealerCode: "456",
          targetQty: "1.000",
          targetAmount: "12.34",
          submitterCode: "user-1",
          submitterName: "Test",
          items: [{ skuCode: "789", baseQty: "1.000", qty: "2.000", price: "12.34" }],
        },
      },
      new AbortController().signal,
    ),
    (error) => error.code === "GEA_HTTP_403" && /重提入口尚未就绪|权限不足/.test(error.message),
  );
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

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

test("concurrent approval retries preserve one validated body and share the receipt", async (t) => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const sent = [];
  const f = fixture(t, async (_url, init) => {
    sent.push({
      body: init.body,
      key: init.headers["Idempotency-Key"],
      request: init.headers["X-Request-Id"],
    });
    entered();
    await new Promise((done) => {
      release = done;
    });
    return Response.json({
      success: true,
      result: { planId: "p", versionId: "v", requestId: "save-1", replayed: false },
    });
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const command = f.payload({ approvalRole: "category", approvalPolicy: "role-visible-v1" });
  const first = f.business.salesPlanAction(command, signal);
  const second = f.business.salesPlanAction(command, signal);
  await started;
  await assert.rejects(
    f.business.salesPlanAction(
      { ...command, request: { ...command.request, remark: "different" } },
      signal,
    ),
    /幂等键/,
  );
  assert.equal(f.writes(), 1);
  assert.equal(sent[0].key, "save-1");
  assert.equal(sent[0].request, "save-1");
  assert.deepEqual(JSON.parse(sent[0].body), {
    action: "SAVE",
    expectedStatus: 4,
    adjustments: [{ skuCode: "789", adjustQty: "1.000" }],
    approvalRole: "category",
    approvalPolicy: "role-visible-v1",
    expectedSnapshot: "a".repeat(64),
  });
  release();
  const receipt = await first;
  assert.deepEqual(await second, receipt);
  assert.deepEqual(await f.business.salesPlanAction(command, signal), receipt);
  assert.equal(f.writes(), 1);
});

test("a current approval 401 expires only its own login", async (t) => {
  const f = fixture(t, async () => Response.json({ message: "expired" }, { status: 401 }));
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  await assert.rejects(
    f.business.salesPlanAction(
      f.payload({ approvalRole: "category", approvalPolicy: "role-visible-v1" }),
      signal,
    ),
    /GEA_HTTP_401/,
  );
  assert.equal(f.business.status().authenticated, false);
  assert.equal(f.business.status().loginState, "expired");
  assert.equal(f.writes(), 1);
});

test("approval intent snapshots caller payload before awaiting source validation", async (t) => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const bodies = [];
  const f = fixture(
    t,
    async (_url, init) => {
      bodies.push({
        body: init.body,
        requestId: init.headers["X-Request-Id"],
        key: init.headers["Idempotency-Key"],
      });
      return Response.json({
        success: true,
        result: { planId: "p", versionId: "v", requestId: "save-1" },
      });
    },
    async () => {
      entered();
      await new Promise((done) => {
        release = done;
      });
    },
  );
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const payload = f.payload({ approvalRole: "category", approvalPolicy: "role-visible-v1" });
  const original = structuredClone(payload);
  const pending = f.business.salesPlanAction(payload, signal);
  await started;
  payload.request.adjustments[0].adjustQty = "999.000";
  payload.request.remark = "changed while validating";
  payload.requestId = "changed-request";
  payload.idempotencyKey = "changed-key";
  release();
  const receipt = await pending;
  assert.equal(bodies[0].requestId, "save-1");
  assert.equal(bodies[0].key, "save-1");
  assert.equal(JSON.parse(bodies[0].body).adjustments[0].adjustQty, "1.000");
  assert.equal(JSON.parse(bodies[0].body).remark, undefined);
  assert.deepEqual(await f.business.salesPlanAction(original, signal), receipt);
  assert.equal(f.writes(), 1);
});

test("a late approval receipt cannot replace the new login's same-key receipt", async (t) => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = fixture(t, async (_url, init) => {
    const old = init.headers["X-Access-Token"] === "fixture-token";
    if (old) {
      entered();
      await new Promise((done) => {
        release = done;
      });
    }
    return Response.json({
      success: true,
      result: { planId: "p", versionId: "v", owner: old ? "old" : "replacement" },
    });
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const payload = f.payload({ approvalRole: "category", approvalPolicy: "role-visible-v1" });
  const old = f.business.salesPlanAction(payload, signal);
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
  await f.business.refreshApprovalRoles(signal);
  const current = await f.business.salesPlanAction(payload, signal);
  assert.equal(current.owner, "replacement");
  release();
  await assert.rejects(old);
  assert.deepEqual(await f.business.salesPlanAction(payload, signal), current);
  assert.equal(f.business.status().user.id, "user-2");
  assert.equal(f.writes(), 2);
});

test("public Business resubmits returned M with opaque period 17, separate service identity and nullable audit receipt", async (t) => {
  process.env.GEA_CONTRACT_CLIENT = "contract-client";
  process.env.GEA_CONTRACT_SECRET = "contract-secret";
  t.after(() => {
    delete process.env.GEA_CONTRACT_CLIENT;
    delete process.env.GEA_CONTRACT_SECRET;
  });
  const business = new module.exports.Business({
    geaBaseUrl: "https://localhost",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    inputByteBudget: 30000,
    pageSize: 20,
    periodPageSize: 100,
    serviceAccounts: {
      production: {
        clientIdEnv: "GEA_CONTRACT_CLIENT",
        clientSecretEnv: "GEA_CONTRACT_SECRET",
        tenantId: "1",
        allowedUserIds: ["user-1"],
      },
    },
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://localhost",
    auth: {
      token: "employee-token",
      tenantId: "1",
      name: "Test",
      id: "user-1",
      username: "test",
      roles: [{ code: "sales_plan_region_approver", name: "区域审批" }],
    },
  });
  t.after(() => business.dispose());
  const planId = "p-jxs-2026-10-00001";
  const version = {
    id: "v1",
    planId,
    periodId: "17",
    planTypeCode: "Y",
    orderType: "M",
    status: 7,
    effective: true,
    seq: 1,
    dealerCode: "456",
    targetQty: "1.000",
    targetAmount: "12.34",
  };
  const sku = {
    id: "s1",
    versionId: "v1",
    skuCode: "789",
    productCategName: "Category",
    baseQty: "1.000",
    qty: "2.000",
    price: "12.3400",
    amt: "24.68",
    amtBase: "12.34",
  };
  const request = {
    orderType: "M",
    status: 2,
    periodId: "17",
    periodMonth: "2026-10",
    planTypeCode: "Y",
    channelCode: "jxs",
    dealerCode: "456",
    targetQty: "1.000",
    targetAmount: "12.34",
    submitterCode: "user-1",
    submitterName: "test",
    items: [
      {
        skuCode: "789",
        productCategName: "Category",
        baseQty: "1.000",
        qty: "2.000",
        price: "12.3400",
      },
    ],
  };
  let tokens = 0,
    writes = 0,
    refuse = false;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/api/v1/internal/auth/token")) {
      tokens++;
      assert.equal(init.headers["X-Access-Token"], undefined);
      return Response.json({
        success: true,
        result: {
          access_token: "service-" + tokens,
          token_type: "Bearer",
          expires_in: 600,
          scope: "sales-plan:write",
        },
      });
    }
    if (path.endsWith("/api/v1/internal/sales-plans")) {
      writes++;
      assert.equal(init.headers.Authorization, "Bearer service-" + tokens);
      assert.equal(init.headers["X-Access-Token"], undefined);
      assert.deepEqual(JSON.parse(init.body), request);
      if (refuse)
        return Response.json(
          { errorCode: "UNAUTHORIZED", message: "服务授权失效", traceId: "service-failure" },
          { status: 401 },
        );
      return Response.json({
        success: true,
        result: {
          planId,
          versionId: "v2",
          seq: 2,
          status: 2,
          replayed: false,
          requestId: init.headers["X-Request-Id"],
          traceId: "trace",
          auditId: null,
        },
      });
    }
    if (!path.endsWith("/sql/execute"))
      assert.equal(init.headers["X-Access-Token"], "employee-token");
    assert.equal(init.headers.Authorization, undefined);
    let result;
    if (path.endsWith("/getPermCode")) result = { codeList: ["sales-plan:plan:region-approve"] };
    else if (path.endsWith("/plans/" + planId))
      result = { currentVersion: version, versions: [version], skus: [sku], logs: [] };
    else if (path.endsWith("/versions/v1/skus")) result = [sku];
    else if (path.endsWith("/plans"))
      result = {
        records: [{ ...version, versionId: "v1" }],
        total: 1,
        pages: 1,
        current: 1,
        size: 200,
      };
    else if (path.endsWith("/agent/session"))
      result = {
        accessDecision: { allowed: true },
        delegationToken: "delegation",
        gatewayContext: { sessionId: "session" },
      };
    else if (path.endsWith("/current-user/resolve"))
      result = { success: true, roles: [{ code: "sales_plan_region_approver", name: "区域审批" }] };
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
    } else throw Error("Unexpected contract route: " + path);
    return Response.json({ success: true, code: 200, result });
  });
  const command = (id) => ({
    source: { planId, versionId: "v1" },
    request,
    requestId: id,
    idempotencyKey: id,
  });
  const signal = new AbortController().signal;
  await business.refreshApprovalRoles(signal);
  const receipt = await business.salesPlanSubmit(command("first"), signal);
  assert.equal(receipt.auditId, null);
  assert.equal(receipt.status, 2);
  await business.salesPlanSubmit(command("second"), signal);
  assert.equal(tokens, 1);
  assert.equal(writes, 2);
  refuse = true;
  await assert.rejects(
    business.salesPlanSubmit(command("service-failure"), signal),
    (error) => error.details.authentication === "service",
  );
  assert.equal(writes, 4);
  assert.equal(tokens, 2);
  assert.equal(business.status().loginState, "authenticated");
  const records = business
    .apiLogSnapshot({})
    .records.filter((record) =>
      ["service.submit", "plans.detail", "plans.version-skus"].includes(record.catalogId),
    );
  assert.ok(records.length > 0);
  assert.equal(
    records.some((record) => record.replayAvailable),
    false,
  );
  assert.equal(JSON.stringify(records).includes('"789"'), false);
  assert.equal(JSON.stringify(records).includes("contract-secret"), false);
});

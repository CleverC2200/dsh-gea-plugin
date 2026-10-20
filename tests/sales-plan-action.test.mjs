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

function fixture(t, actionReply, detailGate, detailPatch = {}, listPage, workflowRows) {
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
    if (path.endsWith("/plans/p")) await detailGate?.(url);
    let result;
    if (path.endsWith("/getPermCode")) result = { codeList: ["sales-plan:plan:category-approve"] };
    else if (path.endsWith("/plans"))
      result = typeof listPage === "function" ? listPage(url) : listPage;
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
        ...detailPatch,
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
      const rows =
        workflowRows ??
        ["0", "1", "2", "3", "4", "Y"].map((node, level) => ({
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

function correctionFixture(t, actionReply) {
  const detail = {
    currentVersion: {
      id: "v",
      planId: "p",
      status: 4,
      effective: true,
      planTypeCode: "Y",
      orderType: "Z",
      submitter: "other-user",
    },
    skus: [
      {
        id: "s",
        versionId: "v",
        skuCode: "789",
        qty: "100.000",
        corrBaseQty: "100.000",
        price: "0.005",
        amt: "0.51",
        nodeAdjAddQty: "2.000",
        nodeAdjCutQty: "0.000",
        editable: true,
      },
    ],
    actionContext: {
      versionId: "v",
      status: 4,
      nodeOrder: 5,
      allowedActions: ["SAVE", "APPROVE", "REJECT"],
      snapshotHash: "a".repeat(64),
    },
    correctionContext: {
      contract: "absolute-net-v1",
      monthlyApproved: true,
      approvalOpen: true,
    },
  };
  const f = fixture(t, actionReply, undefined, detail);
  return {
    ...f,
    detail,
    payload: (patch = {}) =>
      f.payload({
        action: "APPROVE",
        approvalRole: "category",
        adjustments: [{ skuCode: "789", adjustQty: "8" }],
        ...patch,
      }),
  };
}

test("Z approval uses the current environment workflow for a newly configured skipped-node type", async (t) => {
  let body;
  const f = fixture(
    t,
    async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ success: true, result: { approved: true } });
    },
    undefined,
    {
      currentVersion: {
        id: "v",
        planId: "p",
        orderType: "Z",
        planTypeCode: "NEW",
        effective: true,
        status: 4,
      },
      actionContext: undefined,
    },
    undefined,
    ["0", "1", "4", "Y"].map((node, level) => ({
      id: level + 1,
      type_code: "NEW",
      examine_level: String(level),
      node_num: node,
    })),
  );
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  assert.deepEqual(
    await f.business.salesPlanAction(
      f.payload({
        action: "APPROVE",
        approvalRole: "category",
        expectedStatus: 4,
        expectedSnapshot: undefined,
        adjustments: undefined,
      }),
      signal,
    ),
    { approved: true },
  );
  assert.deepEqual(body, { action: "APPROVE", expectedStatus: 4 });
});

test("Z adjustments stay local and cannot SAVE through the remote action endpoint", async (t) => {
  const f = correctionFixture(t);
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  await assert.rejects(
    f.business.salesPlanAction(f.payload({ action: "SAVE" }), signal),
    (error) => error.code === "GEA_HTTP_400" && /本地暂存/.test(error.message),
  );
  assert.equal(f.writes(), 0);
});

test("Z approval reuses monthly action authority and original body without correction extensions", async (t) => {
  let sent;
  const f = correctionFixture(t, async (url, init) => {
    sent = { path: new URL(url).pathname, body: JSON.parse(init.body) };
    return Response.json({ success: true, result: { approved: true } });
  });
  f.detail.actionContext = undefined;
  f.detail.correctionContext = undefined;
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  assert.deepEqual(
    await f.business.salesPlanAction(
      f.payload({ action: "APPROVE", adjustmentMode: undefined, expectedSnapshot: undefined }),
      signal,
    ),
    { approved: true },
  );
  assert.deepEqual(sent, {
    path: "/sales-plan/plans/versions/v/actions",
    body: {
      action: "APPROVE",
      expectedStatus: 4,
      adjustments: [{ skuCode: "789", adjustQty: "8" }],
    },
  });
});

test("Z rejection uses the original monthly action body and requires its reason", async (t) => {
  let body;
  const f = correctionFixture(t, async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ success: true, result: { rejected: true } });
  });
  f.detail.actionContext = undefined;
  f.detail.correctionContext = undefined;
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const request = { action: "REJECT", expectedSnapshot: undefined, adjustments: undefined };
  await assert.rejects(f.business.salesPlanAction(f.payload(request), signal));
  assert.equal(f.writes(), 0);
  assert.deepEqual(
    await f.business.salesPlanAction(f.payload({ ...request, remark: "请核对调整数量" }), signal),
    { rejected: true },
  );
  assert.deepEqual(body, { action: "REJECT", expectedStatus: 4, remark: "请核对调整数量" });
});

test("Z approval keeps monthly role and snapshot checks without correction metadata", async (t) => {
  let sent;
  const f = correctionFixture(t, async (url, init) => {
    sent = { path: new URL(url).pathname, body: JSON.parse(init.body) };
    return Response.json({ success: true, result: { approved: true } });
  });
  f.detail.correctionContext = undefined;
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  assert.deepEqual(await f.business.salesPlanAction(f.payload(), signal), { approved: true });
  assert.deepEqual(sent, {
    path: "/sales-plan/plans/versions/v/actions",
    body: {
      action: "APPROVE",
      expectedStatus: 4,
      adjustments: [{ skuCode: "789", adjustQty: "8" }],
    },
  });
  await assert.rejects(
    f.business.salesPlanAction(f.payload({ expectedSnapshot: "b".repeat(64) }), signal),
    /依据已变化/,
  );
  await assert.rejects(
    f.business.salesPlanAction(f.payload({ approvalRole: undefined }), signal),
    /审批角色/,
  );
  assert.equal(f.writes(), 1);
});

test("correction readback preserves frozen amounts, all six node fields and server capabilities", async (t) => {
  const f = correctionFixture(t);
  Object.assign(f.detail.skus[0], {
    regionAdjAddQty: "8.000",
    regionAdjCutQty: "0.000",
    regionAdjAddAmount: "0.04",
    regionAdjCutAmount: "0.00",
    regionConfirmedQty: "108.000",
    regionConfirmedAmount: "0.55",
    provinceAdjAddQty: "0.000",
    provinceAdjCutQty: "3.000",
    provinceAdjAddAmount: "0.00",
    provinceAdjCutAmount: "0.02",
    provinceConfirmedQty: "97.000",
    provinceConfirmedAmount: "0.49",
    areaAdjAddQty: null,
    areaAdjCutQty: null,
    areaAdjAddAmount: null,
    areaAdjCutAmount: null,
    areaConfirmedQty: null,
    areaConfirmedAmount: null,
    categoryAdjAddQty: "0.000",
    categoryAdjCutQty: "0.000",
    categoryAdjAddAmount: "0.00",
    categoryAdjCutAmount: "0.00",
    categoryConfirmedQty: null,
    categoryConfirmedAmount: null,
    editable: false,
  });
  const signal = new AbortController().signal;
  const detail = await f.business.workbenchQuery(
    { kind: "detail", query: { planId: "p" } },
    signal,
  );
  assert.deepEqual(detail.skus, f.detail.skus);
  assert.deepEqual(detail.actionContext, f.detail.actionContext);
  assert.deepEqual(detail.correctionContext, f.detail.correctionContext);
  assert.equal(f.writes(), 0);
});

test("unknown correction write retries its frozen body and key without revalidating changed source", async (t) => {
  const bodies = [];
  const f = correctionFixture(t, async (_url, init) => {
    bodies.push({ key: init.headers["Idempotency-Key"], body: init.body });
    if (bodies.length === 1) throw new TypeError("isolated response lost");
    return Response.json({ success: true, result: { replayed: true } });
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const payload = f.payload();
  await assert.rejects(f.business.salesPlanAction(payload, signal), /isolated response lost/);
  f.detail.actionContext.snapshotHash = "b".repeat(64);
  f.detail.actionContext.allowedActions = [];
  assert.deepEqual(await f.business.salesPlanAction(payload, signal), { replayed: true });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[1].body), {
    action: "APPROVE",
    expectedStatus: 4,
    adjustments: [{ skuCode: "789", adjustQty: "8" }],
  });
});

test("Z actions reuse monthly adjustment format and duplicate checks", async (t) => {
  const f = correctionFixture(t);
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  for (const adjustments of [
    [{ skuCode: "789", adjustQty: "1000000000000000" }],
    [{ skuCode: "789", adjustQty: "0.0001" }],
    [{ skuCode: "invalid", adjustQty: "8" }],
    [
      { skuCode: "789", adjustQty: "8" },
      { skuCode: "789", adjustQty: "8" },
    ],
  ]) {
    await assert.rejects(f.business.salesPlanAction(f.payload({ adjustments }), signal));
  }
  assert.equal(f.writes(), 0);
});

test("Z actions retain monthly version, role and server capability protection", async (t) => {
  const f = correctionFixture(t);
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const original = structuredClone(f.detail);
  for (const patch of [
    { currentVersion: { ...original.currentVersion, id: "historical" } },
    { currentVersion: { ...original.currentVersion, effective: false } },
    { currentVersion: { ...original.currentVersion, status: 3 } },
    { actionContext: { ...original.actionContext, versionId: "historical" } },
    { actionContext: { ...original.actionContext, allowedActions: [] } },
  ]) {
    Object.assign(f.detail, original, patch);
    await assert.rejects(f.business.salesPlanAction(f.payload(), signal));
  }
  Object.assign(f.detail, original);
  await assert.rejects(
    f.business.salesPlanAction(f.payload({ approvalRole: "region" }), signal),
    /操作权限/,
  );
  assert.equal(f.writes(), 0);
});

test("Host list preserves plan totals and summary while unavailable shipment source stays unknown", async (t) => {
  const row = {
    planId: "p",
    versionId: "v",
    periodId: "period",
    targetAmount: "1000.00",
    mPlanQty: "100.000",
    mPlanAmount: "800.00",
    shipQty: "60.000",
    shipAmount: "600.00",
    corrPlanQty: "120.000",
    corrPlanAmount: "1000.00",
    prevAdjAddQty: "20.000",
    prevAdjCutQty: "0.000",
    amountProgress: "60.0",
    correctionProgress: "100.0",
    monthlyApproved: true,
    hasCorrection: true,
  };
  const summary = {
    targetAmount: "2000.00",
    planAmount: "1900.00",
    diffAmount: "-100.00",
    planQty: "230.000",
  };
  const f = fixture(
    t,
    undefined,
    undefined,
    {},
    {
      records: [row],
      total: 1,
      size: 20,
      current: 1,
      pages: 1,
      summary,
    },
  );
  const result = await f.business.workbenchQuery(
    {
      kind: "list",
      query: { periodId: "period", orderType: "Z", planTypeCode: "Y" },
    },
    new AbortController().signal,
  );
  assert.deepEqual(result.records, [
    {
      ...row,
      shipQty: null,
      shipAmount: null,
      amountProgress: null,
      shipmentError: "未取得该客户期间的发货数据",
    },
  ]);
  assert.deepEqual(result.summary, summary);
  assert.equal(f.writes(), 0);
});

test("Host serializes full-queue summary IDs without replacing existing list filters", async (t) => {
  let received;
  const summary = {
    targetAmount: "1000.00",
    planAmount: "900.00",
    diffAmount: "-100.00",
    planQty: "90.000",
  };
  const groupMetrics = [
    {
      dimension: "region",
      key: "r",
      ...summary,
      amountProgress: "60.0",
      shipAmount: "600.00",
      shipQty: "60.000",
    },
  ];
  const f = fixture(t, undefined, undefined, {}, (url) => {
    received = new URL(url);
    return { records: [], total: 0, size: 20, current: 1, pages: 0, summary, groupMetrics };
  });
  const result = await f.business.workbenchQuery(
    {
      kind: "list",
      query: {
        versionIds: ["11", "22", "11"],
        summaryOnly: true,
        periodId: "period",
        status: 1,
        orderType: "Z",
        planTypeCode: "Y",
      },
    },
    new AbortController().signal,
  );
  assert.equal(received.pathname, "/sales-plan/plans");
  assert.equal(received.searchParams.get("versionIds"), "11,22");
  assert.equal(received.searchParams.get("summaryOnly"), "true");
  assert.equal(received.searchParams.get("periodId"), "period");
  assert.equal(received.searchParams.get("status"), "1");
  assert.equal(received.searchParams.get("orderType"), "Z");
  assert.equal(received.searchParams.get("planTypeCode"), "Y");
  assert.deepEqual(result.summary, summary);
  assert.deepEqual(result.groupMetrics, [{ dimension: "region", key: "r", ...summary }]);
  assert.equal(f.writes(), 0);
});

test("Host summary accepts a complete queue longer than the scalar text limit", async (t) => {
  let received;
  const f = fixture(t, undefined, undefined, {}, (url) => {
    received = new URL(url);
    return { records: [], total: 0, size: 20, current: 1, pages: 0 };
  });
  const versionIds = Array.from({ length: 50 }, (_, index) => String(100000 + index));
  await f.business.workbenchQuery(
    { kind: "list", query: { versionIds, summaryOnly: true } },
    new AbortController().signal,
  );
  assert.equal(received.searchParams.get("versionIds"), versionIds.join(","));
});

test("Host summary rejects malformed IDs and boolean flags before sending a list query", async (t) => {
  let reads = 0;
  const f = fixture(t, undefined, undefined, {}, () => {
    reads++;
    return { records: [], total: 0, size: 20, current: 1, pages: 0 };
  });
  for (const query of [
    { versionIds: [] },
    { versionIds: "11,22" },
    { versionIds: [""] },
    { versionIds: ["11,22"] },
    { versionIds: [1] },
    { versionIds: [null] },
    { versionIds: ["1".repeat(257)] },
    { summaryOnly: "true" },
    { summaryOnly: 1 },
  ])
    await assert.rejects(
      f.business.workbenchQuery({ kind: "list", query }, new AbortController().signal),
    );
  assert.equal(reads, 0);
});

test("Host sends a unified statuses list without duplicating the correction fallback query", async (t) => {
  const received = [];
  const f = fixture(t, undefined, undefined, {}, (url) => {
    received.push(new URL(url));
    return { records: [], total: 0, size: 20, current: 1, pages: 0 };
  });
  await f.business.workbenchQuery(
    { kind: "list", query: { orderType: "Z", periodId: "period", statuses: [1, 4, 1] } },
    new AbortController().signal,
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].searchParams.get("statuses"), "1,4");
  assert.equal(received[0].searchParams.has("status"), false);
  assert.equal(received[0].searchParams.get("orderType"), "Z");
  assert.equal(received[0].searchParams.get("periodId"), "period");
  assert.equal(f.writes(), 0);
});

test("Host correction detail forwards Z read intent and preserves the server M read-only baseline", async (t) => {
  let received;
  const projection = {
    currentVersion: {
      id: "v",
      planId: "p",
      status: 5,
      effective: true,
      planTypeCode: "Y",
      orderType: "M",
    },
    correctionContext: {
      contract: "absolute-net-v1",
      monthlyApproved: true,
      approvalOpen: true,
      hasCorrection: false,
    },
    skus: [
      {
        id: "s",
        versionId: "v",
        skuCode: "789",
        qty: "108.000",
        corrBaseQty: "108.000",
        amt: "0.55",
        price: "0.005",
        editable: false,
      },
    ],
    actionContext: { versionId: "v", status: 5, allowedActions: [] },
  };
  const f = fixture(
    t,
    undefined,
    (url) => {
      received = new URL(url);
    },
    projection,
  );
  const detail = await f.business.workbenchQuery(
    { kind: "detail", query: { planId: "p", orderType: "Z" } },
    new AbortController().signal,
  );
  assert.equal(received.pathname, "/sales-plan/plans/p");
  assert.equal(received.searchParams.get("orderType"), "Z");
  assert.equal(detail.currentVersion.orderType, "M");
  assert.deepEqual(detail.correctionContext, projection.correctionContext);
  assert.deepEqual(detail.skus, projection.skus);
  assert.deepEqual(detail.actionContext.allowedActions, []);
  assert.equal(f.writes(), 0);
});

test("Host statuses reject malformed arrays and a simultaneous scalar status before sending", async (t) => {
  let reads = 0;
  const f = fixture(t, undefined, undefined, {}, () => {
    reads++;
    return { records: [], total: 0, size: 20, current: 1, pages: 0 };
  });
  for (const query of [
    { statuses: [] },
    { statuses: "1,4" },
    { statuses: ["1"] },
    { statuses: [null] },
    { statuses: [-1] },
    { statuses: [1.5] },
    { statuses: [Number.MAX_SAFE_INTEGER + 1] },
    { statuses: [1], status: 1 },
  ])
    await assert.rejects(
      f.business.workbenchQuery({ kind: "list", query }, new AbortController().signal),
    );
  assert.equal(reads, 0);
});

test("original list and detail queries carry selected read node without permitting arbitrary roles", async (t) => {
  let listUrl, detailUrl;
  const f = fixture(
    t,
    undefined,
    (url) => {
      detailUrl = new URL(url);
    },
    {},
    (url) => {
      listUrl = new URL(url);
      return { records: [], total: 0, size: 20, current: 1, pages: 0 };
    },
  );
  const signal = new AbortController().signal;
  await f.business.workbenchQuery(
    { kind: "list", query: { orderType: "Z", approvalRole: "province" } },
    signal,
  );
  await f.business.workbenchQuery(
    { kind: "detail", query: { planId: "p", orderType: "Z", approvalRole: "province" } },
    signal,
  );
  assert.equal(listUrl.pathname, "/sales-plan/plans");
  assert.equal(detailUrl.pathname, "/sales-plan/plans/p");
  assert.equal(listUrl.searchParams.get("approvalRole"), "province");
  assert.equal(detailUrl.searchParams.get("approvalRole"), "province");
  await assert.rejects(
    f.business.workbenchQuery(
      { kind: "detail", query: { planId: "p", approvalRole: "admin" } },
      signal,
    ),
  );
  assert.equal(f.writes(), 0);
});

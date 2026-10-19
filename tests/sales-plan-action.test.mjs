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

function fixture(t, actionReply, detailGate, detailPatch = {}, listPage) {
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
        adjAddQty: "2.000",
        adjCutQty: "0.000",
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
        adjustmentMode: "ABSOLUTE_NET",
        approvalRole: "category",
        adjustments: [{ skuCode: "789", adjustQty: "8" }],
        ...patch,
      }),
  };
}

test("absolute correction SAVE sends its mode, snapshot and node role to GEA", async (t) => {
  let body;
  const f = correctionFixture(t, async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ success: true, result: { saved: true } });
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  assert.deepEqual(await f.business.salesPlanAction(f.payload(), signal), { saved: true });
  assert.deepEqual(body, {
    action: "SAVE",
    expectedStatus: 4,
    adjustments: [{ skuCode: "789", adjustQty: "8" }],
    adjustmentMode: "ABSOLUTE_NET",
    approvalRole: "category",
    expectedSnapshot: "a".repeat(64),
  });
});

test("absolute correction binds an omitted role to the sole authorized node before sending", async (t) => {
  let body;
  const f = correctionFixture(t, async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ success: true, result: { approved: true } });
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  await f.business.salesPlanAction(
    f.payload({ action: "APPROVE", approvalRole: undefined }),
    signal,
  );
  assert.equal(body.approvalRole, "category");
  assert.equal(body.adjustmentMode, "ABSOLUTE_NET");
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
  const payload = f.payload({ approvalRole: undefined });
  await assert.rejects(f.business.salesPlanAction(payload, signal), /isolated response lost/);
  f.detail.actionContext.snapshotHash = "b".repeat(64);
  f.detail.actionContext.allowedActions = [];
  assert.deepEqual(await f.business.salesPlanAction(payload, signal), { replayed: true });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1].body).approvalRole, "category");
  assert.equal(JSON.parse(bodies[1].body).expectedSnapshot, "a".repeat(64));
});

test("correction input rejects incomplete, duplicate, unknown, negative and overprecision decisions", async (t) => {
  const f = correctionFixture(t);
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  for (const adjustments of [
    [],
    [{ skuCode: "789", adjustQty: "-100.001" }],
    [{ skuCode: "789", adjustQty: "0.0001" }],
    [{ skuCode: "999", adjustQty: "8" }],
    [
      { skuCode: "789", adjustQty: "8" },
      { skuCode: "789", adjustQty: "8" },
    ],
  ]) {
    await assert.rejects(f.business.salesPlanAction(f.payload({ adjustments }), signal));
  }
  assert.equal(f.writes(), 0);
});

test("correction refuses unconfirmed window, node and action capabilities at the Host write entry", async (t) => {
  const f = correctionFixture(t);
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const context = structuredClone(f.detail.actionContext);
  const capability = structuredClone(f.detail.correctionContext);
  const cases = [
    { correctionContext: { ...capability, approvalOpen: false } },
    { correctionContext: { ...capability, monthlyApproved: false } },
    { correctionContext: undefined },
    { actionContext: { ...context, nodeOrder: 2 } },
    { actionContext: { ...context, allowedActions: [] } },
    { actionContext: undefined, expectedSnapshot: undefined },
    { submitter: "user-1" },
  ];
  for (const denied of cases) {
    f.detail.actionContext = Object.hasOwn(denied, "actionContext")
      ? denied.actionContext
      : context;
    f.detail.correctionContext = Object.hasOwn(denied, "correctionContext")
      ? denied.correctionContext
      : capability;
    f.detail.currentVersion.submitter = denied.submitter ?? "other-user";
    await assert.rejects(
      f.business.salesPlanAction(
        f.payload({
          action: "APPROVE",
          ...(Object.hasOwn(denied, "expectedSnapshot")
            ? { expectedSnapshot: denied.expectedSnapshot }
            : {}),
        }),
        signal,
      ),
      JSON.stringify(denied),
    );
  }
  assert.equal(f.writes(), 0);
});

test("Host list readback keeps server progress, correction totals and filtered summary", async (t) => {
  const row = {
    planId: "p",
    versionId: "v",
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
  assert.deepEqual(result.records, [row]);
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
  assert.deepEqual(result.groupMetrics, groupMetrics);
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

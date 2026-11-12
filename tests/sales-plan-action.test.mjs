import { tmpdir } from "node:os";
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

function actionReceipt(patch = {}, init) {
  const action = init
    ? JSON.parse(init.body).action
    : patch.approved
      ? "APPROVE"
      : patch.rejected
        ? "REJECT"
        : "SAVE";
  return {
    planId: "p",
    versionId: "v",
    fromStatus: 4,
    toStatus: action === "APPROVE" ? 5 : action === "REJECT" ? 9 : 4,
    approvalRole: "category",
    approvedRoles: ["region", "province", "area", "category"],
    requestId: init ? new Headers(init.headers).get("X-Request-Id") : "save-1",
    traceId: "trace",
    auditId: null,
    replayed: false,
    ...patch,
  };
}

function fixture(
  t,
  actionReply,
  detailGate,
  detailPatch = {},
  listPage,
  workflowRows,
  config = {},
) {
  const business = new module.exports.Business({
    runtimeDir: tmpdir(),
    geaBaseUrl: "https://localhost",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
    inputByteBudget: 30000,
    pageSize: 20,
    ...config,
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
    else if (path.endsWith("/plans/p/versions")) result = detailPatch.versions ?? [];
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
        toStatus:
          JSON.parse(init.body).action === "APPROVE"
            ? 5
            : JSON.parse(init.body).action === "REJECT"
              ? 9
              : status,
        approvalRole: "category",
        approvedRoles: ["region", "province", "area", "category"],
        requestId: new Headers(init.headers).get("X-Request-Id"),
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
        requestId: new Headers(init.headers).get("X-Request-Id"),
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

test("signed-out employee resubmission refuses before any network", async (t) => {
  const business = new module.exports.Business({
    runtimeDir: tmpdir(),
    geaBaseUrl: "https://localhost",
  });
  t.after(() => business.dispose());
  const f = { business };
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("unexpected request");
  });
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
    (error) =>
      error.details.resubmitUnavailableReason === "signed-out" && /登录/.test(error.message),
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

for (const [httpStatus, retryable] of [
  [200, false],
  [502, false],
  [200, true],
  [502, true],
])
  test(`explicit action HTTP ${httpStatus} business rejection with retryable ${retryable} preserves the DMS reason and allows a fresh validated request`, async (t) => {
    const message = "DMS回写失败[ITEM_DISABLED]：产品编码10004856已停用,不能填报";
    const sent = [];
    const f = fixture(t, async (_url, init) => {
      sent.push(new Headers(init.headers).get("Idempotency-Key"));
      return Response.json(
        {
          success: false,
          code: 502,
          result: null,
          errorCode: "SALES_PLAN_DMS_WRITEBACK_FAILED",
          category: "UPSTREAM",
          message,
          retryable,
          requestId: "fixture-request",
          traceId: "fixture-trace",
          auditId: null,
          details: null,
        },
        { status: httpStatus },
      );
    });
    const signal = new AbortController().signal;
    await f.business.refreshApprovalRoles(signal);
    const request = { approvalRole: "category", approvalPolicy: "role-visible-v1" };
    await assert.rejects(f.business.salesPlanAction(f.payload(request), signal), (error) => {
      assert.equal(error.name, "Error");
      assert.equal(error.code, "GEA_HTTP_502");
      assert.equal(error.message, `GEA_HTTP_502：${message}`);
      assert.equal(error.details.upstreamCode, "SALES_PLAN_DMS_WRITEBACK_FAILED");
      assert.equal(error.details.category, "UPSTREAM");
      assert.equal(error.details.retryable, retryable);
      assert.equal(error.details.retrySameIntent, false);
      return true;
    });
    f.effective(false);
    await assert.rejects(f.business.salesPlanAction(f.payload(request), signal), /已变化/);
    f.effective(true);
    await assert.rejects(f.business.salesPlanAction(f.payload(request), signal), /已停用/);
    assert.deepEqual(sent, ["save-1", "save-3"]);
  });

for (const mode of [
  "network",
  "timeout",
  "body",
  "http-body",
  "envelope",
  "receipt",
  "wrong-request",
  "wrong-status",
])
  test(`unknown action ${mode} keeps the exact intent and retries without revalidating changed source`, async (t) => {
    const sent = [];
    const f = fixture(
      t,
      async (_url, init) => {
        sent.push({
          body: init.body,
          key: new Headers(init.headers).get("Idempotency-Key"),
          requestId: new Headers(init.headers).get("X-Request-Id"),
        });
        if (sent.length > 1)
          return Response.json({ success: true, result: actionReceipt({ replayed: true }) });
        if (mode === "network") throw new TypeError("connection lost fixture-token");
        if (mode === "timeout") {
          await new Promise((_done, reject) => {
            const timer = setTimeout(() => reject(new Error("timeout was not enforced")), 500);
            init.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(init.signal.reason);
              },
              { once: true },
            );
          });
        }
        if (mode === "body") return new Response("<html>fixture-token</html>");
        if (mode === "http-body")
          return new Response("<html>fixture-token</html>", { status: 502 });
        if (mode === "envelope") return Response.json({ result: actionReceipt() });
        if (mode === "receipt") return Response.json({ success: true, result: { approved: true } });
        if (mode === "wrong-status")
          return Response.json({ success: true, result: actionReceipt({ toStatus: 0 }) });
        return Response.json({
          success: true,
          result: actionReceipt({ requestId: "other-request" }),
        });
      },
      undefined,
      {},
      undefined,
      undefined,
      { requestTimeoutMs: 30 },
    );
    const signal = new AbortController().signal;
    await f.business.refreshApprovalRoles(signal);
    const command = f.payload({ approvalRole: "category", approvalPolicy: "role-visible-v1" });
    await assert.rejects(f.business.salesPlanAction(command, signal), (error) => {
      assert.equal(error.code, "GEA_HTTP_502");
      assert.equal(error.details.retrySameIntent, true);
      assert.equal(error.message.includes("fixture-token"), false);
      return true;
    });
    f.effective(false);
    const receipt = await f.business.salesPlanAction(command, signal);
    assert.equal(receipt.replayed, true);
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(await f.business.salesPlanAction(command, signal), receipt);
    assert.equal(sent.length, 2);
  });

test("a received return receipt retries only readback after a read failure or mismatch", async (t) => {
  let readbacks = 0;
  const patch = {
    currentVersion: {
      id: "v",
      planId: "p",
      status: 4,
      effective: true,
      planTypeCode: "Y",
      orderType: "M",
    },
    skus: [
      {
        skuCode: "789",
        versionId: "v",
        qty: "90",
        price: "2",
        areaConfirmedQty: "120",
        areaConfirmedAmount: "240",
      },
    ],
    actionContext: {
      versionId: "v",
      status: 4,
      nodeOrder: 5,
      allowedActions: ["REJECT"],
      snapshotHash: "a".repeat(64),
      policy: "role-visible-v1",
      roleActions: [{ role: "category", allowedActions: ["REJECT"] }],
    },
  };
  const f = fixture(
    t,
    async () => Response.json({ success: true, result: actionReceipt({ toStatus: 9 }) }),
    async () => {
      if (f.writes()) {
        readbacks++;
        if (readbacks === 1) throw new Error("offline readback");
      }
    },
    patch,
  );
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const command = f.payload({
    action: "REJECT",
    approvalRole: "category",
    approvalPolicy: "role-visible-v1",
    expectedReturnTargetStage: 4,
    remark: "核对",
    adjustments: [{ skuCode: "789", adjustQty: "10" }],
  });
  await assert.rejects(
    f.business.salesPlanAction(command, signal),
    (error) => error.details?.retrySameIntent === true,
  );
  await assert.rejects(
    f.business.salesPlanAction(command, signal),
    (error) => error.details?.retrySameIntent === true,
  );
  assert.equal(f.writes(), 1);
  patch.currentVersion.status = 9;
  patch.skus[0].areaConfirmedQty = "130";
  patch.skus[0].areaConfirmedAmount = "260";
  const receipt = await f.business.salesPlanAction(command, signal);
  assert.equal(receipt.toStatus, 9);
  assert.equal(f.writes(), 1);
  assert.equal(readbacks, 3);
  await f.business.salesPlanAction(command, signal);
  assert.equal(readbacks, 3);
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
      key: new Headers(init.headers).get("Idempotency-Key"),
      request: new Headers(init.headers).get("X-Request-Id"),
    });
    entered();
    await new Promise((done) => {
      release = done;
    });
    return Response.json({
      success: true,
      result: actionReceipt({}, init),
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
        requestId: new Headers(init.headers).get("X-Request-Id"),
        key: new Headers(init.headers).get("Idempotency-Key"),
      });
      return Response.json({
        success: true,
        result: actionReceipt({}, init),
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
    const old = new Headers(init.headers).get("X-Access-Token") === "fixture-token";
    if (old) {
      entered();
      await new Promise((done) => {
        release = done;
      });
    }
    return Response.json({
      success: true,
      result: actionReceipt({ owner: old ? "old" : "replacement" }, init),
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

for (const [customerCode, returnedStatus, orderType] of [
  ["456", 7, "M"],
  ["9007199254740993", 7, "M"],
  ["9223372036854775807", 7, "M"],
  ["456", 6, "M"],
  ["456", 7, "Z"],
  ["456", 6, "Z"],
  ["456", 8, "M"],
  ["456", 9, "M"],
  ["456", 8, "Z"],
  ["456", 9, "Z"],
])
  test(`public Business resubmits returned ${orderType} status ${returnedStatus} with exact customer ${customerCode}, employee login without service configuration and nullable audit receipt`, async (t) => {
    const role = { 7: "region", 8: "province", 9: "area" }[returnedStatus];
    const business = new module.exports.Business({
      runtimeDir: tmpdir(),
      geaBaseUrl: "https://localhost",
      analysisAgentCode: "sales_forecast",
      requestTimeoutMs: 2000,
      inputByteBudget: 30000,
      pageSize: 20,
      periodPageSize: 100,
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
        roles:
          returnedStatus === 6 ? [] : [{ code: `sales_plan_${role}_approver`, name: "审批人" }],
      },
    });
    t.after(() => business.dispose());
    const planId = "p-jxs-2026-10-00001";
    const version = {
      id: "v1",
      planId,
      periodId: "17",
      planTypeCode: "Y",
      orderType,
      status: returnedStatus,
      submitter: returnedStatus === 6 ? "user-1" : "original-owner",
      effective: true,
      seq: 1,
      cust_code: JSON.rawJSON(customerCode),
      region_code: "27",
      province_region_code: "0005",
      sales_group_code: "578",
      belong_base: "郑州",
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
      ...(orderType === "Z" ? { adjustmentMode: "ABSOLUTE_NET" } : {}),
      orderType,
      status: returnedStatus - 5,
      periodId: "17",
      periodMonth: "2026-10",
      planTypeCode: "Y",
      channelCode: "jxs",
      dealerCode: customerCode,
      areaCode: "27",
      provinceCode: "0005",
      orgCode: "578",
      baseName: "郑州",
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
          ...(orderType === "Z" ? { adjAddQty: "3", adjCutQty: "0" } : {}),
        },
      ],
    };
    let tokens = 0,
      writes = 0,
      refuse = false,
      sourceDenied = false,
      employeeRole = true,
      replyMode = "normal";
    const sentBodies = new Map();
    t.mock.method(globalThis, "fetch", async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/api/v1/internal/auth/token")) {
        tokens++;
        throw Error("Employee resubmission must not exchange service credentials");
      }
      if (path.endsWith("/sales-plan/plans/resubmit")) {
        writes++;
        assert.equal(new Headers(init.headers).get("Authorization"), null);
        assert.equal(new Headers(init.headers).get("X-Access-Token"), "employee-token");
        assert.equal(new Headers(init.headers).get("X-Tenant-Id"), "1");
        assert.equal(new Headers(init.headers).get("X-Source-Version-Id"), null);
        assert.deepEqual(JSON.parse(init.body).items, request.items);
        assert.equal(JSON.parse(init.body).submitterCode, version.submitter);
        assert.equal(JSON.parse(init.body).submitterName, undefined);
        assert.equal(JSON.parse(init.body).cust_code, Number(request.dealerCode));
        const key = new Headers(init.headers).get("Idempotency-Key");
        if (sentBodies.has(key)) assert.equal(init.body, sentBodies.get(key));
        else sentBodies.set(key, init.body);
        if (replyMode === "timeout") {
          await new Promise((resolve) =>
            init.signal.addEventListener("abort", resolve, { once: true }),
          );
          throw init.signal.reason;
        }
        if (replyMode === "broken") return new Response("not json", { status: 200 });
        if (replyMode === "wrong-result")
          return Response.json({ success: true, result: "unexpected" });
        if (replyMode.startsWith("business-rejection"))
          return Response.json(
            {
              success: false,
              code: 502,
              errorCode: "SALES_PLAN_DMS_WRITEBACK_FAILED",
              message: "产品编码10004856已停用,不能填报",
              retryable: true,
            },
            { status: replyMode.endsWith("-http") ? 502 : 200 },
          );
        if (refuse)
          return Response.json(
            { errorCode: "UNAUTHORIZED", message: "员工登录已过期", traceId: "service-failure" },
            { status: 401 },
          );
        return Response.json({
          success: true,
          result: {
            planId,
            versionId: "v2",
            seq: 2,
            status: request.status,
            replayed: false,
            requestId: new Headers(init.headers).get("X-Request-Id"),
            traceId: "trace",
            auditId: null,
          },
        });
      }
      if (!path.endsWith("/sql/execute"))
        assert.equal(new Headers(init.headers).get("X-Access-Token"), "employee-token");
      assert.equal(new Headers(init.headers).get("Authorization"), null);
      let result;
      if (path.endsWith("/getPermCode"))
        result = { codeList: role ? [`sales-plan:plan:${role}-approve`] : [] };
      else if (path.endsWith("/plans/" + planId)) {
        if (sourceDenied) return Response.json({ message: "来源无权读取" }, { status: 403 });
        result = { currentVersion: version, versions: [version], skus: [sku], logs: [] };
      } else if (path.endsWith("/versions/v1/skus")) result = [sku];
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
        result = {
          success: true,
          roles:
            role && employeeRole ? [{ code: `sales_plan_${role}_approver`, name: "审批人" }] : [],
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
          requestId: new Headers(init.headers).get("X-Request-Id"),
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
    assert.equal(business.status().resubmitConnected, true);
    if (returnedStatus === 6) {
      version.submitter = "another-submitter";
      await assert.rejects(
        business.salesPlanSubmit(command("submitter-denied"), signal),
        (error) =>
          error.code === "GEA_HTTP_403" && error.details.resubmitUnavailableReason === undefined,
      );
      version.submitter = "user-1";
    } else {
      employeeRole = false;
      await business.refreshApprovalRoles(signal, { force: true });
      await assert.rejects(
        business.salesPlanSubmit(command("role-denied"), signal),
        (error) =>
          error.code === "GEA_HTTP_403" && error.details.resubmitUnavailableReason === undefined,
      );
      employeeRole = true;
      await business.refreshApprovalRoles(signal, { force: true });
    }
    sourceDenied = true;
    await assert.rejects(
      business.salesPlanSubmit(command("source-denied"), signal),
      (error) =>
        error.code === "GEA_HTTP_403" && error.details.resubmitUnavailableReason === undefined,
    );
    sourceDenied = false;
    assert.equal(tokens, 0);
    assert.equal(writes, 0);
    const [receipt, concurrent] = await Promise.all([
      business.salesPlanSubmit(command("first"), signal),
      business.salesPlanSubmit(command("first"), signal),
    ]);
    assert.deepEqual(concurrent, receipt);
    assert.equal(receipt.auditId, null);
    assert.equal(receipt.status, request.status);
    assert.deepEqual(await business.salesPlanSubmit(command("first"), signal), receipt);
    assert.equal(writes, 1);
    assert.deepEqual(JSON.parse(sentBodies.get("first")).notification, {
      title: "需求预测重新提报待审批",
      content: `一份2026年10月${orderType === "Z" ? "纠偏" : "月初"}需求预测已修改并重新提报，请查看并按最新内容处理。`,
    });
    await assert.rejects(
      business.salesPlanSubmit(
        { ...command("first"), request: { ...request, targetQty: "2.000" } },
        signal,
      ),
      /幂等键/,
    );
    assert.equal(writes, 1);
    await business.salesPlanSubmit(command("second"), signal);
    assert.equal(tokens, 0);
    assert.equal(writes, 2);
    if (customerCode === "456" && returnedStatus === 7) {
      for (const mode of ["business-rejection", "business-rejection-http"]) {
        replyMode = mode;
        await assert.rejects(business.salesPlanSubmit(command(mode), signal), (error) => {
          assert.equal(error.details.upstreamCode, "SALES_PLAN_DMS_WRITEBACK_FAILED");
          assert.equal(error.details.retryable, true);
          assert.equal(error.details.retrySameIntent, false);
          return true;
        });
      }
      for (const mode of ["timeout", "broken", "wrong-result"]) {
        replyMode = mode;
        const intent = command("uncertain-" + mode);
        await assert.rejects(
          business.salesPlanSubmit(intent, signal),
          (error) => error.details?.retrySameIntent === true,
        );
        replyMode = "normal";
        sourceDenied = true;
        assert.equal((await business.salesPlanSubmit(intent, signal)).status, request.status);
        sourceDenied = false;
      }
    }
    const writesBeforeExpiration = writes;
    const records = business
      .apiLogSnapshot({})
      .records.filter((record) =>
        ["plans.resubmit", "plans.detail", "plans.version-skus"].includes(record.catalogId),
      );
    assert.ok(records.length > 0);
    assert.equal(
      records.some((record) => record.replayAvailable),
      false,
    );
    assert.equal(JSON.stringify(records).includes('"789"'), false);
    assert.equal(JSON.stringify(records).includes("contract-secret"), false);
    refuse = true;
    await assert.rejects(
      business.salesPlanSubmit(command("employee-expired"), signal),
      (error) => error.code === "GEA_HTTP_401",
    );
    assert.equal(writes, writesBeforeExpiration + 1);
    assert.equal(tokens, 0);
    assert.equal(business.status().loginState, "expired");
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

for (const orderType of ["M", "Z"])
  for (const action of ["APPROVE", "REJECT"])
    test(`${orderType} ${action} sends business notification text through the actual action request`, async (t) => {
      const sent = [];
      const f = correctionFixture(t, async (_url, init) => {
        sent.push(JSON.parse(init.body));
        return Response.json({ success: true, result: actionReceipt({ accepted: true }, init) });
      });
      f.detail.currentVersion.orderType = orderType;
      f.detail.actionContext = undefined;
      const signal = new AbortController().signal;
      await f.business.refreshApprovalRoles(signal);
      const command = f.payload({ action, expectedSnapshot: undefined, remark: "开发验收" });
      await f.business.salesPlanAction(command, signal);
      await f.business.salesPlanAction(command, signal);
      assert.equal(sent.length, 1);
      const kind = orderType === "Z" ? "纠偏" : "月初";
      assert.deepEqual(
        sent[0].notification,
        action === "APPROVE"
          ? {
              title: "需求预测审批待处理",
              content: `一份${kind}需求预测已通过品类审批，请查看并按最新内容处理。`,
            }
          : {
              title: "需求预测退回待处理",
              content: `一份${kind}需求预测已退回，请查看退回原因并修改后重新提报。`,
            },
      );
      assert.doesNotMatch(JSON.stringify(sent[0].notification), /sales-plan:|版本|p-jxs-/);
    });

test("Z approval uses the current environment workflow for a newly configured skipped-node type", async (t) => {
  let body;
  const f = fixture(
    t,
    async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json({ success: true, result: actionReceipt({ approved: true }, init) });
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
    actionReceipt({ approved: true }),
  );
  assert.deepEqual(body, {
    action: "APPROVE",
    expectedStatus: 4,
    notification: {
      title: "需求预测审批待处理",
      content: "一份纠偏需求预测已通过品类审批，请查看并按最新内容处理。",
    },
  });
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
    return Response.json({ success: true, result: actionReceipt({ approved: true }, init) });
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
    actionReceipt({ approved: true }),
  );
  assert.deepEqual(sent, {
    path: "/sales-plan/plans/versions/v/actions",
    body: {
      action: "APPROVE",
      expectedStatus: 4,
      adjustments: [{ skuCode: "789", adjustQty: "8" }],
      notification: {
        title: "需求预测审批待处理",
        content: "一份纠偏需求预测已通过品类审批，请查看并按最新内容处理。",
      },
    },
  });
});

test("Z rejection uses the original monthly action body and requires its reason", async (t) => {
  let body;
  const f = correctionFixture(t, async (_url, init) => {
    body = JSON.parse(init.body);
    return Response.json({ success: true, result: actionReceipt({ rejected: true }, init) });
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
    actionReceipt({ rejected: true, requestId: "save-2" }),
  );
  assert.deepEqual(body, {
    action: "REJECT",
    expectedStatus: 4,
    remark: "请核对调整数量",
    notification: {
      title: "需求预测退回待处理",
      content: "一份纠偏需求预测已退回，请查看退回原因并修改后重新提报。",
    },
  });
});

test("Z approval keeps monthly role and snapshot checks without correction metadata", async (t) => {
  let sent;
  const f = correctionFixture(t, async (url, init) => {
    sent = { path: new URL(url).pathname, body: JSON.parse(init.body) };
    return Response.json({ success: true, result: actionReceipt({ approved: true }, init) });
  });
  f.detail.correctionContext = undefined;
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  assert.deepEqual(
    await f.business.salesPlanAction(f.payload(), signal),
    actionReceipt({ approved: true }),
  );
  assert.deepEqual(sent, {
    path: "/sales-plan/plans/versions/v/actions",
    body: {
      action: "APPROVE",
      expectedStatus: 4,
      adjustments: [{ skuCode: "789", adjustQty: "8" }],
      notification: {
        title: "需求预测审批待处理",
        content: "一份纠偏需求预测已通过品类审批，请查看并按最新内容处理。",
      },
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
    bodies.push({ key: new Headers(init.headers).get("Idempotency-Key"), body: init.body });
    if (bodies.length === 1) throw new TypeError("isolated response lost");
    return Response.json({ success: true, result: actionReceipt({ replayed: true }, init) });
  });
  const signal = new AbortController().signal;
  await f.business.refreshApprovalRoles(signal);
  const payload = f.payload();
  await assert.rejects(
    f.business.salesPlanAction(payload, signal),
    (error) => error.details?.retrySameIntent === true,
  );
  f.detail.actionContext.snapshotHash = "b".repeat(64);
  f.detail.actionContext.allowedActions = [];
  assert.deepEqual(
    await f.business.salesPlanAction(payload, signal),
    actionReceipt({ replayed: true, toStatus: 5 }),
  );
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[1].body), {
    action: "APPROVE",
    expectedStatus: 4,
    adjustments: [{ skuCode: "789", adjustQty: "8" }],
    notification: {
      title: "需求预测审批待处理",
      content: "一份纠偏需求预测已通过品类审批，请查看并按最新内容处理。",
    },
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
      shipmentError: "未取得该客户 当前期间 的发货数据",
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

test("Business sends the five HTTP dimensions and preserves the internal sales model", async (t) => {
  let received;
  const f = fixture(t, undefined, undefined, {}, (url) => {
    received = new URL(url);
    return {
      records: [
        {
          planId: "p",
          versionId: "v",
          cust_code: 10070026,
          region_code: "27",
          province_region_code: "0005",
          sales_group_code: "578",
          belong_base: "郑州",
          dealer_name: "客户",
          province_name: "省区",
          orgName: "销售组",
          areaName: "大区",
          status: 7,
          currentQty: "2.000",
          currentAmount: "4.00",
        },
      ],
      total: 1,
      current: 1,
      size: 20,
      pages: 1,
    };
  });
  const result = await f.business.workbenchQuery(
    {
      kind: "list",
      query: {
        dealerCode: "10070026",
        areaCode: "27",
        provinceCode: "0005",
        orgCode: "578",
        baseName: "郑州",
        orderType: "M",
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(Object.fromEntries(received.searchParams), {
    pageNo: "1",
    pageSize: "20",
    cust_code: "10070026",
    region_code: "27",
    province_region_code: "0005",
    sales_group_code: "578",
    belong_base: "郑州",
    orderType: "M",
  });
  assert.deepEqual(result.records[0], {
    planId: "p",
    versionId: "v",
    dealerCode: "10070026",
    areaCode: "27",
    provinceCode: "0005",
    orgCode: "578",
    baseName: "郑州",
    dealerName: "客户",
    provinceName: "省区",
    orgName: "销售组",
    areaName: "大区",
    status: 7,
    currentQty: "2.000",
    currentAmount: "4.00",
    shipQty: null,
    shipAmount: null,
    amountProgress: null,
    shipmentError: "未取得该客户 当前期间 的发货数据",
  });
});

test("all Business sales reads decode exact Long customers, nullable dimensions and untouched SKU approvals", async (t) => {
  const version = {
    id: "v",
    planId: "p",
    periodId: "17",
    cust_code: JSON.rawJSON("9007199254740993"),
    region_code: null,
    province_region_code: "0005",
    sales_group_code: "578",
    belong_base: null,
    status: 7,
    targetQty: JSON.rawJSON("1.2300"),
    targetAmount: JSON.rawJSON("12.30"),
  };
  const historical = { ...version, id: "old", cust_code: JSON.rawJSON("9223372036854775807") };
  const f = fixture(
    t,
    undefined,
    undefined,
    {
      currentVersion: version,
      versions: [historical],
      skus: [
        {
          id: "s",
          versionId: "v",
          skuCode: "789",
          regionConfirmedQty: JSON.rawJSON("2.125"),
          provinceConfirmedQty: "3.000",
          areaConfirmedQty: "4.000",
        },
      ],
      logs: [],
    },
    {
      records: [{ ...version, versionId: "v", dealer_name: "客户" }],
      total: 1,
      current: 1,
      size: 20,
    },
  );
  const signal = new AbortController().signal;
  const page = await f.business.plans({}, signal);
  assert.equal(page.records[0].dealerCode, "9007199254740993");
  assert.equal(page.records[0].dealerName, "客户");
  const selection = { queryId: page.queryId, planId: "p" };
  const detail = await f.business.detail(selection, signal);
  assert.equal(detail.currentVersion.dealerCode, "9007199254740993");
  assert.equal(detail.currentVersion.areaCode, null);
  assert.equal(detail.currentVersion.baseName, null);
  assert.equal(detail.currentVersion.provinceCode, "0005");
  assert.equal(detail.currentVersion.targetQty, "1.2300");
  assert.equal(detail.currentVersion.targetAmount, "12.30");
  assert.equal(
    (await f.business.versions(selection, signal)).records[0].dealerCode,
    "9223372036854775807",
  );
  const current = await f.business.workbenchQuery(
    { kind: "detail", query: { planId: "p" } },
    signal,
  );
  assert.equal(current.currentVersion.dealerCode, "9007199254740993");
  assert.equal(current.versions[0].dealerCode, "9223372036854775807");
  assert.equal(current.skus[0].regionConfirmedQty, "2.125");
  assert.equal(current.skus[0].provinceConfirmedQty, "3.000");
  assert.equal(current.skus[0].areaConfirmedQty, "4.000");
  assert.equal(
    (await f.business.workbenchQuery({ kind: "versions", query: { planId: "p" } }, signal))[0]
      .dealerCode,
    "9223372036854775807",
  );
  const agent = JSON.parse(
    await f.business.agentQuery({ kind: "detail", query: { planId: "p" } }, signal),
  );
  assert.equal(agent.value.currentVersion.dealerCode, "9007199254740993");
  assert.equal(agent.value.versions[0].dealerCode, "9223372036854775807");
});

test("Business rejects invalid customer HTTP values and query values without rounding or coercion", async (t) => {
  let customer = null;
  let calls = 0;
  const f = fixture(t, undefined, undefined, {}, () => {
    calls++;
    return {
      records: [{ planId: "p", versionId: "v", cust_code: customer }],
      total: 1,
      current: 1,
      size: 20,
    };
  });
  const signal = new AbortController().signal;
  const read = () => f.business.workbenchQuery({ kind: "list", query: {} }, signal);
  assert.equal((await read()).records[0].dealerCode, null);
  for (const token of [
    "0",
    "-1",
    "1.5",
    "1e3",
    "9223372036854775808",
    '"10070026"',
    "true",
    "{}",
    "[]",
  ]) {
    customer = JSON.rawJSON(token === "{}" || token === "[]" ? "null" : token);
    if (token === "{}") customer = {};
    if (token === "[]") customer = [];
    await assert.rejects(read(), /GEA_INVALID_JSON/, token);
  }
  const before = calls;
  for (const dealerCode of [
    "0",
    "-1",
    "1.5",
    "1e3",
    "001",
    "abc",
    "9223372036854775808",
    9007199254740992,
  ])
    await assert.rejects(
      f.business.workbenchQuery({ kind: "list", query: { dealerCode } }, signal),
      /GEA_INVALID_CUSTOMER/,
    );
  assert.equal(calls, before);
});

test("Business enforces string organization dimensions while preserving leading zeros", async (t) => {
  let area = 27;
  let calls = 0;
  const f = fixture(t, undefined, undefined, {}, () => {
    calls++;
    return { records: [{ planId: "p", region_code: area }], total: 1, current: 1, size: 20 };
  });
  const signal = new AbortController().signal;
  await assert.rejects(
    f.business.workbenchQuery({ kind: "list", query: {} }, signal),
    /GEA_INVALID_JSON/,
  );
  area = "x".repeat(65);
  await assert.rejects(
    f.business.workbenchQuery({ kind: "list", query: {} }, signal),
    /GEA_INVALID_JSON/,
  );
  const before = calls;
  await assert.rejects(
    f.business.workbenchQuery({ kind: "list", query: { provinceCode: "x".repeat(65) } }, signal),
    /GEA_INVALID_DIMENSION/,
  );
  assert.equal(calls, before);
});

test("employee resubmission readiness needs login and ignores absent or obsolete service references", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw Error("unexpected channel request");
  });
  for (const serviceAccounts of [
    undefined,
    {
      production: {
        clientIdEnv: "GEA_STATUS_CLIENT",
        clientSecretEnv: "GEA_STATUS_SECRET",
        tenantId: "different-tenant",
        keychainService: "old-local-reference",
      },
    },
  ]) {
    if (serviceAccounts) serviceAccounts.production.tenantId = "2";
    const business = new module.exports.Business({
      runtimeDir: tmpdir(),
      geaBaseUrl: "https://localhost",
      serviceAccounts,
    });
    t.after(() => business.dispose());
    assert.equal(business.status().resubmitConnected, false);
    assert.equal(business.status().resubmitUnavailableReason, "signed-out");
    await assert.rejects(
      business.salesPlanSubmit({}, new AbortController().signal),
      (error) => error.details?.resubmitUnavailableReason === "signed-out",
    );
    business.restoreDesktopLogin({
      schema: 1,
      environment: "production",
      base: "https://localhost",
      auth: {
        token: "employee-token",
        tenantId: "1",
        id: "ordinary-user",
        name: "Test",
        username: "test",
      },
    });
    assert.equal(business.status().resubmitConnected, true);
    assert.equal(business.status().resubmitUnavailableReason, undefined);
  }
  assert.equal(network.mock.callCount(), 0);
});

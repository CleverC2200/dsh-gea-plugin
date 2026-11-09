import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { resolve } from "node:path";
const bundled = await build({
  entryPoints: ["src/host/sales-plan-transactions.ts"],
  alias: {
    "@cleverc2200/dsh-agent-workbench/sales-plan": resolve(
      process.env.DSH_TEST_WORKBENCH ?? "../dsh-agent-workbench",
      "src/sales-plan.ts",
    ),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
function fixture({ wrongTarget = false, wrongReadback = false } = {}) {
  const before = {
    currentVersion: {
      id: "v",
      planId: "p",
      status: 2,
      effective: true,
      planTypeCode: "Y",
      orderType: "M",
    },
    skus: [
      {
        skuCode: "1001",
        versionId: "v",
        qty: "90",
        price: "2",
        regionConfirmedQty: "100",
        regionConfirmedAmount: "200",
        provinceConfirmedQty: "120",
        provinceConfirmedAmount: "240",
      },
    ],
  };
  const after = {
    ...before,
    currentVersion: { ...before.currentVersion, status: 7 },
    skus: [
      {
        ...before.skus[0],
        regionConfirmedQty: wrongReadback ? "90" : "110",
        regionConfirmedAmount: "220",
        provinceConfirmedQty: null,
        provinceConfirmedAmount: null,
      },
    ],
  };
  const bodies = [];
  let posts = 0;
  let reads = 0;
  const owner = {
    scope: () => ({
      auth: {
        token: "fixture",
        tenantId: "1",
        id: "u",
        name: "Test",
        username: "test",
        roles: [{ code: "sales_plan_province_approver", name: "省区审批" }],
      },
      base: "https://fixture.test",
      signal: new AbortController().signal,
    }),
    query: async ({ kind }) => {
      reads++;
      return kind === "returnContext"
        ? {
            versionId: "v",
            status: 2,
            currentStage: 3,
            targetStage: wrongTarget ? 1 : 2,
            targetStatus: wrongTarget ? 6 : 7,
          }
        : posts
          ? after
          : before;
    },
    permissions: async () => {},
    workflow: async () =>
      ["0", "1", "2", "3", "4", "Y"].map((nodeNum, examineLevel) => ({
        typeCode: "Y",
        nodeNum,
        examineLevel,
      })),
    fetch: async (url, input) => {
      posts++;
      bodies.push(input.body);
      return Response.json({
        success: true,
        result: {
          planId: "p",
          versionId: "v",
          fromStatus: 2,
          toStatus: 7,
          requestId: "req",
          traceId: "trace",
          replayed: posts > 1,
        },
      });
    },
    expire: () => {},
    decode: JSON.parse,
    timeoutMs: 2000,
    periodPageSize: 100,
  };
  const tx = new module.exports.SalesPlanTransactions(owner);
  const command = {
    planId: "p",
    versionId: "v",
    requestId: "req",
    idempotencyKey: "same-return",
    request: {
      action: "REJECT",
      approvalRole: "province",
      expectedStatus: 2,
      expectedReturnTargetStage: 2,
      remark: "核对",
      adjustments: [{ skuCode: "1001", adjustQty: "10.000" }],
    },
  };
  return { tx, command, bodies, reads: () => reads, posts: () => posts, after };
}
test("REJECT forwards exact adjustments, strips target metadata and reads back the receiving node", async () => {
  const f = fixture();
  const result = await f.tx.action(f.command, new AbortController().signal);
  assert.equal(result.toStatus, 7);
  assert.equal(f.posts(), 1);
  assert.equal(f.reads(), 3);
  const body = JSON.parse(f.bodies[0]);
  assert.deepEqual(body.adjustments, [{ skuCode: "1001", adjustQty: "10.000" }]);
  assert.equal("expectedReturnTargetStage" in body, false);
  await f.tx.action(f.command, new AbortController().signal);
  assert.equal(f.posts(), 1);
});
test("a different actual target rejects before any business write", async () => {
  const f = fixture({ wrongTarget: true });
  await assert.rejects(f.tx.action(f.command, new AbortController().signal));
  assert.equal(f.posts(), 0);
});
test("failed readback retains the original write body and idempotency key for a retry", async () => {
  const f = fixture({ wrongReadback: true });
  await assert.rejects(
    f.tx.action(f.command, new AbortController().signal),
    (error) => error.details.retrySameIntent === true,
  );
  f.after.skus[0].regionConfirmedQty = "110";
  await f.tx.action(f.command, new AbortController().signal);
  assert.equal(f.bodies.length, 2);
  assert.equal(f.bodies[0], f.bodies[1]);
});

test("public return preview uses the version endpoint and rejects a mismatched destination", async (t) => {
  const output = await build({
    entryPoints: ["src/host/business.ts"],
    alias: {
      "@cleverc2200/dsh-agent-workbench/sales-plan": resolve(
        process.env.DSH_TEST_WORKBENCH ?? "../dsh-agent-workbench",
        "src/sales-plan.ts",
      ),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
  });
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output.outputFiles[0].text)(
    createRequire(import.meta.url),
    loaded,
    loaded.exports,
  );
  const business = new loaded.exports.Business({
    geaBaseUrl: "https://fixture.test",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 2000,
  });
  t.after(() => business.dispose());
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://fixture.test",
    auth: {
      token: "fixture",
      tenantId: "1",
      id: "u",
      username: "test",
      name: "Test",
      roles: [{ code: "sales_plan_province_approver", name: "省区审批" }],
    },
  });
  let value = { versionId: "v", status: 2, currentStage: 3, targetStage: 2, targetStatus: 7 };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(new URL(url).pathname, "/sales-plan/plans/versions/v/return-context");
    assert.equal(init.method, "GET");
    return Response.json({ success: true, result: value });
  });
  const query = { kind: "returnContext", query: { versionId: "v" } };
  assert.deepEqual(await business.workbenchQuery(query, new AbortController().signal), value);
  for (const patch of [{ versionId: "other" }, { targetStage: 3 }, { targetStatus: 8 }]) {
    value = {
      versionId: "v",
      status: 2,
      currentStage: 3,
      targetStage: 2,
      targetStatus: 7,
      ...patch,
    };
    await assert.rejects(
      business.workbenchQuery(query, new AbortController().signal),
      /GEA_IDENTITY_MISMATCH/,
    );
  }
});

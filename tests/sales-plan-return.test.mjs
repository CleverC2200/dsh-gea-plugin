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
function fixture({
  wrongReadback = false,
  status = 2,
  role = "province",
  target = 2,
  logs = [],
} = {}) {
  const before = {
    currentVersion: {
      id: "v",
      planId: "p",
      status,
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
    logs: logs.map((log) => ({ planId: "p", versionId: "v", ...log })),
  };
  const qtyField = ["qty", "regionConfirmedQty", "provinceConfirmedQty", "areaConfirmedQty"][
    target - 1
  ];
  const amountField = [
    "amt",
    "regionConfirmedAmount",
    "provinceConfirmedAmount",
    "areaConfirmedAmount",
  ][target - 1];
  const sender = { region: "region", province: "province", area: "area" }[role];
  const received = String(Number(before.skus[0][qtyField]) + 10);
  const after = {
    ...before,
    currentVersion: { ...before.currentVersion, status: target + 5 },
    skus: [
      {
        ...before.skus[0],
        [qtyField]: wrongReadback ? "90" : received,
        [amountField]: String(Number(received) * 2),
        [sender + "ConfirmedQty"]: null,
        [sender + "ConfirmedAmount"]: null,
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
        roles: [{ code: "sales_plan_" + role + "_approver", name: "审批" }],
      },
      base: "https://fixture.test",
      signal: new AbortController().signal,
    }),
    query: async ({ kind }) => {
      reads++;
      assert.equal(kind, "detail");
      return posts ? after : before;
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
          fromStatus: status,
          toStatus: target + 5,
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
      approvalRole: role,
      expectedStatus: status,
      expectedReturnTargetStage: target,
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
  assert.equal(f.reads(), 2);
  const body = JSON.parse(f.bodies[0]);
  assert.deepEqual(body.adjustments, [{ skuCode: "1001", adjustQty: "10.000" }]);
  assert.equal("expectedReturnTargetStage" in body, false);
  await f.tx.action(f.command, new AbortController().signal);
  assert.equal(f.posts(), 1);
});
test("a different actual target rejects before any business write", async () => {
  const f = fixture();
  f.command.request.expectedReturnTargetStage = 1;
  await assert.rejects(f.tx.action(f.command, new AbortController().signal));
  assert.equal(f.posts(), 0);
});
test("continued returns validate existing detail and carry adjustments through actual target readback", async () => {
  for (const [status, role, target] of [
    [7, "region", 1],
    [8, "province", 2],
    [9, "area", 3],
    [9, "area", 2],
  ]) {
    const f = fixture({
      status,
      role,
      target,
      logs: [{ actionCode: "APPROVE", fromStatus: target, toStatus: status - 5 }],
    });
    const result = await f.tx.action(f.command, new AbortController().signal);
    assert.equal(result.toStatus, target + 5);
    assert.equal(f.posts(), 1);
    assert.equal(f.reads(), 2);
    const body = JSON.parse(f.bodies[0]);
    assert.deepEqual(body.adjustments, [{ skuCode: "1001", adjustQty: "10.000" }]);
    assert.equal("expectedReturnTargetStage" in body, false);
  }
});
test("failed readback retains the successful receipt and retries only the receiving-node read", async () => {
  const f = fixture({ wrongReadback: true });
  await assert.rejects(
    f.tx.action(f.command, new AbortController().signal),
    (error) => error.details.retrySameIntent === true,
  );
  f.after.skus[0].regionConfirmedQty = "110";
  await f.tx.action(f.command, new AbortController().signal);
  assert.equal(f.bodies.length, 1);
  assert.equal(f.reads(), 3);
});

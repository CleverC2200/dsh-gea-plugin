import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["src/mock-dms.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { MockDmsWriteback, mockDmsPackets } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);
const seed = (typeCode = "Y", orderType = "M") => ({
  planId: "mock-p",
  versionId: "mock-v1",
  typeCode,
  orderType,
  status: 4,
  skus: [
    {
      skuCode: "s",
      qty: "0.300",
      addQty: orderType === "Z" ? "2.500" : "0",
      cutQty: orderType === "Z" ? "1.250" : "0",
    },
  ],
});
const make = (type, order) =>
  new MockDmsWriteback(seed(type, order), () => "2026-09-12T10:00:00.000Z");

test("six plan types, M and Z require terminal approval and every receipt before 10", () => {
  for (const type of ["Y", "XN", "DC", "FC", "JD", "TM"])
    for (const order of ["M", "Z"]) {
      const a = make(type, order);
      assert.throws(() => a.deliver("success"), /REQUIRES_STATUS_5/);
      a.approve();
      const waiting = a.read();
      assert.equal(waiting.plan.status, 5);
      assert.equal(waiting.syncStatus, "PENDING");
      assert.equal(waiting.finishedAt, null);
      assert.equal(waiting.packets.length, order === "M" ? 1 : 2);
      for (const packet of waiting.packets) {
        assert.equal(packet.PLANE_NUM, "mock-p");
        assert.equal(packet.sourceVersionId, "mock-v1");
        assert.equal(packet.planTypeCode, type);
      }
      assert.deepEqual(
        waiting.packets.map((p) => p.items[0].qty),
        order === "M" ? ["0.300"] : ["2.500", "1.250"],
      );
      a.deliver("success");
      const done = a.read();
      assert.equal(done.plan.status, 10);
      assert.equal(done.syncStatus, "SYNCED");
      assert.equal(done.finishedAt, "2026-09-12T10:00:00.000Z");
      assert.equal(done.remoteDeliveries, order === "M" ? 1 : 2);
      assert.equal(done.logs.filter((l) => l.action === "DMS_SYNC").length, 1);
      a.deliver("success");
      a.acceptReceipts(done.receipts);
      a.reconcile();
      assert.equal(a.read().attempts, 1);
      assert.equal(a.read().remoteDeliveries, done.remoteDeliveries);
      assert.equal(a.read().finishedAt, done.finishedAt);
      assert.equal(
        a.read().logs.filter((l) => l.action === "DMS_SYNC").length,
        1,
      );
    }
});
test("explicit failure stays at 5, logs failure, and retry reuses the exact packets", () => {
  const a = make();
  a.approve();
  const packets = a.read().packets;
  a.deliver("failure");
  assert.equal(a.read().plan.status, 5);
  assert.equal(a.read().syncStatus, "FAILED");
  assert.equal(a.read().finishedAt, null);
  assert.equal(a.read().remoteDeliveries, 0);
  assert.equal(a.read().logs.at(-1).action, "FAILED");
  a.deliver("success");
  assert.deepEqual(a.read().packets, packets);
  assert.equal(a.read().attempts, 2);
  assert.equal(a.read().remoteDeliveries, 1);
});
test("unknown outcomes require readback; lost receipts finish without a second delivery", () => {
  for (const outcome of ["timeout-before", "lost-receipt"]) {
    const a = make();
    a.approve();
    a.deliver(outcome);
    assert.equal(a.read().syncStatus, "UNKNOWN");
    assert.equal(a.read().plan.status, 5);
    assert.equal(a.read().finishedAt, null);
    assert.throws(() => a.deliver("success"), /RECONCILE_FIRST/);
    a.reconcile();
    if (outcome === "timeout-before") {
      assert.equal(a.read().syncStatus, "FAILED");
      a.deliver("success");
    } else assert.equal(a.read().attempts, 1);
    assert.equal(a.read().plan.status, 10);
    assert.equal(a.read().remoteDeliveries, 1);
  }
});
test("Z partial delivery keeps 5 until both legs are reconciled; retry never duplicates ADD", () => {
  const a = make("JD", "Z");
  a.approve();
  a.deliver("partial");
  a.reconcile();
  assert.equal(a.read().plan.status, 5);
  assert.equal(a.read().finishedAt, null);
  assert.equal(a.read().receipts.length, 1);
  assert.equal(a.read().remoteDeliveries, 1);
  const first = a.read().receipts[0];
  a.deliver("success");
  assert.equal(a.read().plan.status, 10);
  assert.equal(a.read().remoteDeliveries, 2);
  assert.deepEqual(a.read().receipts[0], first);
});
test("wrong source, stale version, conflicting or incomplete receipt cannot fabricate completion", () => {
  const a = make("XN", "Z");
  a.approve();
  const packets = a.read().packets;
  const r = (p, i) => ({
    key: p.key,
    sourcePlanId: p.PLANE_NUM,
    sourceVersionId: p.sourceVersionId,
    dmsId: `dms-${i}`,
    syncedAt: "2026-09-12T10:00:00Z",
  });
  const valid = packets.map(r);
  for (const mutation of [
    { sourcePlanId: "other" },
    { sourceVersionId: "old" },
    { key: "unknown" },
    { syncedAt: "bad" },
    { dmsId: "" },
  ]) {
    assert.throws(
      () => a.acceptReceipts([valid[0], { ...valid[1], ...mutation }]),
      /INVALID_RECEIPT/,
    );
    assert.equal(a.read().receipts.length, 0);
  }
  assert.throws(
    () => a.acceptReceipts([valid[0], { ...valid[1], dmsId: valid[0].dmsId }]),
    /DUPLICATE_DMS_ID/,
  );
  a.acceptReceipts([valid[0]]);
  assert.equal(a.read().plan.status, 5);
  assert.equal(a.read().finishedAt, null);
  assert.throws(
    () => a.acceptReceipts([{ ...valid[0], dmsId: "different" }]),
    /CONFLICTING_RECEIPT/,
  );
  a.acceptReceipts(valid);
  const before = a.read();
  assert.equal(before.plan.status, 10);
  assert.throws(
    () => a.acceptReceipts([{ ...valid[0], sourceVersionId: "old" }]),
    /INVALID_RECEIPT/,
  );
  assert.deepEqual(a.read(), before);
});
test("payload validation prevents malformed quantities, unknown chains and non-5 writeback", () => {
  for (const status of [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11])
    assert.throws(
      () => mockDmsPackets({ ...seed(), status }),
      /REQUIRES_STATUS_5/,
    );
  for (const qty of ["-1", "NaN", "Infinity", "1.0001", "1e3"])
    assert.throws(
      () =>
        mockDmsPackets({
          ...seed(),
          status: 5,
          skus: [{ ...seed().skus[0], qty }],
        }),
      /INVALID_QUANTITY/,
    );
  assert.throws(
    () => mockDmsPackets({ ...seed(), status: 5, typeCode: "UNKNOWN" }),
    /INVALID_PLAN/,
  );
  assert.throws(
    () =>
      mockDmsPackets({
        ...seed(),
        status: 5,
        skus: [{ ...seed().skus[0], addQty: "1" }],
      }),
    /MONTHLY_ADJUSTMENTS/,
  );
  assert.throws(
    () =>
      mockDmsPackets({
        ...seed(),
        status: 5,
        skus: [seed().skus[0], seed().skus[0]],
      }),
    /INVALID_SKUS/,
  );
  const a = make();
  assert.throws(() => a.acceptReceipts([]), /NOT_STARTED/);
  a.approve();
  const detached = a.read();
  detached.plan.status = 10;
  assert.equal(a.read().plan.status, 5);
});

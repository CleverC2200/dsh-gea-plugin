import test from "node:test";
import assert from "node:assert/strict";
import { fcStorage } from "../src/host/fc-storage.ts";

function fixture() {
  const plans = new Map();
  let rules = null,
    writes = 0,
    loseAck = false;
  const config = {
    published: true,
    dataSourceCode: "test",
    planningLayout: "legacy",
    warehouseIds: { "001": "warehouse-one" },
  };
  const scope = { tenantId: "T", userId: "U", warehouses: ["001"] };
  const execute = async (r) => {
    assert.equal(r.parameters.warehouseId, "warehouse-one");
    if (r.sql.startsWith("SELECT")) {
      const records = r.sql.includes("plan_import")
        ? [...plans.values()]
        : rules === null
          ? []
          : [{ rules }];
      return { success: true, code: 200, result: { records, hasMore: false } };
    }
    writes++;
    assert.equal(r.pageNo, undefined);
    assert.ok(r.idempotencyKey);
    const p = r.parameters;
    let affectedRows = 1;
    if (r.sql.includes("plan_import")) {
      affectedRows = 0;
      for (let i = 0; Object.hasOwn(p, "sku" + i); i++) {
        const row = {
          warehouse_name: p["name" + i],
          warehouse_code: p["code" + i],
          sku: p["sku" + i],
          product_name: p["product" + i],
          month: p["month" + i],
          category: p["category" + i],
          material_group: p["material" + i],
          outbound_qty: String(p["outbound" + i]),
          transfer_qty: String(p["transfer" + i]),
          suggested_outbound_qty: p["suggestedOut" + i],
          suggested_transfer_qty: p["suggestedTransfer" + i],
        };
        plans.set(row.month + ":" + row.sku, row);
        affectedRows++;
      }
    } else rules = p.rules;
    if (loseAck) throw Error("lost acknowledgement");
    return { success: true, code: 200, result: { affectedRows } };
  };
  return {
    run: (input) => fcStorage(config, scope, { warehouseCode: "001", ...input }, execute),
    config,
    scope,
    execute,
    writes: () => writes,
    lose: () => {
      loseAck = true;
    },
    plans,
  };
}
const item = (sku = "A", qty = 10) => ({
  warehouseName: "一号仓",
  warehouseCode: "001",
  sku,
  productName: sku,
  month: "2026-10",
  outboundQty: qty,
  transferQty: 0,
});

test("legacy UPSERT retains unchanged products and performs no write for an identical value", async () => {
  const f = fixture();
  const first = await f.run({
    operation: "save",
    kind: "plans",
    baseRevision: "0",
    value: { plans: [item(), item("B")] },
  });
  assert.equal(first.status, "saved");
  assert.match(first.revision, /^legacy:[a-f0-9]{64}$/);
  const same = await f.run({
    operation: "save",
    kind: "plans",
    baseRevision: first.revision,
    value: first.value,
  });
  assert.equal(same.status, "saved");
  assert.equal(f.writes(), 1);
  const changed = structuredClone(first.value);
  changed.plans[0].outboundQty = 12;
  const second = await f.run({
    operation: "save",
    kind: "plans",
    baseRevision: first.revision,
    value: changed,
  });
  assert.equal(second.status, "saved");
  assert.equal(second.value.plans[1].outboundQty, 10);
  assert.equal(f.writes(), 2);
  await assert.rejects(
    () =>
      f.run({
        operation: "save",
        kind: "plans",
        baseRevision: first.revision,
        value: changed,
      }),
    /REVISION_CONFLICT/,
  );
  await assert.rejects(
    () =>
      f.run({
        operation: "save",
        kind: "plans",
        baseRevision: second.revision,
        value: { plans: [item()] },
      }),
    /PARTIAL_SNAPSHOT/,
  );
  assert.equal(f.writes(), 2);
});
test("lost acknowledgement is reconciled by reading the same content without another UPSERT", async () => {
  const f = fixture();
  f.lose();
  const input = {
    operation: "save",
    kind: "plans",
    baseRevision: "0",
    value: { plans: [item()] },
  };
  const result = await f.run(input);
  assert.equal(result.status, "unknown");
  const verified = await f.run({ ...input, operation: "verify" });
  assert.equal(verified.status, "saved");
  assert.equal(verified.idempotencyKey, result.idempotencyKey);
  assert.equal(f.writes(), 1);
});
test("cycle fallback and dated explicit warehouse rule retain original table shape and precedence", async () => {
  const f = fixture();
  const value = {
    days: 9,
    rules: [
      {
        level: "warehouse",
        object: "001",
        days: 12,
        from: "2026-10-01",
        to: "2026-10-31",
        status: "effective",
      },
    ],
  };
  const result = await f.run({
    operation: "save",
    kind: "cycles",
    baseRevision: "0",
    value,
  });
  assert.equal(result.status, "saved");
  assert.deepEqual(result.value, value);
  assert.deepEqual((await f.run({ operation: "load", kind: "cycles" })).value, value);
});
test("missing warehouse mapping, incomplete pagination and oversized atomic batch reject without writes", async () => {
  const f = fixture();
  delete f.config.warehouseIds["001"];
  await assert.rejects(() => f.run({ operation: "load", kind: "plans" }), /WAREHOUSE_ID_REQUIRED/);
  const g = fixture();
  await assert.rejects(
    () =>
      g.run({
        operation: "save",
        kind: "plans",
        baseRevision: "0",
        value: { plans: Array.from({ length: 19 }, (_, i) => item(String(i))) },
      }),
    /ATOMIC_BATCH_LIMIT/,
  );
  assert.equal(g.writes(), 0);
  await assert.rejects(
    () =>
      fcStorage(
        g.config,
        g.scope,
        { warehouseCode: "001", operation: "load", kind: "plans" },
        async () => ({
          success: true,
          code: 200,
          result: { records: [], hasMore: true },
        }),
      ),
    /READ_INCOMPLETE/,
  );
});

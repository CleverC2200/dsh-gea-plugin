import test from "node:test";
import assert from "node:assert/strict";
import { InventoryReadCache } from "../src/host/inventory-read-cache.ts";
test("inventory snapshots last twenty minutes without a sliding expiry", () => {
  let now = 1000;
  const c = new InventoryReadCache(() => now);
  const scope = new AbortController();
  c.set(scope.signal, "base/date/filter", { rows: [{ qty: 12 }] });
  now += 19 * 60 * 1000;
  const hit = c.get(scope.signal, "base/date/filter", 0);
  assert.equal(hit.rows[0].qty, 12);
  hit.rows[0].qty = 99;
  assert.equal(c.get(scope.signal, "base/date/filter", 0).rows[0].qty, 12);
  now += 60 * 1000;
  assert.equal(c.get(scope.signal, "base/date/filter", 0), undefined);
});
test("manual refresh, different scope and identity cannot reuse a snapshot", () => {
  let now = 1000;
  const c = new InventoryReadCache(() => now),
    a = new AbortController(),
    b = new AbortController();
  c.set(a.signal, "base", { rows: [{ qty: 12 }] });
  assert.equal(c.get(a.signal, "branch", 0), undefined);
  assert.equal(c.get(a.signal, "base", 1001), undefined);
  c.set(a.signal, "base", { rows: [{ qty: 12 }] });
  a.abort();
  assert.throws(() => c.get(a.signal, "base", 0));
  assert.equal(c.get(b.signal, "base", 0), undefined);
});
test("denials and clipped fields are never cached; successful zero is retained", () => {
  const c = new InventoryReadCache(),
    s = new AbortController().signal;
  for (const value of [
    { success: false, rows: [] },
    { failure: { code: "ROW_SCOPE_DENIED" }, rows: [] },
    { rows: [{}], rejectedColumns: ["qty"] },
  ]) {
    c.set(s, "x", value);
    assert.equal(c.get(s, "x", 0), undefined);
  }
  c.set(s, "x", { rows: [{ qty: 0 }] });
  assert.equal(c.get(s, "x", 0).rows[0].qty, 0);
});

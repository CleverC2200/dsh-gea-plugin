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

test("empty rows and missing snapshots do not stick for twenty minutes", () => {
  const c = new InventoryReadCache(),
    s = new AbortController().signal;
  for (const value of [
    { rows: [] },
    { rows: [{ day: null }] },
    { rows: [{ snapshot_date: null, demand: 0 }] },
    { rows: [{ qty: null }] },
  ]) {
    c.set(s, "x", value, true);
    assert.equal(c.get(s, "x", 0), undefined);
  }
  c.set(s, "x", { rows: [{ snapshot_date: "2026-10-25", demand: 0 }] });
  assert.equal(c.get(s, "x", 0).rows[0].demand, 0);
});

test("nullable plan metadata does not discard an otherwise valid cached detail", () => {
  let now = 1000;
  const cache = new InventoryReadCache(() => now);
  const scope = new AbortController().signal;
  const result = { rows: [{ sku: "A", available_qty: 42, snapshot_date: null, plan_month: null }] };
  cache.set(scope, "replenishment.detail", result);
  now += 19 * 60 * 1000;
  assert.deepEqual(cache.get(scope, "replenishment.detail", 0), result);
  now += 60 * 1000;
  assert.equal(cache.get(scope, "replenishment.detail", 0), undefined);
});

test("pending reads keep refresh, query and identity scopes separate", async () => {
  const cache = new InventoryReadCache(),
    identity = new AbortController();
  let calls = 0,
    finish;
  const wait = new Promise((resolve) => {
    finish = resolve;
  });
  const read = async () => {
    calls++;
    await wait;
    return { rows: [{ qty: 1 }] };
  };
  const jobs = [
    cache.share(identity.signal, "query/refresh0", new AbortController().signal, read),
    cache.share(identity.signal, "query/refresh1", new AbortController().signal, read),
    cache.share(identity.signal, "other/refresh0", new AbortController().signal, read),
    cache.share(new AbortController().signal, "query/refresh0", new AbortController().signal, read),
  ];
  await new Promise(setImmediate);
  finish();
  await Promise.all(jobs);
  assert.equal(calls, 4);
});

test("the last cancelled waiter cancels the physical read and later callers start fresh", async () => {
  const cache = new InventoryReadCache(),
    identity = new AbortController(),
    a = new AbortController(),
    b = new AbortController();
  let transport;
  const read = (signal) => {
    transport = signal;
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  };
  const first = cache.share(identity.signal, "q", a.signal, read),
    second = cache.share(identity.signal, "q", b.signal, read);
  const rejected = Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  await new Promise(setImmediate);
  a.abort();
  assert.equal(transport.aborted, false);
  b.abort();
  assert.equal(transport.aborted, true);
  await rejected;
  assert.deepEqual(
    await cache.share(identity.signal, "q", new AbortController().signal, async () => ({
      rows: [{ qty: 2 }],
    })),
    { rows: [{ qty: 2 }] },
  );
});

test("identity cancellation rejects every subscriber and rejected reads are not retained", async () => {
  const cache = new InventoryReadCache(),
    identity = new AbortController();
  const read = (signal) =>
    new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
  const jobs = [1, 2].map(() =>
    cache.share(identity.signal, "q", new AbortController().signal, read),
  );
  const rejected = jobs.map((job) => assert.rejects(job, { name: "AbortError" }));
  await new Promise(setImmediate);
  identity.abort();
  await Promise.all(rejected);
  const next = new AbortController();
  let attempts = 0;
  const denied = async () => {
    attempts++;
    throw Object.assign(Error("denied"), { code: "ROW_SCOPE_DENIED" });
  };
  await assert.rejects(cache.share(next.signal, "q", next.signal, denied), {
    code: "ROW_SCOPE_DENIED",
  });
  await assert.rejects(cache.share(next.signal, "q", next.signal, denied), {
    code: "ROW_SCOPE_DENIED",
  });
  assert.equal(attempts, 2);
});

test("late pre-refresh reads cannot overwrite newer data or qualify as fresh", () => {
  let now = 1000;
  const cache = new InventoryReadCache(() => now),
    identity = new AbortController();
  now = 1300;
  cache.set(identity.signal, "q", { rows: [{ qty: 2 }] }, false, 1200);
  now = 1400;
  cache.set(identity.signal, "q", { rows: [{ qty: 1 }] }, false, 1000);
  assert.equal(cache.get(identity.signal, "q", 1200).rows[0].qty, 2);
  cache.set(identity.signal, "other", { rows: [{ qty: 1 }] }, false, 1000);
  assert.equal(cache.get(identity.signal, "other", 1200), undefined);
});

test("atomic empty-page markers and zero-source aggregates cannot hide a later ready inventory", () => {
  const cache = new InventoryReadCache(),
    scope = new AbortController().signal;
  for (const result of [
    { rows: [{ page_scope_total: 0, page_row_present: null, warehouse_code: null, sku: null }] },
    { rows: [{ row_count: 0, total_qty: null, recommended_qty: null }] },
  ]) {
    cache.set(scope, "selected-warehouse", result);
    assert.equal(cache.get(scope, "selected-warehouse", 0), undefined);
  }
  const zero = { rows: [{ row_count: 1, total_qty: 0 }] };
  cache.set(scope, "selected-warehouse", zero);
  assert.deepEqual(cache.get(scope, "selected-warehouse", 0), zero);
});

import test from "node:test";
import assert from "node:assert/strict";
import { recoverInventorySnapshot } from "../src/host/inventory-read-cache.ts";

test("first load recovers an initially unavailable snapshot without manual refresh", async () => {
  let calls = 0;
  const value = await recoverInventorySnapshot(
    async () => (++calls === 1 ? { rows: [{ day: null }] } : { rows: [{ day: "2026-10-25" }] }),
    new AbortController().signal,
  );
  assert.equal(calls, 2);
  assert.equal(value.rows[0].day, "2026-10-25");
});
test("genuinely empty source stops after one follow-up", async () => {
  let calls = 0;
  const value = await recoverInventorySnapshot(async () => {
    calls++;
    return { rows: [] };
  }, new AbortController().signal);
  assert.equal(calls, 2);
  assert.deepEqual(value.rows, []);
});
test("normal zero, failed response and denied columns are never retried", async () => {
  for (const value of [
    { rows: [{ qty: 0 }] },
    { rows: [], success: false },
    { rows: [], failure: { reasonCode: "ROW_SCOPE_DENIED" } },
    { rows: [], rejectedColumns: ["day"] },
  ]) {
    let calls = 0;
    assert.equal(
      await recoverInventorySnapshot(async () => {
        calls++;
        return value;
      }, new AbortController().signal),
      value,
    );
    assert.equal(calls, 1);
  }
});
test("thrown gateway errors keep their original identity and are not retried", async () => {
  const error = Object.assign(new Error("denied"), { code: "ROW_SCOPE_DENIED" });
  let calls = 0;
  await assert.rejects(
    recoverInventorySnapshot(async () => {
      calls++;
      throw error;
    }, new AbortController().signal),
    (e) => e === error,
  );
  assert.equal(calls, 1);
});
test("leaving the page or changing identity cancels the pending recovery", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = recoverInventorySnapshot(async () => {
    calls++;
    queueMicrotask(() => controller.abort());
    return { rows: [{ day: null }] };
  }, controller.signal);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(calls, 1);
});

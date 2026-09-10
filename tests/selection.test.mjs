import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test(
  "a new query invalidates the previous selection and browser data cannot enter a snapshot",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    assert.equal((await app.login()).ok, true);
    const first = (await app.rpc("plans", { pageNo: 1 })).value;
    assert.ok(first.queryId, "each query has a Host-owned identity");
    assert.equal(first.records[0].planId, "9007199254740993");
    assert.equal(first.records[0].currentQty, "1.2300");
    const second = (await app.rpc("plans", { pageNo: 2 })).value;
    const stale = await app.rpc("prepare", {
      queryId: first.queryId,
      planId: first.records[0].planId,
    });
    assert.equal(stale.error.code, "STALE_SELECTION");
    const forged = await app.rpc("prepare", {
      queryId: second.queryId,
      planId: second.records[0].planId,
      detail: { currentQty: "999" },
    });
    assert.equal(forged.error.code, "INVALID_PAYLOAD");
    const prepared = await app.rpc("prepare", {
      queryId: second.queryId,
      planId: second.records[0].planId,
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    assert.equal(prepared.value.snapshot.record.currentQty, "1.2300");
    assert.equal(JSON.stringify(prepared).includes("fixture-gea-token"), false);
  },
);

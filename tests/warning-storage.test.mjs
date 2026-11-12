import test from "node:test";
import assert from "node:assert/strict";
import { warningStorage } from "../src/host/warning-storage.ts";
const owner = {
  key: '["production","tenant","1"]',
  environment: "production",
  tenantId: "tenant",
  id: "1",
  username: "test",
  name: "测试",
};
const task = (id, who = owner) => ({
  id,
  metric: "订单满足率",
  scope: "品类",
  enabled: false,
  owner: who,
});
function fixture(
  tasks = [task("a"), task("z"), task("other", { key: "other" }), { id: "legacy" }],
) {
  const calls = [];
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (!sql.startsWith("SELECT")) throw Error("unexpected mutation");
    const records = sql.includes("FROM detection_tasks")
      ? tasks.map((payload) => ({ id: payload.id, payload: JSON.stringify(payload) }))
      : [];
    return { success: true, result: { records } };
  };
  return { calls, call: (input) => warningStorage(owner, input, execute) };
}
test("whitelist reads retain only exact owner and never adopt legacy tasks", async () => {
  const f = fixture();
  const value = await f.call({ operation: "load" });
  assert.deepEqual(
    value.tasks.map((x) => x.id),
    ["a", "z"],
  );
  assert.equal(value.runs.length, 0);
  assert.equal(value.events.length, 0);
  assert.ok(f.calls.every((c) => c.sql.startsWith("SELECT")));
  assert.ok(f.calls.every((c) => !c.sql.includes(owner.key)));
});
test("ordering does not change the revision or repeat a completed save", async () => {
  const f = fixture();
  const value = await f.call({ operation: "load" });
  const state = { tasks: value.tasks.toReversed(), runs: value.runs, events: value.events };
  const saved = await f.call({ operation: "save", state, expectedRevision: value.revision });
  assert.equal(saved.saved, true);
  assert.equal(saved.revision, value.revision);
});
test("foreign owner, duplicate ids and omitted history are rejected before writes", async () => {
  const f = fixture();
  const value = await f.call({ operation: "load" });
  const state = { tasks: value.tasks, runs: [], events: [] };
  await assert.rejects(
    f.call({
      operation: "save",
      state: { ...state, tasks: [...state.tasks, task("new", { key: "other" })] },
      expectedRevision: value.revision,
    }),
    { code: "WARNING_OWNER_DENIED" },
  );
  await assert.rejects(
    f.call({
      operation: "save",
      state: { ...state, tasks: [...state.tasks, state.tasks[0]] },
      expectedRevision: value.revision,
    }),
    { code: "WARNING_STATE_INVALID" },
  );
  await assert.rejects(
    f.call({ operation: "save", state: { ...state, tasks: [] }, expectedRevision: value.revision }),
    { code: "WARNING_STATE_INCOMPLETE" },
  );
  await assert.rejects(
    f.call({
      operation: "save",
      state: { ...state, tasks: [...state.tasks, task("new")] },
      expectedRevision: "stale",
    }),
    { code: "WARNING_WRITE_CONFLICT" },
  );
});
test("required-column and payload identity failures never become an empty result", async () => {
  await assert.rejects(
    warningStorage(owner, { operation: "load" }, async () => ({
      success: true,
      result: { records: [{ id: "a" }] },
    })),
  );
  await assert.rejects(
    warningStorage(owner, { operation: "load" }, async () => ({
      success: true,
      result: { records: [{ id: "a", payload: JSON.stringify(task("b")) }] },
    })),
    { code: "WARNING_RECORD_INVALID" },
  );
  await assert.rejects(
    warningStorage(owner, { operation: "load" }, async () => ({
      success: false,
      message: "denied",
    })),
    { code: "WARNING_SQL_REQUEST_FAILED" },
  );
});

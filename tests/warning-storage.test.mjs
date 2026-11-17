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

function directoryFixture() {
  const records = new Map(),
    calls = [];
  const execute = async (sql, parameters) => {
    calls.push({ sql, parameters });
    if (sql.startsWith("SELECT")) {
      const rows = sql.includes("FROM detection_tasks")
        ? [...records.values()].filter(
            (row) => !sql.includes("WHERE t.id") || row.id === parameters.gea_p1,
          )
        : [];
      return {
        success: true,
        result: {
          records: rows
            .slice(parameters.gea_p200, parameters.gea_p200 + parameters.gea_p199)
            .map((row) => ({ id: row.id, payload: JSON.stringify(row) })),
        },
      };
    }
    assert.ok(!/CREATE|DELETE|TRUNCATE/.test(sql));
    let affectedRows = 0;
    if (sql.startsWith("INSERT INTO detection_tasks")) {
      assert.equal(parameters.gea_p3, "品类");
      const payload = JSON.parse(parameters.gea_p6);
      assert.equal(payload.kind, "warning-owner-directory");
      if (!records.has(payload.id)) {
        records.set(payload.id, payload);
        affectedRows = 1;
      }
    } else if (sql.startsWith("UPDATE detection_tasks")) {
      const prior = records.get(parameters.gea_p200);
      if (prior && JSON.parse(parameters.gea_p199).revision === prior.revision) {
        records.set(prior.id, JSON.parse(parameters.gea_p6));
        affectedRows = 1;
      }
    } else throw Error("unexpected SQL " + sql);
    return { success: true, result: { affectedRows } };
  };
  return {
    records,
    calls,
    execute,
    call: (input, who = owner) => warningStorage(who, input, execute),
  };
}
const ownerRow = { type: "品类", scope: "汤圆", name: "测试负责人", employeeNo: "10000001" };
test("owner directory is shared through the whitelist, can remain empty and does not become a detection task", async () => {
  const f = directoryFixture();
  const initial = await f.call({ operation: "directory-load" });
  assert.deepEqual(initial.owners, []);
  const initialState = await f.call({ operation: "load" });
  const saved = await f.call({
    operation: "directory-save",
    directoryId: initial.directoryId,
    revision: 0,
    owners: [ownerRow],
  });
  assert.equal(saved.revision, 1);
  assert.deepEqual(
    (await warningStorage(owner, { operation: "directory-load" }, f.execute)).owners,
    [ownerRow],
  );
  const state = await f.call({ operation: "load" });
  assert.deepEqual(state, initialState);
  const empty = await f.call({
    operation: "directory-save",
    directoryId: initial.directoryId,
    revision: 1,
    owners: [],
  });
  assert.equal(empty.revision, 2);
  assert.deepEqual((await f.call({ operation: "directory-load" })).owners, []);
  await assert.rejects(
    f.call({
      operation: "directory-save",
      directoryId: initial.directoryId,
      revision: 1,
      owners: [ownerRow],
    }),
    { code: "WARNING_WRITE_CONFLICT" },
  );
});
test("directory save rejects identity switches, stale writes, foreign rows and task API bypass", async () => {
  const f = directoryFixture();
  const first = await f.call({ operation: "directory-load" });
  const other = { ...owner, id: "2", key: "other-user" };
  const second = await f.call({ operation: "directory-load" }, other);
  assert.notEqual(first.directoryId, second.directoryId);
  await assert.rejects(
    f.call(
      {
        operation: "directory-save",
        directoryId: first.directoryId,
        revision: 0,
        owners: [ownerRow],
      },
      other,
    ),
    { code: "WARNING_OWNER_DENIED" },
  );
  const writes = await Promise.allSettled(
    [1, 2].map(() =>
      f.call({
        operation: "directory-save",
        directoryId: first.directoryId,
        revision: 0,
        owners: [ownerRow],
      }),
    ),
  );
  assert.equal(writes.filter((row) => row.status === "fulfilled").length, 1);
  assert.deepEqual((await f.call({ operation: "directory-load" }, other)).owners, []);
  const state = await f.call({ operation: "load" });
  await assert.rejects(
    f.call({
      operation: "save",
      expectedRevision: state.revision,
      state: { tasks: [...f.records.values()], runs: [], events: [] },
    }),
    { code: "WARNING_STATE_INVALID" },
  );
  f.records.get(first.directoryId).owner = other;
  await assert.rejects(f.call({ operation: "directory-load" }), { code: "WARNING_OWNER_DENIED" });
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { registerBranchInventoryTool } from "../src/host/branch-inventory-tool.ts";
import { allowedTools, PROFILES } from "../src/host/prompt-policy.ts";

const directory = resolve("../dsh-agent-workbench/business/inventory-fc");
const config = JSON.parse(await readFile(resolve(directory, "sql.config.json"), "utf8"));
const fixture = (execute) => {
  let tool,
    preset = "gea-html-inventory-fc",
    enabled = true;
  const identity = new AbortController(),
    calls = [],
    listeners = new Set(),
    agent = { id: "branch-session" };
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      register: (value) => {
        tool = value;
        return () => {};
      },
    },
    agents: { get: () => agent },
    sessionProjections: { stateOf: () => preset },
    agentResources: {
      list: async () => [{ id: preset, kind: "prompt", installed: true, enabled }],
      watch: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const business = {
    config: { requestTimeoutMs: 1000 },
    identitySignal: () => identity.signal,
    pluginSql: async (request, signal, configured) => {
      const id = Object.keys(config.queries).find(
        (id) => config.queries[id].request.sql === request.sql,
      );
      calls.push({ id, request, configured });
      return execute(id, request, signal);
    },
    moduleMcp: async () => {
      throw Error("Cube must not be used");
    },
  };
  registerBranchInventoryTool(ctx, business, [
    {
      directory,
      manifest: {
        id: "inventory-fc",
        sqlConfig: "sql.config.json",
        gea: { consumerCode: "branch-inventory" },
      },
    },
  ]);
  return {
    calls,
    identity,
    switchTo: (value) => {
      preset = value;
    },
    disable: () => {
      enabled = false;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    call: (args) => tool.execute(args, { agent, signal: new AbortController().signal }),
  };
};
function data(id) {
  const q = config.queries[id];
  const values =
    id === "source.branch-stock-date" || id === "source.health-date"
      ? { day: "2026-10-22" }
      : id === "health.summary"
        ? {
            row_count: 2,
            total_qty: 130,
            available_qty: 85,
            pack_unit_qty: 45,
            freeze_qty: 0,
            max_age: 360,
            overaged_qty: 20,
            stagnant_qty: 10,
          }
        : id === "replenishment.summary"
          ? {
              row_count: 20,
              recommended_qty: 35,
              replenishment_sku_count: 1,
              inventory_qty: 130,
              available_qty: 85,
              occupied_qty: 45,
              frozen_qty: 0,
            }
          : {
              warehouse_code: "W1",
              sku: "S1",
              recommended_qty: 35,
              page_scope_total: 1,
              page_row_present: 1,
            };
  return {
    rows: [Object.fromEntries(q.resultColumns.map((name) => [name, values[name] ?? 0]))],
    returnedColumns: q.resultColumns,
    rejectedColumns: [],
  };
}
test("branch summary and follow-up suggestions use installed page calculations and fresh scoped parameters", async () => {
  const f = fixture(async (id) => data(id));
  const summary = JSON.parse(await f.call({ view: "summary", asOf: "2026-10-23", cycleDays: 10 }));
  assert.equal(summary.summary.recommended_qty, 35);
  assert.equal(summary.summary.frozen_qty, 0);
  const list = JSON.parse(
    await f.call({
      view: "replenishment",
      warehouseCode: "W1",
      asOf: "2026-10-23",
      cycleDays: 10,
    }),
  );
  assert.equal(list.rows[0].recommended_qty, 35);
  assert.equal(list.total, 1);
  assert.equal(list.readonly, true);
  assert.deepEqual(
    f.calls.map((c) => c.id),
    [
      "source.branch-stock-date",
      "replenishment.summary",
      "source.branch-stock-date",
      "replenishment-suggestions.detail.atomic",
    ],
  );
  const last = f.calls.at(-1).request.parameters;
  assert.equal(last.gea_p2, "W1");
  assert.equal(last.gea_p2200, "2026-10-22");
  assert.equal(last.gea_p2302, "2026-10-23");
  assert.equal(last.gea_p2303, 10);
  assert.ok(
    f.calls.every((call) => call.configured && call.request.consumerCode === "branch-inventory"),
  );
  assert.ok(allowedTools(PROFILES["gea-html-inventory-fc"]).has("gea_branch_inventory"));
  assert.ok(!allowedTools(PROFILES["gea-html-inventory-aqkc"]).has("gea_branch_inventory"));
});
test("denied snapshots stop once; unrelated or disabled Sessions cannot use the inventory tool", async () => {
  const f = fixture(async () => {
    const { GeaSqlError } = await import("../src/html-sql.ts");
    throw Object.assign(new GeaSqlError("ROW_SCOPE_DENIED", "denied"), {
      failure: { stage: "AUTHORIZE", reasonCode: "ROW_SCOPE_DENIED" },
    });
  });
  const denied = JSON.parse(await f.call({}));
  assert.equal(denied.success, false);
  assert.equal(denied.failure.reasonCode, "ROW_SCOPE_DENIED");
  assert.equal(denied.summary, undefined);
  assert.equal(f.calls.length, 1);
  f.switchTo("gea-html-inventory-aqkc");
  await assert.rejects(f.call({}), /GEA_BRANCH_INVENTORY_NOT_AVAILABLE/);
  const disabled = fixture(async (id) => data(id));
  disabled.disable();
  await assert.rejects(disabled.call({}), /GEA_AGENT_RESOURCE_DISABLED/);
  assert.equal(disabled.calls.length, 0);
});
test("branch age and risk questions use the same scoped page health summary", async () => {
  const f = fixture(async (id) => data(id));
  const result = JSON.parse(await f.call({ view: "health", asOf: "2026-10-23" }));
  assert.equal(result.summary.max_age, 360);
  assert.equal(result.summary.total_qty, 130);
  assert.deepEqual(
    f.calls.map((call) => call.id),
    ["source.health-date", "health.summary"],
  );
});
test("identity changes and cancellation prevent late branch data from being published", async () => {
  let f;
  f = fixture(async (id) => {
    f.switchTo("gea-html-inventory-aqkc");
    return data(id);
  });
  await assert.rejects(f.call({}), /GEA_BUSINESS_IDENTITY_CHANGED/);
  let stopped;
  stopped = fixture(async (id) => {
    stopped.identity.abort();
    return data(id);
  });
  await assert.rejects(stopped.call({}), { name: "AbortError" });
});

test("resource changes abort an in-flight branch query and release the watcher", async () => {
  let f;
  f = fixture(async (id) => {
    assert.equal(f.listenerCount(), 1);
    f.disable();
    return data(id);
  });
  await assert.rejects(f.call({ view: "summary", asOf: "2026-10-23" }), { name: "AbortError" });
  assert.equal(f.listenerCount(), 0);
  const unchanged = fixture(async (id) => data(id));
  await unchanged.call({ view: "summary", asOf: "2026-10-23" });
  assert.equal(unchanged.listenerCount(), 0);
});

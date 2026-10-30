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
    source = new AbortController(),
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
      cubeSource: (id) =>
        enabled && id === "auto-negotiation"
          ? { consumerCode: "workbench", signal: source.signal }
          : undefined,
      list: async () => [{ id: preset, kind: "prompt", installed: true, enabled }],
      watch: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  const business = {
    status: () => ({ authenticated: true }),
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
      source.abort();
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
    call: (args) => tool.execute(args, { agent, signal: new AbortController().signal }),
  };
};
test("managed orchestration reads page targets using its own Workbench authorization", async () => {
  const f = fixture(async (id) => data(id));
  f.switchTo("auto-negotiation");
  const result = JSON.parse(await f.call({ view: "summary", asOf: "2026-10-23" }));
  assert.equal(result.summary.recommended_qty, 35);
  assert.equal(result.summary.available_qty, 85);
  assert.equal(result.summary.target_inventory_qty, 150);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((call) => call.request.consumerCode === "workbench"));
  f.disable();
  const count = f.calls.length;
  await assert.rejects(f.call({}), /GEA_|abort/i);
  assert.equal(f.calls.length, count);
});
function data(id) {
  const q = config.queries[id];
  const values =
    id === "source.branch-stock-date" || id === "source.health-date"
      ? { day: "2026-10-22" }
      : ["health.summary", "health.cards"].includes(id)
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
              target_inventory_qty: 150,
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
test("base supply questions use receiving-branch executions, full-scope metrics and ten-row pages", async () => {
  const f = fixture(async (id, request) => {
    const result = data(id);
    if (id === "branch-supply.summary")
      Object.assign(result.rows[0], {
        row_count: 43,
        demand: request.parameters.gea_p6 === "current" ? 17068 : 32124,
        shipped: 26416,
        pending: 5999,
        in_transit: 1644,
        fulfillment_rate: 26416 / 32124,
      });
    else if (id === "branch-supply.detail.atomic")
      Object.assign(result.rows[0], {
        warehouse_code: "A230",
        order_no: "BASE-SUPPLY-1",
        line_no: 1,
        base_warehouse: "N411",
        demand: 20,
        shipped: 15,
      });
    return result;
  });
  for (const [view, demand] of [["supply", 32124]]) {
    const result = JSON.parse(await f.call({ view, warehouseCode: "A230", asOf: "2026-10-30" }));
    assert.equal(result.summary.demand, demand);
    assert.equal(result.summary.in_transit, 1644);
    assert.equal(result.rows[0].base_warehouse, "N411");
    assert.equal(result.unit, "件");
    assert.match(result.metricDefinitions.countGrain, /执行单/);
  }
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every((c) => c.id.startsWith("branch-supply.")));
  assert.ok(f.calls.every((c) => c.request.parameters.gea_p3 === "A230"));
  assert.ok(
    f.calls.filter((c) => c.id.endsWith("atomic")).every((c) => c.request.parameters.gea_p8 === 10),
  );
});
test("denied base supply returns its authorization failure without a zero or customer-order fallback", async () => {
  const f = fixture(async () => ({
    success: false,
    errorCode: "ROW_SCOPE_DENIED",
    failure: { stage: "AUTHORIZE", reasonCode: "ROW_SCOPE_DENIED" },
  }));
  const result = JSON.parse(await f.call({ view: "supply-current", warehouseCode: "A230" }));
  assert.equal(result.success, false);
  assert.equal(result.failure.reasonCode, "ROW_SCOPE_DENIED");
  assert.equal(result.summary, undefined);
  assert.ok(f.calls.length <= 2);
  assert.ok(f.calls.every((c) => c.id.startsWith("orders.")));
});
test("orchestration denied SQL is not retried under the branch identity or Cube", async () => {
  const f = fixture(async () => ({
    success: false,
    errorCode: "ROW_SCOPE_DENIED",
    failure: { stage: "AUTHORIZE", reasonCode: "ROW_SCOPE_DENIED" },
  }));
  f.switchTo("auto-negotiation");
  const result = JSON.parse(await f.call({ view: "summary" }));
  assert.equal(result.success, false);
  assert.equal(result.failure.reasonCode, "ROW_SCOPE_DENIED");
  assert.equal(result.summary, undefined);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request.consumerCode, "workbench");
});
test("withdrawn orchestration source cancels pending inventory results", async () => {
  let f;
  f = fixture(async (id) => {
    f.disable();
    return data(id);
  });
  f.switchTo("auto-negotiation");
  await assert.rejects(f.call({ view: "summary" }), /abort/i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.listenerCount(), 0);
});
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
  assert.equal(last.gea_p2801, "2026-10-23");
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
    ["source.health-date", "health.cards"],
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

test("current supply questions use pending ASN orders, excluding execution and customer-order substitutes", async () => {
  const f = fixture(async (id) => {
    const response = data(id);
    if (id === "orders.summary")
      Object.assign(response.rows[0], {
        row_count: 3,
        demand: 17068,
        allocated: 1000,
        shortage: 4000,
      });
    return response;
  });
  const result = JSON.parse(
    await f.call({ view: "supply-current", warehouseCode: "A230", asOf: "2026-10-30" }),
  );
  assert.equal(result.summary.demand, 17068);
  assert.match(result.metricDefinitions.countGrain, /ASN/);
  assert.ok(f.calls.every((call) => call.id.startsWith("orders.")));
  for (const call of f.calls) {
    const [key] = Object.entries(config.queries[call.id].parameterSpec).find(
      ([, spec]) => spec.name === "warehouse_code",
    );
    assert.equal(call.request.parameters[key], "A230");
  }
});
test("operations share WMS movement dates and exact warehouse scope with the page", async () => {
  const f = fixture(async (id) => {
    const response = data(id);
    if (id === "warehouse-outbound.summary")
      Object.assign(response.rows[0], {
        row_count: 100,
        incoming_qty: 7265,
        outgoing_qty: 45489,
        incoming_source_rows: 99,
        source_rows: 100,
      });
    if (id === "branch-operations.summary")
      Object.assign(response.rows[0], { row_count: 1, fc_act_dl_qty: 2829, ccfje: 0, ysfje: 0 });
    return response;
  });
  const result = JSON.parse(
    await f.call({ view: "operations", warehouseCode: "A040", asOf: "2026-10-30" }),
  );
  assert.equal(result.movement.summary.incoming_qty, 7265);
  assert.equal(result.movement.summary.outgoing_qty, 45489);
  assert.equal(result.cost.summary.fc_act_dl_qty, 2829);
  assert.equal(result.cost.summary.ccfje, 0);
  assert.equal(result.units.inbound, "件");
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    const [key] = Object.entries(config.queries[call.id].parameterSpec).find(([, spec]) =>
      ["warehouse_code", "warehouse_id"].includes(spec.name),
    );
    assert.equal(call.request.parameters[key], "A040");
  }
  const unsupported = JSON.parse(await f.call({ view: "operations", sku: "SKU1" }));
  assert.equal(unsupported.success, false);
  assert.match(unsupported.message, /OPERATIONS_SKU_SCOPE/);
});

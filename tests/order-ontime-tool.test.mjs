import { readFileSync } from "node:fs";
const config = JSON.parse(
  readFileSync(
    "../dsh-agent-workbench/lib/business/inventory-orderworkbench/sql.config.json",
    "utf8",
  ),
);
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { registerOrderOntimeTool } from "../src/host/order-ontime-tool.ts";
import { allowedTools, PROFILES } from "../src/host/prompt-policy.ts";

function fixture(
  execute = async () => {
    const tuple = ["E1", "C", "2026-10-15", "郑州", "A", "B", "S"]
      .map((v) => Buffer.byteLength(v) + ":" + v)
      .join("");
    const rows = [{ base: "郑州", invalid: 0, ontime: 1, packed_orders: [tuple] }];
    return { rows, returnedColumns: Object.keys(rows[0]), rejectedColumns: [] };
  },
) {
  let tool,
    preset = "gea-html-inventory-orderworkbench",
    enabled = true,
    currentView;
  const identity = new AbortController(),
    listeners = new Set(),
    calls = [],
    agent = { id: "test-order" };
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
      calls.push({ request, configured });
      if (currentView === "details" && calls.length > 1) {
        const columns = config.queries["workbench.ontime.agent.details"].resultColumns;
        return { rows: [], returnedColumns: columns, rejectedColumns: [] };
      }
      return execute(request, signal);
    },
    moduleMcp: () => {
      throw Error("Cube fallback forbidden");
    },
  };
  registerOrderOntimeTool(ctx, business, [
    {
      directory: resolve("../dsh-agent-workbench/lib/business/inventory-orderworkbench"),
      manifest: {
        id: "inventory-orderworkbench",
        sqlConfig: "sql.config.json",
        gea: { consumerCode: "order" },
      },
    },
  ]);
  return {
    calls,
    identity,
    listeners,
    call: (args) => {
      currentView = args.view;
      return tool.execute(args, { agent, signal: new AbortController().signal });
    },
    switchTo: (value) => {
      preset = value;
    },
    disable: () => {
      enabled = false;
      for (const listener of listeners) listener();
    },
  };
}

const args = { start: "2026-10-01", endExclusive: "2026-11-01", base: "郑州" };
test("on-time alias uses shared execution counts and current code contract", async () => {
  const f = fixture(),
    value = JSON.parse(await f.call(args));
  assert.equal(value.current.numerator, 1);
  assert.equal(value.current.denominator, 1);
  assert.equal(value.current.pending, 0);
  assert.equal(value.current.known, 1);
  assert.equal(value.current.late, 0);
  assert.equal(value.contract.queryId, "workbench.ontime.summary");
  assert.equal(value.contract.graceHours.kamd, 18);
  assert.ok(f.calls.every((c) => c.configured));
  assert.equal(f.listeners.size, 0);
});
test("detail pagination uses the same execution scope", async () => {
  const f = fixture();
  await f.call({ ...args, view: "details", page: 2 });
  assert.match(f.calls.at(-1).request.sql, /ontime_executions/);
  assert.equal(f.calls.at(-1).request.parameters.gea_p1001, 200);
  assert.equal(f.calls.at(-1).request.parameters.gea_p1002, 200);
});
test("wrong consumer, disabled source and invalid date/page cannot execute", async () => {
  const f = fixture();
  f.switchTo("gea-html-inventory-orderfulfillment");
  await assert.rejects(() => f.call(args), /NOT_AVAILABLE/);
  f.switchTo("gea-html-inventory-orderworkbench");
  await assert.rejects(
    () => f.call({ ...args, start: "2026-02-30" }),
    /INVALID_ORDER_METRIC_PERIOD/,
  );
  await assert.rejects(() => f.call({ ...args, page: 0 }), /INVALID_ORDER_METRIC_PAGE/);
  f.disable();
  await assert.rejects(() => f.call(args), /RESOURCE_DISABLED/);
  assert.equal(f.calls.length, 0);
});
test("identity and resource cancellation reject late results and release the watcher", async () => {
  const f = fixture(async () => {
    f.identity.abort();
    return { rows: [{ numerator: 999, denominator: 1000 }] };
  });
  await assert.rejects(() => f.call(args), /abort/i);
  assert.equal(f.listeners.size, 0);
  const g = fixture(async () => {
    g.disable();
    return { rows: [] };
  });
  await assert.rejects(() => g.call(args), /abort/i);
  assert.equal(g.listeners.size, 0);
});
test("fixed ontime read is visible only to the order profile", () => {
  assert.ok(allowedTools(PROFILES["gea-html-inventory-orderworkbench"]).has("gea_order_ontime"));
  assert.equal(
    allowedTools(PROFILES["gea-html-inventory-orderfulfillment"]).has("gea_order_ontime"),
    false,
  );
});

test("empty source remains unknown and invalid packets cannot publish counts", async () => {
  const f = fixture(async () => ({
    rows: [],
    returnedColumns: ["base", "invalid", "ontime", "packed_orders"],
    rejectedColumns: [],
  }));
  assert.equal(JSON.parse(await f.call(args)).current.value, null);
  const g = fixture(async () => ({
    rows: [{ base: "郑州", invalid: 0, ontime: 1, packed_orders: ["bad"] }],
    returnedColumns: ["base", "invalid", "ontime", "packed_orders"],
    rejectedColumns: [],
  }));
  const v = JSON.parse(await g.call(args));
  assert.equal(v.current.value, null);
  assert.equal(v.sources[0].status, "error");
});

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { registerOrderOntimeTool } from "../src/host/order-ontime-tool.ts";
import { allowedTools, PROFILES } from "../src/host/prompt-policy.ts";

function fixture(
  execute = async () => ({
    rows: [
      { numerator: 10, denominator: 100, known: 90, pending: 10, late: 80 },
    ],
    returnedColumns: ["numerator", "denominator", "known", "pending", "late"],
    rejectedColumns: [],
  }),
) {
  let tool,
    preset = "gea-html-inventory-orderworkbench",
    enabled = true;
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
      list: async () => [
        { id: preset, kind: "prompt", installed: true, enabled },
      ],
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
      return execute(request, signal);
    },
    moduleMcp: () => {
      throw Error("Cube fallback forbidden");
    },
  };
  registerOrderOntimeTool(ctx, business, [
    {
      directory: resolve(
        "../dsh-agent-workbench/lib/business/inventory-orderworkbench",
      ),
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
    call: (args) =>
      tool.execute(args, { agent, signal: new AbortController().signal }),
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
test("ontime tool executes installed execution SQL with bound base and arrival month", async () => {
  const f = fixture(),
    value = JSON.parse(await f.call(args));
  assert.equal(value.queryId, "workbench.ontime.agent.summary");
  assert.equal(value.contract.graceHours.kamd, 18);
  assert.equal(value.metrics.pending, 10);
  assert.equal(value.metrics.value, 10);
  assert.equal(value.result.rows[0].numerator, 10);
  assert.match(f.calls[0].request.sql, /ontime_executions/);
  assert.match(f.calls[0].request.sql, /GROUP BY h.executeorderno/);
  assert.doesNotMatch(
    f.calls[0].request.sql,
    /SUM\(is_ontime\)|COUNT\(is_ontime\)/,
  );
  assert.equal(f.calls[0].request.consumerCode, "order");
  assert.equal(f.calls[0].request.parameters.gea_p900, "郑州");
  assert.equal(f.calls[0].request.parameters.gea_p1, "2026-10-01");
  assert.equal(f.calls[0].request.parameters.gea_p2, "2026-11-01");
  assert.equal(f.calls[0].configured, true);
  assert.equal(f.listeners.size, 0);
});
test("detail pagination uses the same execution scope", async () => {
  const f = fixture();
  await f.call({ ...args, view: "details", page: 2 });
  assert.match(f.calls[0].request.sql, /ontime_executions/);
  assert.equal(f.calls[0].request.parameters.gea_p1001, 200);
  assert.equal(f.calls[0].request.parameters.gea_p1002, 200);
});
test("wrong consumer, disabled source and invalid date/page cannot execute", async () => {
  const f = fixture();
  f.switchTo("gea-html-inventory-orderfulfillment");
  await assert.rejects(() => f.call(args), /NOT_AVAILABLE/);
  f.switchTo("gea-html-inventory-orderworkbench");
  await assert.rejects(
    () => f.call({ ...args, start: "2026-02-30" }),
    /INVALID_ONTIME_PERIOD/,
  );
  await assert.rejects(
    () => f.call({ ...args, page: 0 }),
    /INVALID_ONTIME_PAGE/,
  );
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
  assert.ok(
    allowedTools(PROFILES["gea-html-inventory-orderworkbench"]).has(
      "gea_order_ontime",
    ),
  );
  assert.equal(
    allowedTools(PROFILES["gea-html-inventory-orderfulfillment"]).has(
      "gea_order_ontime",
    ),
    false,
  );
});

test("zero denominator remains unknown and inconsistent counters are rejected", async () => {
  const empty = fixture(async () => ({
    rows: [{ numerator: 0, denominator: 0, known: 0, pending: 0, late: 0 }],
  }));
  assert.equal(JSON.parse(await empty.call(args)).metrics.value, null);
  for (const row of [
    { numerator: 10, denominator: 100, known: 90, pending: 9, late: 80 },
    { numerator: 10, denominator: 100, known: 90, pending: 10, late: 79 },
    { numerator: null, denominator: 100, known: 90, pending: 10, late: 90 },
  ]) {
    const f = fixture(async () => ({ rows: [row] }));
    await assert.rejects(() => f.call(args), /INVALID_ONTIME_COUNTS/);
    assert.equal(f.listeners.size, 0);
  }
});

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { registerOrderKpiTool } from "../src/host/order-kpi-tool.ts";
import { allowedTools, PROFILES } from "../src/host/prompt-policy.ts";

function fixture(
  execute = async () => {
    const rows = [
      {
        kind: "2",
        region: "全国",
        province: "省区",
        numerator: 10,
        denominator: 100,
        records: 3,
        invalid: 0,
        sample_numerator: 10,
        sample_denominator: 100,
        sample_records: 3,
        unknown_quantity: 0,
      },
    ];
    return { rows, returnedColumns: Object.keys(rows[0]), rejectedColumns: [] };
  },
  directory = resolve("../dsh-agent-workbench/lib/business/inventory-orderworkbench"),
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
        const columns = config.queries["workbench.amendment.details"].resultColumns;
        return { rows: [], returnedColumns: columns, rejectedColumns: [] };
      }
      return execute(request, signal);
    },
    moduleMcp: () => {
      throw Error("Cube fallback forbidden");
    },
  };
  registerOrderKpiTool(ctx, business, [
    {
      directory,
      manifest: {
        id: "inventory-orderworkbench",
        sqlConfig: "sql.config.json",
        gea: { consumerCode: "order" },
      },
    },
  ]);
  return {
    tool,
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

const period = { start: "2026-10-19", endExclusive: "2026-10-26" };
test("generic tool exposes grouped metrics independently of raw detail publication", async () => {
  const f = fixture();
  assert.ok(f.tool.parameters.properties.view.enum.includes("groups"));
  assert.ok(f.tool.parameters.properties.dimensions.items.enum.includes("director"));
  assert.ok(f.tool.parameters.properties.dimensions.items.enum.includes("customer"));
  for (const metric of ["作废率", "改单率", "订单满足率", "准交率", "货龄占比", "可发货天数"]) {
    const value = JSON.parse(await f.call({ ...period, metric, base: "郑州", view: "contract" }));
    assert.equal(value.contract.grouping.view, "groups");
    assert.equal(value.contract.grouping.available, true);
  }
  const fulfillment = JSON.parse(await f.call({ ...period, metric: "满足率", view: "contract" }));
  assert.equal(fulfillment.contract.detailsQueryId, null);
  assert.equal(fulfillment.contract.grouping.available, true);
  assert.equal(f.calls.length, 0);
});
test("unsupported stock customer grain is reported without Cube fallback or SQL", async () => {
  const f = fixture();
  const value = JSON.parse(
    await f.call({ ...period, metric: "货龄占比", view: "groups", dimensions: ["customer"] }),
  );
  assert.equal(value.groups.availability, "unsupported-dimension");
  assert.equal(value.current, null);
  assert.equal(value.groups.unsupported[0].dimension, "customer");
  assert.equal(f.calls.length, 0);
});
test("page-independent generic tool resolves exactly six current contracts without running SQL", async () => {
  const f = fixture();
  for (const metric of ["作废率", "改单率", "订单满足率", "准交率", "货龄占比", "可发货天数"]) {
    const v = JSON.parse(await f.call({ ...period, metric, view: "contract" }));
    assert.equal(v.version, config.metricRuntime.version);
    assert.equal(v.revision, config.metricRuntime.revision);
    assert.ok(v.contract.formula);
    assert.equal(v.contract.version, v.version);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(
    () => f.call({ ...period, metric: "当前客户库存", view: "contract" }),
    /UNKNOWN_ORDER_METRIC/,
  );
  await assert.rejects(
    () =>
      f.call({ ...period, metric: "改单率", expectedVersion: config.metricRuntime.version - 1 }),
    /VERSION_STALE/,
  );
  assert.equal(f.calls.length, 0);
});
test("generic independent query returns exact shared components and no implicit page requirement", async () => {
  const f = fixture();
  const v = JSON.parse(await f.call({ ...period, metric: "改单率" }));
  assert.equal(v.current.numerator, 10);
  assert.equal(v.current.denominator, 100);
  assert.equal(v.current.value, 10);
  assert.equal(v.contract.lockPeriod, false);
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((c) => c.configured && c.request.consumerCode === "order"));
});
test("generic KPI route preserves Cube and knowledge tools for other questions", () => {
  const names = allowedTools(PROFILES["gea-html-inventory-orderworkbench"]);
  for (const name of [
    "gea_order_kpi",
    "mcp__gea-gateway__query_business_data",
    "mcp__gea-gateway__weknora_ask",
    "mcp__gea-gateway__inspect_cube_model",
  ])
    assert.ok(names.has(name), name);
  assert.equal(
    allowedTools(PROFILES["gea-html-inventory-orderfulfillment"]).has("gea_order_kpi"),
    false,
  );
});

test("mismatched runtime artifact is rejected before query execution", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "order-kpi-integrity-"));
  try {
    await writeFile(resolve(dir, "sql.config.json"), JSON.stringify(config));
    await writeFile(
      resolve(dir, "metric-runtime.mjs"),
      'throw Error("must not import changed bytes")',
    );
    const f = fixture(undefined, dir);
    await assert.rejects(() => f.call({ ...period, metric: "改单率" }), /RUNTIME_CHANGED/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.listeners.size, 0);
  } finally {
    assert.ok(dir.startsWith(resolve(tmpdir(), "order-kpi-integrity-")));
    await rm(dir, { recursive: true, force: true });
  }
});

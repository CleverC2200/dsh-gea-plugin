import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  registerCurrentShortageTool,
  currentShortageResult,
} from "../src/host/current-shortage-tool.ts";
import { allowedTools, PROFILES } from "../src/host/prompt-policy.ts";
const definitions = [
  ["aqkc", "base-safety-stock"],
  ["fc", "branch-inventory"],
  ["qll", "full-chain-inventory"],
  ["apsplan", "aps"],
];
const columns = [
  "snapshot_date",
  "location_type",
  "demand",
  "allocated",
  "remaining",
  "available",
  "shortage",
  "invalid",
];
const row = {
  snapshot_date: "2026-10-22",
  location_type: "基地",
  demand: "10",
  allocated: "2",
  remaining: "8",
  available: "3",
  shortage: "5",
  invalid: 0,
};
function fixture(
  agent = "aqkc",
  execute = async () => ({ rows: [row], returnedColumns: columns, rejectedColumns: [] }),
) {
  let tool,
    preset = "gea-html-inventory-" + agent,
    enabled = true;
  const calls = [],
    identity = new AbortController(),
    coreAgent = { id: "current-session" };
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      register: (value) => {
        tool = value;
        return () => {};
      },
    },
    agents: { get: () => coreAgent },
    sessionProjections: { stateOf: () => preset },
    agentResources: {
      list: async () => [{ id: preset, kind: "prompt", installed: true, enabled }],
    },
  };
  const business = {
    config: { requestTimeoutMs: 1000, analysisAgentCode: "sales_forecast" },
    identitySignal: () => identity.signal,
    pluginSql: async (request, signal, configured) => {
      calls.push({ request, signal, configured });
      return execute(request, signal);
    },
    moduleMcp: async () => {
      throw Error("Cube must not be used");
    },
  };
  const packages = definitions.map(([id, consumer]) => ({
    directory: resolve("../dsh-agent-workbench/business/inventory-" + id),
    manifest: {
      id: "inventory-" + id,
      sqlConfig: "sql.config.json",
      gea: { consumerCode: consumer },
    },
  }));
  registerCurrentShortageTool(ctx, business, packages);
  return {
    call: (args) => tool.execute(args, { agent: coreAgent, signal: new AbortController().signal }),
    calls,
    identity,
    disable: () => (enabled = false),
    switchTo: (value) => (preset = value),
  };
}
test("four Session profiles reuse their installed page SQL without a page or Cube", async () => {
  for (const [agent, consumer] of definitions) {
    const f = fixture(agent),
      result = JSON.parse(await f.call({ base: "郑州" }));
    assert.equal(result.rows[0].shortage, "5");
    assert.equal(result.unit, "箱");
    assert.equal(result.coverage, "complete-scope-summary");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].request.consumerCode, consumer);
    assert.equal(f.calls[0].request.parameters.gea_p1, "郑州");
    assert.equal(f.calls[0].configured, true);
    const config = JSON.parse(
      await readFile(
        "../dsh-agent-workbench/business/inventory-" + agent + "/sql.config.json",
        "utf8",
      ),
    );
    assert.equal(f.calls[0].request.sql, config.queries["current-shortage.summary"].request.sql);
    assert.ok(allowedTools(PROFILES["gea-html-inventory-" + agent]).has("gea_current_shortage"));
  }
  assert.equal(allowedTools(PROFILES["gea-readonly"]).has("gea_current_shortage"), false);
});
test("a GEA authorization failure is preserved once with no fallback or zero", async () => {
  const f = fixture("aqkc", async () => {
    const { GeaSqlError } = await import("../src/html-sql.ts");
    throw Object.assign(new GeaSqlError("ROW_SCOPE_DENIED", "denied"), {
      failure: { reasonCode: "ROW_SCOPE_DENIED", stage: "AUTHORIZE" },
    });
  });
  const result = JSON.parse(await f.call({ base: "郑州" }));
  assert.equal(result.success, false);
  assert.equal(result.failure.reasonCode, "ROW_SCOPE_DENIED");
  assert.equal(result.rows, undefined);
  assert.equal(f.calls.length, 1);
});
test("disabled, changed and unrelated identities cannot execute or receive data", async () => {
  const disabled = fixture();
  disabled.disable();
  await assert.rejects(disabled.call({}), /GEA_AGENT_RESOURCE_DISABLED/);
  assert.equal(disabled.calls.length, 0);
  const unrelated = fixture();
  unrelated.switchTo("gea-readonly");
  await assert.rejects(unrelated.call({}), /GEA_CURRENT_SHORTAGE_NOT_AVAILABLE/);
  assert.equal(unrelated.calls.length, 0);
  let f;
  f = fixture("aqkc", async () => {
    f.switchTo("gea-html-inventory-fc");
    return { rows: [row], returnedColumns: columns };
  });
  await assert.rejects(f.call({}), /GEA_BUSINESS_IDENTITY_CHANGED/);
  let aborted;
  aborted = fixture("aqkc", async () => {
    aborted.identity.abort();
    return { rows: [row], returnedColumns: columns };
  });
  await assert.rejects(aborted.call({}), { name: "AbortError" });
});
test("missing fields, invalid rows and partial pages cannot become zero shortage", () => {
  for (const r of [
    { ...row, invalid: 1 },
    { ...row, shortage: null },
    { ...row, invalid: null },
  ])
    assert.throws(
      () => currentShortageResult({ rows: [r], returnedColumns: columns }, false, 1),
      /CURRENT_SHORTAGE_INCOMPLETE/,
    );
  assert.throws(
    () => currentShortageResult({ rows: [row], returnedColumns: columns.slice(1) }, false, 1),
    /CURRENT_SHORTAGE_INCOMPLETE/,
  );
  const detailColumns = [
    ...columns,
    "location_code",
    "location_name",
    "sku",
    "page_scope_total",
    "page_row_present",
  ];
  const detail = {
    ...row,
    location_code: "郑州",
    location_name: "郑州",
    sku: "S1",
    page_scope_total: 11,
    page_row_present: 1,
  };
  assert.throws(
    () => currentShortageResult({ rows: [detail], returnedColumns: detailColumns }, true, 1),
    /CURRENT_SHORTAGE_PAGE_INCOMPLETE/,
  );
  assert.equal(
    currentShortageResult({ rows: [detail], returnedColumns: detailColumns }, true, 2).hasMorePages,
    false,
  );
  assert.equal(
    currentShortageResult({ rows: [{ ...row, shortage: 0 }], returnedColumns: columns }, false, 1)
      .rows[0].shortage,
    0,
  );
});

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
  execute = async () => ({
    rows: [row],
    returnedColumns: columns,
    rejectedColumns: [],
  }),
) {
  let tool,
    preset = "gea-html-inventory-" + agent,
    enabled = true;
  const calls = [],
    listeners = new Set(),
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
      watch: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
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
    call: (args) =>
      tool.execute(args, {
        agent: coreAgent,
        signal: new AbortController().signal,
      }),
    calls,
    identity,
    setEnabled: (value) => {
      enabled = value;
      for (const listener of listeners) listener();
    },
    disable: () => {
      enabled = false;
      for (const listener of listeners) listener();
    },
    replace: () => {
      for (const listener of listeners) listener();
    },
    listeners,
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
test("branch ranking and a follow-up SKU page reuse one Session with explicit warehouse codes", async () => {
  const config = JSON.parse(
    await readFile("../dsh-agent-workbench/business/inventory-fc/sql.config.json", "utf8"),
  );
  const locations = [
    {
      ...row,
      location_type: "分仓",
      location_code: "W2",
      location_name: "乙分仓",
      base: "郑州",
      warehouse_code: "W2",
      shortage: 3,
    },
    {
      ...row,
      location_type: "分仓",
      location_code: "W1",
      location_name: "甲分仓",
      base: "郑州",
      warehouse_code: "W1",
      shortage: 8,
    },
  ];
  const locationColumns = config.queries["current-shortage.locations"].resultColumns;
  const detailColumns = config.queries["current-shortage.detail"].resultColumns;
  const f = fixture("fc", async (request) =>
    request.sql === config.queries["current-shortage.locations"].request.sql
      ? {
          rows: locations,
          returnedColumns: locationColumns,
          rejectedColumns: [],
          hasMorePages: false,
          totalRowCount: 2,
        }
      : {
          rows: [
            {
              ...locations[1],
              sku: "S1",
              page_scope_total: 1,
              page_row_present: 1,
            },
          ],
          returnedColumns: detailColumns,
          rejectedColumns: [],
        },
  );
  const ranking = JSON.parse(await f.call({ view: "locations" }));
  assert.equal(f.calls[0].request.sql, config.queries["current-shortage.locations"].request.sql);
  assert.equal(ranking.coverage, "complete-location-ranking");
  assert.deepEqual(
    ranking.rows.map((r) => r.location_code),
    ["W1", "W2"],
  );
  const detail = JSON.parse(
    await f.call({
      view: "detail",
      warehouseCode: ranking.rows[0].location_code,
    }),
  );
  assert.equal(detail.rows[0].sku, "S1");
  assert.equal(f.calls[1].request.parameters.gea_p2, "W1");
  assert.ok(f.calls.every((c) => c.request.consumerCode === "branch-inventory"));
});
test("a truncated location collection cannot claim a complete ranking", () => {
  assert.throws(
    () =>
      currentShortageResult(
        { rows: [row], returnedColumns: columns, hasMorePages: true },
        "locations",
        1,
      ),
    /CURRENT_SHORTAGE_INCOMPLETE/,
  );
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
for (const change of ["disable and re-enable", "replace with the same ID"]) {
  test(`a pending query cannot survive resource ${change}`, async () => {
    const started = Promise.withResolvers();
    const held = Promise.withResolvers();
    let signal;
    let first = true;
    const f = fixture("aqkc", async (_request, activeSignal) => {
      signal = activeSignal;
      if (first) {
        first = false;
        started.resolve();
        await held.promise;
      }
      return { rows: [row], returnedColumns: columns };
    });
    const pending = assert.rejects(f.call({}), { name: "AbortError" });
    await started.promise;
    if (change === "disable and re-enable") {
      f.setEnabled(false);
      f.setEnabled(true);
    } else {
      f.replace();
    }
    assert.equal(signal.aborted, true);
    held.resolve();
    await pending;
    assert.equal(f.listeners.size, 0);
    assert.equal(JSON.parse(await f.call({})).rows[0].shortage, "5");
    assert.equal(f.listeners.size, 0);
  });
}

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

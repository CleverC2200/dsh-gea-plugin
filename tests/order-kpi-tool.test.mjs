import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
const config = JSON.parse(
  readFileSync(
    "../dsh-agent-workbench/lib/business/inventory-orderworkbench/sql.config.json",
    "utf8",
  ),
);
import { pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { registerOrderKpiTool } from "../src/host/order-kpi-tool.ts";
import { allowedTools, PROFILES } from "../src/host/prompt-policy.ts";

const sourceDirectory = resolve("../dsh-agent-workbench/lib/business/inventory-orderworkbench");
const cubeDirectory = await mkdtemp(resolve(tmpdir(), "order-kpi-cube-route-"));
const cubeStub = `export function createCubeMetricExecutor(config,input,{call,signal}){return{async execute(request,options){return JSON.parse(await call('query_business_data',{request,queryId:options.queryId},signal));},close(){}}}`;
config.metricRuntime.cubeRuntime = {
  file: "cube-runtime.mjs",
  sha256: createHash("sha256").update(cubeStub).digest("hex"),
};
await writeFile(resolve(cubeDirectory, "sql.config.json"), JSON.stringify(config));
await writeFile(
  resolve(cubeDirectory, "metric-runtime.mjs"),
  readFileSync(resolve(sourceDirectory, "metric-runtime.mjs")),
);
await writeFile(resolve(cubeDirectory, "cube-runtime.mjs"), cubeStub);
after(async () => {
  assert.ok(cubeDirectory.startsWith(resolve(tmpdir(), "order-kpi-cube-route-")));
  await rm(cubeDirectory, { recursive: true, force: true });
});

function fixture(
  execute = async () => {
    const rows = [
      {
        kind: "2",
        base: "郑州",
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
  directory = cubeDirectory,
) {
  let tool,
    preset = "gea-html-inventory-orderworkbench",
    enabled = true;
  let identity = new AbortController();
  const listeners = new Set(),
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
    pluginSql: async () => {
      throw Error("Agent SQL gateway use forbidden");
    },
    moduleMcp: async (consumerCode) => {
      assert.equal(consumerCode, "order");
      return {
        call: async (name, args, signal) => {
          const names = [
            "metric_code",
            "scope_base",
            "stat_time",
            "metric_result",
            "numerator_final",
            "denominator_final",
            "pending_final",
            "value_final",
            "base_name",
            "item_name",
            "customer_code",
          ];
          if (name === "inspect_cube_model")
            return JSON.stringify({
              semanticModel: [
                {
                  name: "Final",
                  type: "cube",
                  meta: {
                    source_table: "ai_db.order_kpi_result_v1",
                    reconciliation: { version: config.metricRuntime.version },
                  },
                  dimensions: names.map((n) => ({ name: "Final." + n })),
                },
              ],
            });
          assert.equal(name, "query_business_data");
          const q = args.queries[0].query,
            values = Object.fromEntries(
              q.filters.map((f) => [f.member.split(".")[1], f.values[0]]),
            );
          const namesByCode = {
            cancellation: "作废率",
            amendment: "改单率",
            fulfillment: "订单满足率",
            ontime: "准交率",
            stock_age: "货龄（>60天库存占比）",
            stock_turnover: "周转天数",
          };
          const dims = q.dimensions
            .filter((k) =>
              ["Final.base_name", "Final.item_name", "Final.customer_code"].includes(k),
            )
            .map(
              (k) =>
                ({
                  base_name: "base",
                  item_name: "item",
                  customer_code: "customer",
                })[k.split(".")[1]],
            );
          const runtime = await import(
            pathToFileURL(resolve(sourceDirectory, "metric-runtime.mjs")).href
          );
          const input = {
            metric: namesByCode[values.metric_code],
            base: values.scope_base === "全国" ? "" : values.scope_base,
            start: q.timeDimensions[0].dateRange[0],
            endExclusive: new Date(Date.parse(q.timeDimensions[0].dateRange[1]) + 86400000)
              .toISOString()
              .slice(0, 10),
            view: dims.length ? "groups" : "summary",
            ...(dims.length ? { dimensions: dims } : {}),
          };
          calls.push({ request: q, consumerCode, channel: "Cube" });
          const output = await runtime.readOrderMetric(
            config,
            input.metric === "作废率" && !dims.length
              ? { ...input, view: "groups", dimensions: ["base"] }
              : input,
            async (request, options) => {
              const value = await execute(request, signal);
              const required = config.queries[options.queryId]?.resultColumns ?? [];
              return {
                ...value,
                returnedColumns: [...new Set([...value.returnedColumns, ...required])],
                rows: value.rows.map((row) => ({
                  ...Object.fromEntries(required.map((key) => [key, null])),
                  ...row,
                })),
              };
            },
            signal,
          );
          const failure = output.sources?.find((s) => s.code);
          if (failure) throw Object.assign(Error(failure.code), { code: failure.code });
          const snapshots = dims.length
            ? output.groups.rows.map((r) => ({ row: r, current: r.current }))
            : [{ row: {}, current: output.current }];
          const rows = snapshots.map(({ row, current }) => ({
            "Final.metric_result": JSON.stringify({
              ...current,
              metric: output.metric,
              base: output.base || null,
              period: output.period,
              version: config.metricRuntime.version,
              revision: config.metricRuntime.revision,
              dataset_generation: "fixture",
            }),
            "Final.numerator_final": current.numerator,
            "Final.denominator_final": current.denominator,
            "Final.pending_final": current.pending,
            "Final.value_final": current.value,
            ...Object.fromEntries(
              dims.map((k) => [
                "Final." +
                  {
                    base: "base_name",
                    item: "item_name",
                    customer: "customer_code",
                  }[k],
                row[k],
              ]),
            ),
          }));
          return JSON.stringify({
            datasets: [
              {
                dataStatus: "ok",
                rowCount: rows.length,
                totalRowCount: rows.length,
                rows,
              },
            ],
          });
        },
      };
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
      return tool.execute(args, {
        agent,
        signal: new AbortController().signal,
      });
    },
    switchTo: (value) => {
      preset = value;
    },
    disable: () => {
      enabled = false;
      for (const listener of listeners) listener();
    },
    replaceIdentity: () => {
      identity.abort();
      identity = new AbortController();
    },
  };
}

const period = { start: "2026-10-19", endExclusive: "2026-10-26" };
const cancellationGroups = {
  ...period,
  metric: "作废率",
  view: "groups",
  dimensions: ["base"],
};

test("repeated unavailable cancellation groups do not reissue SQL or invent empty groups", async () => {
  const f = fixture(async () => {
    throw Object.assign(Error("offline"), { code: "GEA_SQL_UNAVAILABLE" });
  });
  const first = JSON.parse(await f.call(cancellationGroups));
  assert.equal(f.calls.length, 1);
  assert.equal(first.groups.availability, "unavailable");
  assert.equal(first.retryPolicy.automaticRetry, false);
  for (let index = 0; index < 3; index++) {
    const result = JSON.parse(await f.call(cancellationGroups));
    assert.equal(result.retryPolicy.suppressed, true);
    assert.equal(result.sources[0].code, "GEA_SQL_UNAVAILABLE");
    assert.equal(result.groups.availability, "unavailable");
    assert.equal(result.current.value, null);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.listeners.size, 0);
  await f.call({ ...cancellationGroups, base: "郑州" });
  assert.equal(f.calls.length, 2);
  f.replaceIdentity();
  await f.call(cancellationGroups);
  assert.equal(f.calls.length, 3);
  f.disable();
  await assert.rejects(() => f.call(cancellationGroups), /UNAVAILABLE|DISABLED|MISSING/);
  assert.equal(f.calls.length, 3);
});

test("cancellation query suppression expires and successful fresh results remain queryable", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  let available = false;
  const f = fixture(async () => {
    if (!available) throw Object.assign(Error("offline"), { code: "GEA_SQL_QUERY_TIMEOUT" });
    const rows = [
      {
        base: "郑州",
        kind: "1",
        region: null,
        province: null,
        numerator: 10,
        denominator: 100,
        sample_numerator: 10,
        sample_denominator: 100,
        sample_records: 1,
        records: 1,
        invalid: 0,
        unknown_quantity: 0,
      },
    ];
    return { rows, returnedColumns: Object.keys(rows[0]), rejectedColumns: [] };
  });
  await f.call(cancellationGroups);
  available = true;
  assert.equal(JSON.parse(await f.call(cancellationGroups)).retryPolicy.suppressed, true);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(60001);
  const result = JSON.parse(await f.call(cancellationGroups));
  assert.equal(result.groups.availability, "available");
  assert.equal(result.current.numerator, 10);
  assert.equal(result.retryPolicy.suppressed, false);
  assert.equal(f.calls.length, 3);
  await f.call(cancellationGroups);
  assert.equal(f.calls.length, 5);
});
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
    await f.call({
      ...period,
      metric: "货龄占比",
      view: "groups",
      dimensions: ["customer"],
    }),
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
      f.call({
        ...period,
        metric: "改单率",
        expectedVersion: config.metricRuntime.version - 1,
      }),
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
  assert.ok(f.calls.every((c) => c.channel === "Cube" && c.consumerCode === "order"));
});

test("KPI queries stop at the shared call deadline without an external timeout wrapper", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let stopped = false;
  const f = fixture(async (_request, signal) => {
    entered();
    try {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    } finally {
      stopped = true;
    }
  });
  const pending = f.call({ ...period, metric: "改单率" });
  const rejected = assert.rejects(pending, /GEA_ORDER_KPI_TIMEOUT/);
  await Promise.race([started, pending]);
  t.mock.timers.tick(180000);
  await rejected;
  assert.equal(stopped, true);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.tool.timeoutMs, 180000);
});

for (const reason of ["caller", "identity", "resource"]) {
  test(`pending KPI queries stop when ${reason} cancels the execution`, async () => {
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let stopped = false;
    const f = fixture(async (_request, signal) => {
      entered();
      try {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      } finally {
        stopped = true;
      }
    });
    const caller = new AbortController();
    const pending = f.tool.execute(
      { ...period, metric: "作废率" },
      { agent: { id: "test-order" }, signal: caller.signal },
    );
    const rejected = assert.rejects(pending);
    await Promise.race([started, pending]);
    if (reason === "caller") caller.abort();
    else if (reason === "identity") f.identity.abort();
    else f.disable();
    await rejected;
    assert.equal(stopped, true);
    assert.equal(f.listeners.size, 0);
  });
}
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

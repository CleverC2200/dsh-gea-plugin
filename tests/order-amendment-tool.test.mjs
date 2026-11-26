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
import { registerOrderAmendmentTool } from "../src/host/order-amendment-tool.ts";
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
  registerOrderAmendmentTool(ctx, business, [
    {
      directory: cubeDirectory,
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

const args = { start: "2026-10-01", endExclusive: "2026-11-01", base: "郑州" };
test("amendment alias reads Cube final quantities with bound base and month", async () => {
  const f = fixture(),
    value = JSON.parse(await f.call(args));
  assert.equal(value.contract.queryId, "workbench.amendments");
  assert.equal(value.contract.lockPeriod, false);
  assert.equal(value.contract.dateField, "order_close_time");
  assert.equal(value.contract.dateSource, "agents_scm_execute_detail_d");
  assert.match(value.contract.countFields.invalid, /不是被剔除/);
  assert.equal(value.current.numerator, 10);
  assert.equal(f.calls[0].channel, "Cube");
  assert.equal(f.calls[0].consumerCode, "order");
  assert.deepEqual(f.calls[0].request.timeDimensions[0].dateRange, ["2026-10-01", "2026-10-31"]);
  assert.ok(
    f.calls[0].request.filters.some(
      (f) => f.member === "Final.scope_base" && f.values[0] === "郑州",
    ),
  );
  assert.ok(
    f.calls[0].request.filters.some(
      (f) => f.member === "Final.metric_code" && f.values[0] === "amendment",
    ),
  );
  assert.equal(f.listeners.size, 0);
});
test("unpublished Cube details do not fall back to SQL or fabricate rows", async () => {
  const f = fixture();
  const value = JSON.parse(await f.call({ ...args, view: "details", page: 2 }));
  assert.equal(value.details.availability, "not-published");
  assert.equal(f.calls.length, 0);
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
test("fixed amendment read is visible only to the order profile", () => {
  assert.ok(allowedTools(PROFILES["gea-html-inventory-orderworkbench"]).has("gea_order_amendment"));
  assert.equal(
    allowedTools(PROFILES["gea-html-inventory-orderfulfillment"]).has("gea_order_amendment"),
    false,
  );
});

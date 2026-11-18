import test from "node:test";
import assert from "node:assert/strict";
import { readCubeFinalMetric } from "../src/host/order-kpi-final.mjs";
const config = { metricRuntime: { version: 7, revision: "r7" } };
const input = {
  metric: "作废率",
  start: "2026-11-01",
  endExclusive: "2026-11-18",
  base: "",
  view: "summary",
};
const snapshot = {
  metric: input.metric,
  version: 7,
  revision: "r7",
  base: null,
  period: { start: input.start, endExclusive: input.endExclusive },
  dataset_generation: "batch",
  numerator: 0,
  denominator: 100,
  pending: null,
  value: 0,
  formula: "formula",
  periodBasis: "basis",
};
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
];
const model = {
  semanticModel: [
    {
      name: "K",
      type: "cube",
      meta: {
        source_table: "ai_db.order_kpi_result_v1",
        reconciliation: { version: 7 },
      },
      dimensions: names.map((n) => ({ name: "K." + n })),
    },
  ],
};
const envelope = {
  contract: {
    version: 7,
    revision: "r7",
    formula: "formula",
    periodBasis: "basis",
    grouping: { dimensions: ["base", "item"], unsupported: [] },
  },
};
const setup = (value = snapshot) => {
  const calls = [];
  const call = async (name, args) => {
    calls.push({ name, args });
    return JSON.stringify(
      name === "inspect_cube_model"
        ? model
        : {
            datasets: [
              {
                dataStatus: "partial",
                totalRowCount: 1,
                rowCount: 1,
                rows: [
                  {
                    "K.metric_result": JSON.stringify(value),
                    "K.numerator_final": value.numerator,
                    "K.denominator_final": value.denominator,
                    "K.pending_final": value.pending,
                    "K.value_final": value.value,
                  },
                ],
              },
            ],
          },
    );
  };
  return { calls, call };
};
test("published members, inclusive Cube dates, exact zero and null", async () => {
  const { call, calls } = setup();
  const result = await readCubeFinalMetric(
    config,
    input,
    call,
    new AbortController().signal,
    envelope,
  );
  assert.deepEqual(
    calls.map((x) => x.name),
    ["inspect_cube_model", "query_business_data"],
  );
  assert.deepEqual(calls[1].args.queries[0].query.timeDimensions[0].dateRange, [
    "2026-11-01",
    "2026-11-17",
  ]);
  assert.equal(result.current.numerator, 0);
  assert.equal(result.current.pending, null);
});
test("wrong semantics, base, period and missing generation rejected", async () => {
  for (const value of [
    { ...snapshot, formula: "different formula" },
    { ...snapshot, periodBasis: "different period basis" },
    { ...snapshot, base: "郑州" },
    { ...snapshot, period: { start: input.start, endExclusive: "2026-11-17" } },
    { ...snapshot, dataset_generation: null },
  ]) {
    const { call } = setup(value);
    await assert.rejects(
      readCubeFinalMetric(config, input, call, new AbortController().signal, envelope),
    );
  }
});

test("different build versions are diagnostic when actual semantics match", async () => {
  const { call } = setup({ ...snapshot, version: 6, revision: "other-build" });
  const result = await readCubeFinalMetric(
    config,
    input,
    call,
    new AbortController().signal,
    envelope,
  );
  assert.equal(result.current.version, 6);
  assert.equal(result.semanticVerification.status, "matched");
  assert.equal(result.semanticVerification.buildVersions.local.version, 7);
  assert.equal(result.semanticVerification.buildVersions.cube.version, 6);
});

test("group results from a different data batch remain rejected", async () => {
  const { call } = setup();
  let reads = 0;
  const changed = async (name, args, signal) => {
    const response = JSON.parse(await call(name, args, signal));
    if (name === "query_business_data" && ++reads === 2) {
      const row = response.datasets[0].rows[0],
        value = JSON.parse(row["K.metric_result"]);
      value.dataset_generation = "another-batch";
      row["K.metric_result"] = JSON.stringify(value);
    }
    return JSON.stringify(response);
  };
  await assert.rejects(
    readCubeFinalMetric(
      config,
      { ...input, view: "groups", dimensions: ["base"] },
      changed,
      new AbortController().signal,
      envelope,
    ),
    /SNAPSHOT_CHANGED/,
  );
});

test("missing group formula uses independently verified Cube scope and batch", async () => {
  let mismatch = false,
    reads = 0;
  const call = async (name, args) => {
    if (name === "inspect_cube_model") return JSON.stringify(model);
    reads++;
    const query = args.queries[0].query,
      base = query.filters[1].values[0],
      grouped = query.dimensions.includes("K.base_name");
    const value = {
      ...snapshot,
      metric: "周转天数",
      base: base === "全国" ? null : base,
      formula: grouped ? undefined : base === "全国" ? "national" : "base",
      dataset_generation: mismatch && base !== "全国" ? "changed" : "batch",
    };
    return JSON.stringify({
      datasets: [
        {
          dataStatus: "ok",
          rowCount: 1,
          totalRowCount: 1,
          rows: [
            {
              "K.metric_result": JSON.stringify(value),
              "K.base_name": "华东",
              "K.numerator_final": value.numerator,
              "K.denominator_final": value.denominator,
              "K.pending_final": value.pending,
              "K.value_final": value.value,
            },
          ],
        },
      ],
    });
  };
  const run = () =>
    readCubeFinalMetric(
      config,
      { ...input, metric: "周转天数", view: "groups", dimensions: ["base"] },
      call,
      new AbortController().signal,
      envelope,
      {
        summary: { formula: "national", periodBasis: "basis" },
        groups: { formula: "base", periodBasis: "basis" },
      },
    );
  assert.equal((await run()).groups.rows.length, 1);
  assert.equal(reads, 3);
  mismatch = true;
  await assert.rejects(run(), /SNAPSHOT_CHANGED/);
});
test("unpublished model prevents final query", async () => {
  await assert.rejects(
    readCubeFinalMetric(
      config,
      input,
      async () => JSON.stringify({ semanticModel: [] }),
      new AbortController().signal,
      envelope,
    ),
    /NOT_PUBLISHED/,
  );
});
test("contract keeps the original contract without a data query", async () => {
  const { call, calls } = setup();
  assert.equal(
    await readCubeFinalMetric(
      config,
      { ...input, view: "contract" },
      call,
      new AbortController().signal,
      envelope,
    ),
    envelope,
  );
  assert.equal(calls.length, 1);
});
test("floating transport precision is tolerated, different quantities are rejected", async () => {
  const { call } = setup({
    ...snapshot,
    value: 4.0275928293,
    numerator: 196294,
    denominator: 4873730,
  });
  const transport = async (name, args, signal) => {
    const response = JSON.parse(await call(name, args, signal));
    if (name === "query_business_data") response.datasets[0].rows[0]["K.value_final"] += 1e-13;
    return JSON.stringify(response);
  };
  const result = await readCubeFinalMetric(
    config,
    input,
    transport,
    new AbortController().signal,
    envelope,
  );
  assert.equal(result.current.value, 4.0275928293);
  const corrupt = async (name, args, signal) => {
    const response = JSON.parse(await call(name, args, signal));
    if (name === "query_business_data") response.datasets[0].rows[0]["K.denominator_final"] += 1;
    return JSON.stringify(response);
  };
  await assert.rejects(
    readCubeFinalMetric(config, input, corrupt, new AbortController().signal, envelope),
    /COMPONENT_MISMATCH/,
  );
});
test("national turnover summary is never reused as base-plan group total", async () => {
  const value = {
    ...snapshot,
    metric: "周转天数",
    value: 15.7,
    numerator: 4331272,
    denominator: 274568.43,
  };
  const { call } = setup(value);
  const result = await readCubeFinalMetric(
    config,
    { ...input, metric: "周转天数", view: "groups", dimensions: ["base"] },
    call,
    new AbortController().signal,
    envelope,
  );
  assert.equal(result.current.value, 15.7);
  assert.equal(result.groups.total, null);
  assert.match(result.groups.totalMissingReason, /Cube/);
});

test("turnover daily-plan denominator accepts transport tail only", async () => {
  const value = {
    ...snapshot,
    metric: "周转天数",
    denominator: 23752.266666666666,
  };
  const { call } = setup(value);
  const transport = (denominator) => async (name, args, signal) => {
    const response = JSON.parse(await call(name, args, signal));
    if (name === "query_business_data")
      response.datasets[0].rows[0]["K.denominator_final"] = denominator;
    return JSON.stringify(response);
  };
  const run = (denominator) =>
    readCubeFinalMetric(
      config,
      { ...input, metric: "周转天数" },
      transport(denominator),
      new AbortController().signal,
      envelope,
    );
  assert.equal((await run(23752.266666666663)).current.denominator, value.denominator);
  await assert.rejects(run(value.denominator + 1e-6), /COMPONENT_MISMATCH/);
  await assert.rejects(run(null), /COMPONENT_MISMATCH/);
});

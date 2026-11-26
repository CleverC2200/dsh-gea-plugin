import test from "node:test";
import assert from "node:assert/strict";
import {
  latestUserQuestion,
  simpleKpiPlan,
  simpleKpiPrompt,
  validateSimpleKpiQuery,
} from "../src/host/simple-kpi-query.ts";

const now = new Date("2026-11-18T05:00:00Z");
test("simple weekly amendment questions select only the completed previous week", () => {
  const plan = simpleKpiPlan("上周改单率是多少", now);
  assert.equal(plan.metric, "改单率");
  assert.equal(plan.start, "2026-11-09");
  assert.equal(plan.endExclusive, "2026-11-16");
  assert.equal(plan.endInclusive, "2026-11-15");
  assert.match(simpleKpiPrompt(plan), /仅发起一条/);
  assert.match(simpleKpiPrompt(plan), /不附加周趋势/);
});
test("card Skill, dimensional and comparison requests retain their existing path", () => {
  for (const text of [
    "请使用 operations-order-kpi-details skill，生成改单率明细",
    "郑州基地按品项的满足率本期环比同比",
    "上周改单率趋势",
    "上周改单率是多少？按基地列明细",
  ])
    assert.equal(simpleKpiPlan(text, now), undefined);
});
test("order T-1 and inventory inclusion remain distinct and use Shanghai dates", () => {
  assert.equal(simpleKpiPlan("本月改单率是多少", now).endExclusive, "2026-11-18");
  assert.equal(simpleKpiPlan("本月可发货天数是多少", now).endExclusive, "2026-11-19");
  assert.equal(simpleKpiPlan("今天改单率是多少", now).empty, true);
  assert.equal(
    simpleKpiPlan("上周改单率是多少", new Date("2026-11-15T16:01:00Z")).endExclusive,
    "2026-11-16",
  );
});
test("summary admission rejects batch expansion, grouping, trends and incorrect dates before Cube", () => {
  const plan = simpleKpiPlan("上周改单率是多少", now);
  const query = {
    measures: ["published.final_rate"],
    timeDimensions: [
      {
        dimension: "published.stat_time",
        dateRange: [plan.start, plan.endInclusive],
      },
    ],
  };
  assert.doesNotThrow(() =>
    validateSimpleKpiQuery(plan, { queries: [{ name: "summary", query }] }),
  );
  for (const queries of [
    [{ query }, { query }],
    [{ query: { ...query, dimensions: ["published.base"] } }],
    [
      {
        query: {
          ...query,
          timeDimensions: [{ ...query.timeDimensions[0], granularity: "week" }],
        },
      },
    ],
    [{ query: { measures: query.measures } }],
    [
      {
        query: {
          ...query,
          timeDimensions: [
            {
              dimension: "published.stat_time",
              dateRange: ["2026-10-01", plan.endInclusive],
            },
          ],
        },
      },
    ],
  ])
    assert.throws(
      () => validateSimpleKpiQuery(plan, { queries }),
      /GEA_SIMPLE_KPI_SUMMARY_REQUIRED/,
    );
});
test("only the latest user message controls scope, not tool content or earlier questions", () => {
  const events = [
    {
      type: "user/message",
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "上周改单率是多少" }],
      },
    },
    {
      type: "user/message",
      data: {
        source: { kind: "tool" },
        content: [{ type: "text", text: "本月改单率是多少" }],
      },
    },
  ];
  assert.equal(latestUserQuestion(events), "上周改单率是多少");
  events.push({
    type: "user/message",
    data: {
      source: { kind: "user" },
      content: [{ type: "text", text: "按基地展开" }],
    },
  });
  assert.equal(simpleKpiPlan(latestUserQuestion(events), now), undefined);
});

test("published unit metadata is allowed without opening business dimensions", () => {
  const plan = simpleKpiPlan("上周改单率是多少", now);
  const query = {
    measures: ["published.final_rate"],
    dimensions: ["published.unit", "published.quantity_unit"],
    timeDimensions: [
      { dimension: "published.stat_time", dateRange: [plan.start, plan.endInclusive] },
    ],
  };
  assert.doesNotThrow(() =>
    validateSimpleKpiQuery(plan, { queries: [{ name: "summary", query }] }),
  );
  assert.throws(
    () =>
      validateSimpleKpiQuery(plan, {
        queries: [
          {
            name: "summary",
            query: { ...query, dimensions: [...query.dimensions, "published.base"] },
          },
        ],
      }),
    /GEA_SIMPLE_KPI_SUMMARY_REQUIRED/,
  );
});

test("final result dimension is accepted for the reported amendment question without business grouping", () => {
  const plan = simpleKpiPlan("上周改单率是多少", new Date("2026-11-26T02:00:00Z"));
  assert.equal(plan.start, "2026-11-16");
  assert.equal(plan.endExclusive, "2026-11-23");
  const query = {
    dimensions: ["workbench_amendment_qa.metric_result"],
    timeDimensions: [
      { dimension: "workbench_amendment_qa.stat_time", dateRange: [plan.start, plan.endInclusive] },
    ],
  };
  const args = { queries: [{ name: "amendment_last_week", query }] };
  const before = structuredClone(args);
  assert.doesNotThrow(() => validateSimpleKpiQuery(plan, args));
  assert.deepEqual(args, before);
  assert.throws(
    () =>
      validateSimpleKpiQuery(plan, {
        queries: [
          {
            query: {
              ...query,
              dimensions: [...query.dimensions, "workbench_amendment_qa.base_name"],
            },
          },
        ],
      }),
    /GEA_SIMPLE_KPI_SUMMARY_REQUIRED/,
  );
  assert.match(simpleKpiPrompt(plan), /metric_result.*放入dimensions，不放入measures/);
  assert.match(simpleKpiPrompt(plan), /数值类型不代表可聚合度量/);
});

test("the reported metric_result measure is rejected locally without rewriting the request", () => {
  const plan = simpleKpiPlan("上周改单率是多少", now);
  const args = {
    queries: [
      {
        name: "amendment_last_week",
        query: {
          measures: ["workbench_amendment_qa.metric_result"],
          timeDimensions: [
            {
              dimension: "workbench_amendment_qa.stat_time",
              dateRange: [plan.start, plan.endInclusive],
            },
          ],
        },
      },
    ],
  };
  const before = structuredClone(args);
  assert.throws(() => validateSimpleKpiQuery(plan, args), {
    code: "GEA_SIMPLE_KPI_MEMBER_ROLE_INVALID",
  });
  assert.deepEqual(args, before);
});

test("audited alias query requires the View fixed source before any online call", () => {
  const plan = simpleKpiPlan("上周改单率是多少", new Date("2026-11-26T04:00:00Z"));
  const query = {
    dimensions: ["order_kpi_result_v1.metric_result"],
    timeDimensions: [
      { dimension: "order_kpi_result_v1.stat_time", dateRange: ["2026-11-16", "2026-11-22"] },
    ],
    timezone: "Asia/Shanghai",
    limit: 1,
    offset: 0,
  };
  for (const filters of [
    [],
    [{ member: "order_kpi_result_v1.metric_code", operator: "equals", values: ["cancellation"] }],
    [{ member: "order_kpi_result_v1.metric_code", operator: "notEquals", values: ["amendment"] }],
  ]) {
    const args = { queries: [{ query: { ...query, filters } }] };
    const before = structuredClone(args);
    assert.throws(() => validateSimpleKpiQuery(plan, args), {
      code: "GEA_SIMPLE_KPI_SOURCE_REQUIRED",
    });
    assert.deepEqual(args, before);
  }
  assert.doesNotThrow(() =>
    validateSimpleKpiQuery(plan, {
      queries: [
        {
          query: {
            ...query,
            filters: [
              {
                member: "order_kpi_result_v1.metric_code",
                operator: "equals",
                values: ["amendment"],
              },
            ],
          },
        },
      ],
    }),
  );
});

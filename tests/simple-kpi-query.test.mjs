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

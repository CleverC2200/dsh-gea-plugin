import test from "node:test";
import assert from "node:assert/strict";
import {
  yearMonthHint,
  yearMonthValues,
} from "../src/host/cube-query-guard.ts";

test("filters 里的年月值会被拦下（含 or/and 嵌套）", () => {
  const hits = yearMonthValues([
    {
      name: "snapshot",
      query: {
        dimensions: ["agents_scm_safety_stock.base_name"],
        filters: [
          { member: "agents_scm_safety_stock.target_month", operator: "equals", values: ["2026-10"] },
          {
            or: [
              { member: "agents_scm_safety_stock.target_month", operator: "equals", values: ["2026-11", "2026-11-01"] },
            ],
          },
        ],
      },
    },
  ]);
  assert.deepEqual(
    hits.map((hit) => `${hit.value}@${hit.path}`),
    [
      "2026-10@queries[0].query.filters[0].values[0]",
      "2026-11@queries[0].query.filters[1].or[0].values[0]",
    ],
  );
});

test("完整日期/文本年月/普通字符串都不拦", () => {
  for (const value of ["2026-10-01", "2026-10-01 00:00:00", "202608", "郑州", "2026-13"]) {
    assert.deepEqual(
      yearMonthValues([{ query: { filters: [{ values: [value] }] } }]),
      [],
      `${value} 不该被拦`,
    );
  }
  assert.deepEqual(yearMonthValues(undefined), []);
  assert.deepEqual(yearMonthValues([{ query: {} }]), []);
});

test("提示里给出两种正确写法，并说明本次没有发出", () => {
  const hint = yearMonthHint([
    {
      path: "queries[0].query.filters[0].values[0]",
      value: "2026-10",
      member: "agents_scm_safety_stock.target_month",
    },
  ]);
  assert.match(hint, /2026-10/);
  assert.match(hint, /2026-10-01/);
  assert.match(hint, /不要用 equals 该月第一天/);
  assert.match(hint, /timeDimensions/);
  assert.match(hint, /gte/);
  assert.match(hint, /本次调用没有发出/);
});

// 关键回归（2026-10-19）：agents_sales_plan_detail_mi.plane_date 声明类型是 string、
// 真实值就是 2026-01…2026-08 这种文本年月，拿 2026-10 过滤它完全合法。
// 只有确认是时间成员才拦；类型拿不到时也不拦（误拦会把人推向 0 行的写法）。
test("只有时间成员才拦；文本年月列与未知类型都不拦", () => {
  const queries = [
    {
      query: {
        filters: [
          {
            member: "agents_sales_plan_detail_mi.plane_date",
            operator: "contains",
            values: ["2026-10"],
          },
        ],
      },
    },
  ];
  const isTime = (member) => member === "agents_sales_plan_detail_mi.load_time";
  assert.deepEqual(yearMonthValues(queries, isTime), []);
  assert.equal(yearMonthValues(queries).length, 1);
  assert.equal(
    yearMonthValues(
      [
        {
          query: {
            filters: [
              { member: "agents_sales_plan_detail_mi.load_time", operator: "equals", values: ["2026-10"] },
            ],
          },
        },
      ],
      isTime,
    ).length,
    1,
  );
});

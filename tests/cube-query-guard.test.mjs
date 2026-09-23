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
  const hint = yearMonthHint([{ path: "queries[0].query.filters[0].values[0]", value: "2026-10" }]);
  assert.match(hint, /2026-10/);
  assert.match(hint, /2026-10-01/);
  assert.match(hint, /202608/);
  assert.match(hint, /本次调用没有发出/);
});

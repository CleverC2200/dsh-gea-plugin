// 成员清单索引：发查询前逐字校验成员名（线上把"品类"写成 category_name，整批被下游拒）。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './tests/fixtures/retired-query/member-index.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);

const payload = {
  semanticModel: [
    {
      name: "agents_scm_safety_stock",
      dimensions: [
        { name: "agents_scm_safety_stock.base_name", type: "string" },
        { name: "agents_scm_safety_stock.product_categ_name", type: "string" },
        { name: "agents_scm_safety_stock.current_inventory", type: "number" },
        { name: "target_month", type: "time" }, // 只给短名的产物也要能认
      ],
      measures: [],
      segments: [{ name: "agents_scm_safety_stock.latest", type: "string" }],
    },
    {
      name: "agents_sales_shipment",
      dimensions: [{ name: "agents_sales_shipment.base_name", type: "string" }],
      measures: [{ name: "agents_sales_shipment.shipment_quantity", type: "number" }],
    },
  ],
};

test("清单解析：全名与短名都能认，度量与维度分开", () => {
  const index = m.memberIndexFrom(payload);
  assert.deepEqual([...index.keys()], ["agents_scm_safety_stock", "agents_sales_shipment"]);
  const stock = index.get("agents_scm_safety_stock");
  assert.equal(stock.measures.length, 0);
  assert.ok(stock.dimensions.includes("agents_scm_safety_stock.target_month"));
  assert.ok(stock.dimensions.includes("agents_scm_safety_stock.product_categ_name"));
});

test("查出不存在的成员，并说清最像的真名与该模型的现有成员", () => {
  m.rememberMemberIndex(payload);
  const index = m.memberIndex();
  const queries = [
    {
      name: "cat_sample",
      query: {
        dimensions: ["agents_scm_safety_stock.base_name", "agents_scm_safety_stock.category_name"],
        limit: 20,
      },
    },
  ];
  const unknown = m.unknownMembers(m.queryMembers(queries), index);
  assert.deepEqual(unknown, ["agents_scm_safety_stock.category_name"]);
  const hint = m.memberHint(unknown, index);
  assert.match(hint, /GEA_CUBE_MEMBER_UNKNOWN/);
  assert.match(hint, /category_name/);
  // 最像的必须是真名，且要列出这个模型的现有成员——模型照着抄就能改对。
  assert.match(hint, /category_name → 拼写相近的是 agents_scm_safety_stock\.product_categ_name/);
  assert.match(hint, /现有成员：/);
  assert.match(hint, /base_name/);
});

test("模型不在清单里时不判（那是模型名或权限的问题，不是成员名）", () => {
  const index = m.memberIndexFrom(payload);
  const unknown = m.unknownMembers(
    ["agents_no_such_model.foo", "agents_scm_safety_stock.base_name"],
    index,
  );
  assert.deepEqual(unknown, []);
});

test("把维度写进 measures 要被拦下；无度量模型要说清只能自己汇总", () => {
  const index = m.memberIndexFrom(payload);
  const stockQueries = [
    {
      name: "sum",
      query: { measures: ["agents_scm_safety_stock.current_inventory"] },
    },
  ];
  const misplaced = m.misplacedMeasures(stockQueries, index);
  assert.deepEqual(misplaced, ["agents_scm_safety_stock.current_inventory"]);
  const hint = m.measureHint(misplaced, index, stockQueries);
  assert.match(hint, /GEA_CUBE_MEASURE_MISMATCH/);
  assert.match(hint, /没有定义任何度量/);

  // 有度量的模型：把真度量写进 measures 不能被拦。
  const good = [{ name: "t", query: { measures: ["agents_sales_shipment.shipment_quantity"] } }];
  assert.deepEqual(m.misplacedMeasures(good, index), []);
  // 有度量却把维度塞进 measures：要报出可用的度量清单。
  const mixed = [
    {
      name: "t",
      query: {
        measures: ["agents_sales_shipment.base_name", "agents_sales_shipment.shipment_quantity"],
      },
    },
  ];
  const mixedHint = m.measureHint(m.misplacedMeasures(mixed, index), index, mixed);
  assert.match(mixedHint, /能写进 measures 的成员只有：agents_sales_shipment.shipment_quantity/);
});

test("查询里引用的成员名收全（dimensions/measures/filters/order 都要）", () => {
  const queries = [
    {
      query: {
        dimensions: ["m.a"],
        measures: ["m.b"],
        filters: [{ member: "m.c", operator: "equals", values: ["x"], and: [{ member: "m.d" }] }],
        order: { "m.e": "desc" },
      },
    },
  ];
  assert.deepEqual(m.queryMembers(queries).sort(), ["m.a", "m.b", "m.c", "m.d", "m.e"]);
});

test("清单过期后不再拦（宁可漏拦，也不能拿旧清单拦住对的成员）", () => {
  m.rememberMemberIndex(payload);
  assert.ok(m.memberIndex());
  m.forgetMemberIndex();
  assert.equal(m.memberIndex(), undefined);
});

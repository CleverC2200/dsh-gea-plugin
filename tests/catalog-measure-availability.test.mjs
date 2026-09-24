/**
 * 目录要让模型一眼看出两件事：
 * 1. 这张模型有哪些度量（度量少时直接写名字，并点明"没有 *_sum 类度量"）；
 * 2. 哪些维度实测取不到可用值（全为空串 / 只有一个取值）。
 *
 * 背景（session-bbd8f3be）：索引只写"度量 1"，模型看不见金额度量已经没了，
 * 于是换了 6 个模型、24 步才得出结论；大区列其实是全空串，也没人告诉它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/host/gateway-catalog.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  outdir: "out",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { projectCatalog } = module.exports;

const MODEL = "agents_sales_plan_detail_mi";
const payload = {
  semanticModel: [
    {
      name: MODEL,
      title: "月度销售计划明细",
      description: "客户SKU月度销售计划及调整。",
      dimensions: [
        { name: `${MODEL}.region_name`, type: "string" },
        { name: `${MODEL}.material_group_name`, type: "string" },
      ],
      measures: [{ name: `${MODEL}.row_count`, type: "number" }],
      segments: [],
    },
  ],
};

test("索引：度量少时写出名字，只有 row_count 时明确不能作金额合计", () => {
  const index = projectCatalog(payload);
  assert.match(index, /度量 1 \//);
  assert.match(index, /度量：row_count/);
  assert.match(index, /只有行数度量/);
});

test("索引：有 *_sum 度量时不再写那句", () => {
  const withSum = {
    semanticModel: [
      {
        ...payload.semanticModel[0],
        measures: [
          { name: `${MODEL}.row_count`, type: "number" },
          { name: `${MODEL}.monthamount_sum`, type: "number" },
        ],
      },
    ],
  };
  const index = projectCatalog(withSum);
  assert.match(index, /度量：row_count、monthamount_sum/);
  assert.doesNotMatch(index, /只有行数度量/);
});

test('索引不凭度量命名推断缺少合计（兼容 total_* 和不带后缀的度量）', () => {
  for (const name of ['total_amount','revenue']) {
    const index=projectCatalog({semanticModel:[{...payload.semanticModel[0],measures:[{name:MODEL+'.'+name,type:'number'}]}]});
    assert.doesNotMatch(index,/合计拿不到|只有行数度量|没有 \*_sum/);
  }
});

test("成员明细：标注实测取不到可用值的维度", () => {
  const notes = new Map([
    [
      `${MODEL}.region_name`,
      "本轮实测取值全为空串：该维度当前没有可用取值",
    ],
  ]);
  const detail = projectCatalog(payload, { model: MODEL, memberNotes: notes });
  assert.match(detail, /取值可用性（实测）/);
  assert.match(detail, /region_name — 本轮实测取值全为空串/);
});

test("成员明细：没有实测标注时不出现那一行", () => {
  const detail = projectCatalog(payload, { model: MODEL });
  assert.doesNotMatch(detail, /取值可用性（实测）/);
});

test("索引：把已知缺口写进对应模型那一行（不用逐个模型试）", () => {
  const notes = new Map([
    [
      `${MODEL}.region_name`,
      "本轮实测取值全为空串：该维度当前没有可用取值",
    ],
    ["other_model.some_member", "本轮实测只有一个取值「X」：区分不了对象"],
  ]);
  const index = projectCatalog(payload, { memberNotes: notes });
  assert.match(index, /已知缺口：region_name=取值全为空串/);
  assert.doesNotMatch(index, /some_member/, "别的模型的缺口不能挂到这一行");
});

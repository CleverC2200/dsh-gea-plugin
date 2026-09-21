/**
 * 页面自述必须能被宿主校验通过，否则整份目录判非法、工具注册不上，
 * 这一屏对对话来说就等于"没有能力"。真实数据里踩到过的坑：
 *   - 客户筛选有 28 项，超过选项上限 24；
 *   - 个别 SKU 的确认量是空串，空串不是合法 value；
 *   - 展开行特别多时元素总数会超过 300。
 * 这里用最坏输入验证页面侧已经收口，而不是让宿主放宽规则。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/workbench/workbench-elements.ts'; export * from './src/page-bridge/catalog.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

/** 宿主校验只回一句 INVALID_PAGE_CATALOG；这里包一层，失败信息短且可读。 */
const validate = (elements, label) => {
  try {
    return m.validatePageCatalog({
      surface: "gea-workbench",
      tool: "gea_workbench_apply",
      description: "改这一屏（测试用）",
      elements,
    }).elements;
  } catch {
    throw new Error(`${label} 没通过宿主校验`);
  }
};

const filters = (dealerCount) => [
  {
    field: "dealerCode",
    label: "经销商筛选",
    value: "",
    options: Array.from({ length: dealerCount }, (_, index) => ({
      value: String(10000 + index),
      label: `客户 ${index}`,
    })),
  },
];

const worstCase = (dealerCount, expandedRows) =>
  m.buildWorkbenchElements({
    rows: Array.from({ length: 20 }, (_, index) => ({
      planId: `plan-${index}`,
      label: `组织 ${index}`,
      value: index % 3 === 0 ? "" : "12345.67",
      expanded: index < expandedRows,
    })),
    selectedPlanIds: [],
    stage: "area",
    stageOptions: [
      { value: "all", label: "不限阶段" },
      { value: "area", label: "大区" },
    ],
    filters: filters(dealerCount),
    page: 1,
    pages: 2,
    fields: Array.from({ length: expandedRows * 45 }, (_, index) => ({
      id: `field:plan-${Math.floor(index / 45)}:sku-${index}:qty`,
      label: `物料 ${index} 确认计划量`,
      value: index % 7 === 0 ? "" : "939",
      editable: true,
    })),
    collections: Array.from({ length: expandedRows }, (_, index) => ({
      id: `collection:plan-${index}:qty`,
      label: `组织 ${index} 全部 SKU 的确认计划量`,
      members: Array.from(
        { length: 45 },
        (_, sku) => `field:plan-${index}:sku-${index * 45 + sku}:qty`,
      ),
    })),
    dialog: {
      label: "退回审批对话框（组织 0）",
      actions: ["confirm", "cancel"],
      fields: [
        { id: "dialog:approval:remark", label: "退回理由", value: "", editable: true },
      ],
    },
  });

test("客户筛选超过 24 项时目录仍然合法，并说明只列了前几项", () => {
  const elements = worstCase(28, 1);
  assert.equal(
    validate(elements, "28 项客户筛选").length,
    elements.length,
    "页面自述没通过宿主校验",
  );
  const filter = elements.find((element) => element.id === "filter:dealerCode");
  assert.equal(filter.options.length, m.PAGE_CATALOG_LIMITS.maxEnumValues);
  assert.match(filter.label, /共 28 项，只列出前 24 项/);
});

test("空串不是合法 value：空金额、空确认量、空退回理由一律省略而不是上报", () => {
  const elements = worstCase(6, 1);
  assert.ok(elements.length > 0);
  for (const element of elements)
    assert.notEqual(element.value, "", `${element.id} 上报了空 value`);
  assert.equal(
    elements.find((element) => element.id === "row:plan-0").value,
    undefined,
  );
  assert.equal(
    elements.find((element) => element.id === "dialog:approval:remark").value,
    undefined,
  );
  assert.equal(
    elements.find((element) => element.id === "filter:dealerCode").value,
    undefined,
  );
});

test("展开行很多时先保控件与行，元素总数不超过上限", () => {
  const elements = worstCase(3, 12);
  assert.ok(
    elements.length <= m.PAGE_CATALOG_LIMITS.maxElements,
    `元素数 ${elements.length} 超过上限`,
  );
  assert.equal(validate(elements, "展开 12 行").length, elements.length);
  for (const id of ["stage", "pager", "filters", "dialog:approval", "row:plan-0"])
    assert.ok(
      elements.some((element) => element.id === id),
      `${id} 被裁掉了`,
    );
});

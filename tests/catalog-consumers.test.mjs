// 模型 → consumerCode：目录里看得见的模型，要能对上一条查询通道。
// 线上问题：目录里有 agents_sales_plan_detail_mi，但模型不知道该用哪个 consumerCode，
// 试了被白名单挡的身份和演示模块之后放弃 Cube，拿工作台的 30 条计划单当答案。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export * from './src/host/catalog-consumers.ts';\nexport * from './src/host/gateway-catalog.ts';",
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

const payload = {
  semanticModel: [
    {
      name: "agents_sales_plan_detail_mi",
      title: "销售计划明细",
      dimensions: [{ name: "agents_sales_plan_detail_mi.area_name", type: "string" }],
      measures: [{ name: "agents_sales_plan_detail_mi.plannum_sum", type: "number" }],
    },
    {
      name: "agents_scm_safety_stock",
      dimensions: [{ name: "agents_scm_safety_stock.current_inventory", type: "number" }],
      measures: [],
    },
  ],
};

test("记住模型属于哪条通道；换通道后以最新的为准", () => {
  m.forgetModelConsumers();
  m.rememberModelConsumers("sales_forecast", payload);
  assert.equal(m.consumerForModel("agents_sales_plan_detail_mi"), "sales_forecast");
  assert.equal(m.consumerForModel("agents_scm_safety_stock"), "sales_forecast");
  assert.equal(m.consumerForModel("agents_scm_inventory_age"), undefined);
  m.rememberModelConsumers("branch-inventory", { semanticModel: [payload.semanticModel[1]] });
  assert.equal(m.consumerForModel("agents_scm_safety_stock"), "branch-inventory");
  // 没被新通道覆盖的模型保留原记录
  assert.equal(m.consumerForModel("agents_sales_plan_detail_mi"), "sales_forecast");
  m.forgetModelConsumers();
  assert.equal(m.consumerForModel("agents_sales_plan_detail_mi"), undefined);
  assert.equal(m.modelConsumers().size, 0);
});

test("目录明细把 consumerCode 标给模型（含「可见≠已授权」的边界说明）", () => {
  m.forgetModelConsumers();
  m.rememberModelConsumers("sales_forecast", payload);
  const detail = m.projectCatalog(payload, {
    model: "agents_sales_plan_detail_mi",
    consumers: m.modelConsumers(),
  });
  assert.match(detail, /查询通道：consumerCode=sales_forecast/);
  assert.match(detail, /不代表每行数据都已授权/);
});

test("目录索引在有关联关系时提示下一步会给出 channel", () => {
  m.forgetModelConsumers();
  m.rememberModelConsumers("sales_forecast", payload);
  const index = m.projectCatalog(payload, { consumers: m.modelConsumers() });
  // 不带 model 时给的是索引：不能把明细塞进去，只提示"明细里有 consumerCode"
  assert.match(index, /GEA 网关语义模型索引/);
  assert.match(index, /明细里会给出该模型的 consumerCode/);
  // 没有对应关系时不出现这句（避免空话）
  m.forgetModelConsumers();
  const plain = m.projectCatalog(payload, { consumers: m.modelConsumers() });
  assert.equal(plain.includes("明细里会给出该模型的 consumerCode"), false);
});

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
const {
  contentText,
  extractArtifactUri,
  formatSampleValues,
  parseFirstJsonObject,
  projectCatalog,
  resultText,
  rowsFromPayload,
  rowsFromText,
  spillPathFrom,
} = module.exports;

const sample = {
  semanticModel: [
    {
      name: "agent_branch_cycle_config",
      title: "agent_branch_cycle_config",
      description: "分仓补货周期配置。",
      dimensions: [
        { name: "agent_branch_cycle_config.warehouse_id", type: "string" },
        { name: "agent_branch_cycle_config.rules", type: "string" },
        { name: "agent_branch_cycle_config.updated_time", type: "time" },
      ],
      measures: [],
      segments: [],
    },
    {
      name: "agents_scm_wl_cust_stock_age_governed",
      title: "客户库存货龄",
      description: "经销商库存货龄。",
      dimensions: [{ name: "agents_scm_wl_cust_stock_age_governed.cust_code" }],
      measures: [{ name: "agents_scm_wl_cust_stock_age_governed.qty", type: "number" }],
      segments: [],
    },
  ],
};

test("工具结果文本与资源地址解析", () => {
  const message = {
    content: [
      { type: "text", text: "Resource link: query_business_data-result (data-artifact://gateway/abc-123)" },
    ],
  };
  assert.match(contentText(message), /data-artifact/);
  assert.equal(extractArtifactUri(contentText(message)), "data-artifact://gateway/abc-123");
  assert.equal(extractArtifactUri("没有资源"), undefined);
});

test("resources/read 形式的返回也能取到正文", () => {
  const message = {
    contents: [{ uri: "data-artifact://gateway/x", mimeType: "application/json", text: '{"semanticModel":[]}' }],
  };
  assert.equal(resultText(message), '{"semanticModel":[]}');
  assert.equal(extractArtifactUri(resultText({ contents: [{ text: "data-artifact://gateway/y" }] })), "data-artifact://gateway/y");
});

test("被宿主截断时会认出本机 spill 文件路径", () => {
  const text = "结果前 30KB\n\n(Omitted 320268 bytes. Full formatted result stored at: /var/folders/x/dsh-spill/session/file.txt. Use ...)";
  assert.equal(spillPathFrom(text), "/var/folders/x/dsh-spill/session/file.txt");
  assert.equal(spillPathFrom("没有被截断"), undefined);
});

test("解析第一段完整 JSON，忽略尾部提示", () => {
  const payload = JSON.stringify(sample);
  const parsed = parseFirstJsonObject(payload + "\n\n(Omitted 1 bytes. Full ...)");
  assert.equal(parsed.semanticModel.length, 2);
  assert.throws(() => parseFirstJsonObject('{"a": '), /GEA_CATALOG_TRUNCATED/);
});

test("不带 model 只回模型索引：名字完整、不带成员名", () => {
  const all = projectCatalog(sample);
  assert.match(all, /agent_branch_cycle_config/);
  assert.match(all, /agents_scm_wl_cust_stock_age_governed/);
  // 索引里不该出现成员名（那是二级返回的事），也不该说"目录已截断"吓模型去猜。
  assert.doesNotMatch(all, /agent_branch_cycle_config\.warehouse_id/);
  assert.doesNotMatch(all, /目录已截断/);
  assert.match(all, /带 model=模型名 再调一次/);
  assert.ok(all.length < 2000, String(all.length));
  // 一个 measure 都没定义的 cube：索引里必须直接说清"只能放 dimensions"，
  // 否则模型会把数值字段写进 measures，被上游拒掉整批查询计划（线上实测）。
  assert.match(all, /无度量：所有成员都是维度，只放 dimensions/);
  // 索引里也要提一句"这个模型有时间成员"，模型挑模型时就知道要注意格式。
  assert.match(
    all.split("\n").find((line) => line.includes("agent_branch_cycle_config")),
    /含 1 个时间成员/,
  );
  assert.match(all, /只有列在“度量”里的成员才写进 measures/);
  const withMeasures = all
    .split("\n")
    .find((line) => line.includes("agents_scm_wl_cust_stock_age_governed"));
  assert.doesNotMatch(withMeasures, /无度量/);
});

test("带 model 才回成员名；名字对不上时不报错、按内容给最像的", () => {
  const one = projectCatalog(sample, { model: "stock_age" });
  assert.match(one, /agents_scm_wl_cust_stock_age_governed\.qty/);
  assert.doesNotMatch(one, /agent_branch_cycle_config/);

  const noMeasures = projectCatalog(sample, { model: "branch_cycle" });
  assert.match(noMeasures, /度量：无/);
  assert.match(noMeasures, /所有成员一律放 dimensions/);

  // 成员类型要带出来：模型以前看不到类型，才会把 2026-10 当日期、把 number 维度塞进 measures。
  assert.match(noMeasures, /agent_branch_cycle_config\.updated_time\[time\]/);
  assert.doesNotMatch(noMeasures, /agent_branch_cycle_config\.warehouse_id\[/);
  assert.match(noMeasures, /\[time\] 是时间成员：取值要写完整日期/);
  const withNumber = projectCatalog(sample, { model: "stock_age" });
  assert.match(withNumber, /agents_scm_wl_cust_stock_age_governed\.qty\[number\]/);

  // 业务词当模型名：不抛错，也不只回一句"没有这个模型"——给出可用的下一步与全量名字。
  const missed = projectCatalog(sample, { model: "完全不相关的词" });
  assert.match(missed, /没有叫「完全不相关的词」的模型/);
  assert.match(missed, /agent_branch_cycle_config/);
  assert.match(missed, /agents_scm_wl_cust_stock_age_governed/);
  assert.doesNotMatch(missed, /GEA_CATALOG_MODEL_NOT_FOUND/);
});

test("预算不够时先保名字完整，再退成只有名字；成员只在二级返回里截断", () => {
  const big = {
    semanticModel: Array.from({ length: 40 }, (_, index) => ({
      name: "model_" + index,
      description: "说明".repeat(40),
      dimensions: [{ name: `model_${index}.field` }],
      measures: [],
      segments: [],
    })),
  };
  // 索引预算很小时：40 个名字一个都不能少，也不出现"目录已截断"。
  const index = projectCatalog(big, { maxChars: 500 });
  for (let i = 0; i < 40; i += 1) assert.match(index, new RegExp("model_" + i + "\\b"));
  assert.doesNotMatch(index, /目录已截断/);

  // 二级返回里成员超上限：只说成员被截断，不说目录被截断。
  const details = projectCatalog(big, { model: "model_1", maxMembersPerModel: 0 });
  assert.match(details, /model_1/);
  assert.match(details, /成员名超过单次上限/);
  assert.doesNotMatch(details, /目录已截断/);
});

test("样例值：从 rows 里取一行真实值，给出格式要求", () => {
  assert.deepEqual(rowsFromPayload({ rows: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(rowsFromPayload({ result: { rows: [{ a: 2 }] } }), [{ a: 2 }]);
  assert.equal(rowsFromPayload({ rows: "nope" }), null);
  assert.deepEqual(rowsFromText('{"result":{"rows":[{"x":1}]}}'), [{ x: 1 }]);

  const text = formatSampleValues(
    [{ "agents_scm_safety_stock.target_month": "2026-10-01", "agents_scm_safety_stock.inventory_version": "滚动" }],
    ["agents_scm_safety_stock.target_month", "agents_scm_safety_stock.inventory_version"],
  );
  assert.match(text, /成员样例值（取 1 行，共 2 个成员）/);
  assert.match(text, /agents_scm_safety_stock\.target_month = "2026-10-01"/);
  assert.match(text, /inventory_version = "滚动"/);
  assert.match(text, /时间是完整日期（如 2026-10-01）/);

  assert.match(formatSampleValues([], ["a.b"]), /没有取到样例值/);
});

// 线上实测：模型拿业务词当模型名，而目录里的模型名/说明用了别的字（库龄 vs 货龄）。
// 这里要的是"任何业务词都能落到一个模型上"，不是给某个词写一条映射。
test("业务词对不上模型名时：字面出现就算命中，只像的给最像的，完全不像才回完整索引", () => {
  const payload = {
    semanticModel: [
      {
        name: "agents_scm_inventory_age",
        title: "库存货龄日快照",
        description: "仓库 SKU 批次货龄日快照，按快照日与仓库区分。",
        dimensions: [{ name: "agents_scm_inventory_age.material_code", type: "string" }],
        measures: [],
        segments: [],
      },
      {
        name: "agents_sales_target",
        title: "客户月度目标",
        description: "客户月度经营目标。",
        dimensions: [{ name: "agents_sales_target.dealer_code", type: "string" }],
        measures: [],
        segments: [],
      },
    ],
  };
  // 字面出现在标题里 → 当命中，但要标明这是"按内容命中"，模型才知道这不是完整名单。
  const literal = projectCatalog(payload, { model: "货龄" });
  assert.match(literal, /按内容命中/);
  assert.match(literal, /agents_scm_inventory_age/);
  assert.match(literal, /agents_scm_inventory_age\.material_code/);
  assert.doesNotMatch(literal, /agents_sales_target/);

  // 模型名命中时不打"按内容命中"的标记（那是名字本身对上了）。
  const byName = projectCatalog(payload, { model: "sales_target" });
  assert.match(byName, /agents_sales_target/);
  assert.doesNotMatch(byName, /按内容命中/);

  // 字面不一致（库龄 vs 货龄）：仍要一步给出对的模型与它的成员，而不是空手回去猜名字。
  const fuzzy = projectCatalog(payload, { model: "库龄" });
  assert.match(fuzzy, /「库龄」不是任何一个模型名/);
  assert.match(fuzzy, /- agents_scm_inventory_age：标题命中「库存货龄日快照」/);
  assert.match(fuzzy, /agents_scm_inventory_age\.material_code/);
  assert.match(fuzzy, /其它候选：/);
  assert.equal(fuzzy.includes("GEA_CATALOG_MODEL_NOT_FOUND"), false);
  assert.equal(fuzzy.includes("GEA_CATALOG_MCP_FAILED"), false);

  // 真的一条都不像：回带说明的完整索引，一步挑对（不抛错——错误正文会被截断到 200 字）。
  const nothing = projectCatalog(payload, { model: "毫不相干的词" });
  assert.match(nothing, /没有叫「毫不相干的词」的模型/);
  assert.match(nothing, /GEA 网关语义模型索引/);
  assert.match(nothing, /agents_sales_target/);
});

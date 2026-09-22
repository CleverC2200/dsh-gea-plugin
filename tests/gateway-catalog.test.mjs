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
  parseFirstJsonObject,
  projectCatalog,
  resultText,
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
      ],
      measures: [],
      segments: [],
    },
    {
      name: "agents_scm_wl_cust_stock_age_governed",
      title: "客户库存货龄",
      description: "经销商库存货龄。",
      dimensions: [{ name: "agents_scm_wl_cust_stock_age_governed.cust_code" }],
      measures: [{ name: "agents_scm_wl_cust_stock_age_governed.qty" }],
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
});

test("带 model 才回成员名；猜错时列出可用模型", () => {
  const one = projectCatalog(sample, { model: "stock_age" });
  assert.match(one, /agents_scm_wl_cust_stock_age_governed\.qty/);
  assert.doesNotMatch(one, /agent_branch_cycle_config/);

  assert.throws(
    () => projectCatalog(sample, { model: "不存在的模型" }),
    (error) =>
      /GEA_CATALOG_MODEL_NOT_FOUND/.test(error.message) &&
      /可用模型：/.test(error.message) &&
      /agent_branch_cycle_config/.test(error.message),
    "报错必须带可用模型名，否则模型只会继续猜",
  );
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

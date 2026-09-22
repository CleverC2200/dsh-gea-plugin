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

test("紧凑目录给出模型与成员名，并支持按模型过滤", () => {
  const all = projectCatalog(sample);
  assert.match(all, /agent_branch_cycle_config/);
  assert.match(all, /agent_branch_cycle_config\.warehouse_id/);
  assert.match(all, /agents_scm_wl_cust_stock_age_governed\.qty/);
  // 只给模型名时，不该把 33 万字符的正文带出来。
  assert.ok(all.length < 4000, String(all.length));

  const one = projectCatalog(sample, { model: "stock_age" });
  assert.match(one, /agents_scm_wl_cust_stock_age_governed/);
  assert.doesNotMatch(one, /agent_branch_cycle_config/);

  assert.throws(() => projectCatalog(sample, { model: "不存在的模型" }), /GEA_CATALOG_MODEL_NOT_FOUND/);
});

test("目录超出预算时明确标注截断", () => {
  const big = {
    semanticModel: Array.from({ length: 40 }, (_, index) => ({
      name: "model_" + index,
      description: "说明".repeat(40),
      dimensions: [{ name: `model_${index}.field` }],
      measures: [],
      segments: [],
    })),
  };
  const text = projectCatalog(big, { maxChars: 1200 });
  assert.match(text, /目录已截断/);
});

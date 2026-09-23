/**
 * 通用"业务词 → 标识"排序：不针对任何具体词，换成任何业务词都要成立。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/shared/name-lookup.ts"],
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
const { didYouMean, normalizeTerm, rankByName, textSimilarity } = module.exports;

const candidates = [
  {
    id: "agents_scm_inventory_age",
    fields: [
      { text: "agents_scm_inventory_age", label: "模型名", identity: true },
      { text: "经销商库存货龄日快照", label: "说明" },
      { text: "agents_scm_inventory_age.inventory_days", label: "成员名" },
    ],
  },
  {
    id: "agents_sales_target",
    fields: [
      { text: "agents_sales_target", label: "模型名", identity: true },
      { text: "客户月度经营目标", label: "说明" },
    ],
  },
];

test("归一化抹平大小写、下划线与标点", () => {
  assert.equal(normalizeTerm("Agents_Scm-Cust.Stock"), "agentsscmcuststock");
  assert.equal(normalizeTerm("库存/货龄（日）"), "库存货龄日");
});

test("字面命中优先：相等 > 前缀 > 子串 > 只像", () => {
  assert.equal(textSimilarity("inventoryage", "inventoryage"), 1);
  assert.ok(textSimilarity("inventory", "inventoryage") > textSimilarity("age", "inventoryage"));
  assert.equal(textSimilarity("库存", "经销商库存货龄日快照"), 0.8);
  assert.ok(textSimilarity("库存", "经销商库存货龄日快照") > textSimilarity("库龄", "经销商库存货龄日快照"));
});

test("标识本身命中排在「只在说明里像」的前面", () => {
  const ranked = rankByName("sales_target", candidates);
  assert.equal(ranked[0].id, "agents_sales_target");
  assert.equal(ranked[0].field.identity, true);
});

test("同义不同字也能落到正确的候选（不靠同义词表）", () => {
  // 库龄 / 货龄：一个字一样、bigram 完全不一致，只能靠覆盖率兜。
  const ranked = rankByName("库龄", candidates);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "agents_scm_inventory_age");
  assert.ok(ranked[0].score > 0);
  assert.ok(ranked[0].score < 0.8, "不是字面命中，不该被当成确定命中");
});

test("像都不是的时候回空数组，让调用方自己列清单", () => {
  assert.deepEqual(rankByName("绩效考核结果", candidates), []);
  assert.deepEqual(rankByName("", candidates), []);
  assert.deepEqual(rankByName("月度目标", [{ id: "x", fields: [] }]), []);
});

test("同样相似时，短文本比长文本更像「就是它」", () => {
  const short = { id: "short", fields: [{ text: "库存货龄", label: "说明" }] };
  const long = {
    id: "long",
    fields: [
      {
        text: "库存货龄相关的一堆很长很长的补充说明文字，用来把这段文本拉长到几十个字以上，看看排序会不会被长度带偏。",
        label: "说明",
      },
    ],
  };
  assert.equal(rankByName("库龄", [long, short])[0].id, "short");
});

test("didYouMean：有像的给一句可读的下一步，没有就留空", () => {
  const hit = didYouMean("查库存", candidates, { label: "工具" });
  assert.match(hit, /没有直接叫「查库存」的工具/);
  assert.match(hit, /最像的是/);
  assert.equal(didYouMean("绩效考核结果", candidates, { label: "工具" }), "");
});

test("一次调用最多回 limit 个候选", () => {
  const many = Array.from({ length: 20 }, (_, index) => ({
    id: `model_${index}`,
    fields: [{ text: `model_${index}`, label: "模型名", identity: true }],
  }));
  assert.equal(rankByName("model_", many, { limit: 3 }).length, 3);
});

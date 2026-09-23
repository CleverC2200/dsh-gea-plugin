// 页面意图判定：默认不读页面；只有用户原话里出现页面指代才允许生成快照。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/page-intent.ts';",
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

test("有页面意图：这一屏/这几行/展开/选中/这单/当前页都算", () => {
  for (const question of [
    "帮我看下这一屏有哪些缺货",
    "这几行帮我核一下金额",
    "把明细展开看看",
    "当前选中的那几行是什么",
    "这单能直接同意吗",
    "当前页的汇总对不对",
    "表格里的数量为什么对不上",
  ])
    assert.ok(m.pageIntentOf(question), `应判为有页面意图：${question}`);
});

test("没有页面意图：按月/按范围/要全量的问法不读页面", () => {
  for (const question of [
    "哪些销售大区的销售计划已提报，帮我按品类分析结构占比",
    "2026-08 各大区的计划金额是多少",
    "历史上这类经销商的补货周期是怎么定的",
    "帮我把全国库存按品类汇总一下",
  ])
    assert.equal(m.pageIntentOf(question), undefined, `不该判为页面意图：${question}`);
});

test("没有原话就不猜（空值一律不算页面意图）", () => {
  assert.equal(m.pageIntentOf(undefined), undefined);
  assert.equal(m.pageIntentOf("   "), undefined);
});

test("接线：快照工具在发送前判意图，位置提示不再默认引导读页面", async () => {
  const tools = await readFile("src/host/agent-tools.ts", "utf8");
  assert.match(tools, /const intent = pageIntentOf\(question\);/);
  assert.match(tools, /availability: "no-page-intent"/);
  assert.match(tools, /PAGE_INTENT_MISSING/);
  // 位置提示：业务菜单那一支必须写"默认不要读这一屏"
  const surface = await readFile("src/host/workbench-surface.ts", "utf8");
  assert.match(surface, /默认不要读这一屏/);
  // 通道顺序：页面通道标成默认不用
  const channel = await readFile("src/capability/channel.ts", "utf8");
  assert.match(channel, /默认不要用它/);
  assert.match(channel, /只在用户明确要看这一屏时/);
  // 每轮原话要记进 Business（否则工具拿不到判据）
  const host = await readFile("src/host.ts", "utf8");
  assert.match(host, /business\.rememberTurnQuestion\(scope, question\)/);
});

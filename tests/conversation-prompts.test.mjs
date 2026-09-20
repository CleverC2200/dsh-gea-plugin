import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/client/conversation-prompts.ts"],
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
const { reportingConversation, approvalConversation, inventoryConversation } = module.exports;

// 文案来源：《销售计划 · 右侧 AI 会话区原型说明 V1》，原型见 docs/prototypes/。
test("提报版对话区文案按原型说明 V1 落地", () => {
  assert.equal(reportingConversation.name, "销售计划助手");
  assert.equal(reportingConversation.tagline, "提报辅助");
  assert.match(reportingConversation.intro, /核对本月计划的合理性与风险/);
  assert.equal(reportingConversation.boundary, "最终提交仍然由你自己在确认入口完成。");
  assert.deepEqual(
    reportingConversation.actions.map((action) => action.label),
    ["看本月计划建议", "看需要重点关注的商品", "解释预测依据", "按工作台当前结果提交"],
  );
  assert.deepEqual(
    reportingConversation.actions.map((action) => action.detail),
    [
      "任务头、总量建议、关键变化、风险提示",
      "发货概率偏低、库存或货龄偏高的商品",
      "公式怎么套算、用了哪些数据、哪项没取到",
      "只把你带到确认入口，不代替你提交",
    ],
  );
  assert.deepEqual(reportingConversation.prompts, [
    "这次预测能按现状走吗？",
    "哪些商品需要重点复核？",
    "为什么这个客户上调了？",
    "按建议帮我把数量调下来",
  ]);
});

test("审批版对话区文案按原型说明 V1 落地", () => {
  assert.equal(approvalConversation.name, "销售计划审批助手");
  assert.equal(approvalConversation.tagline, "审批辅助");
  assert.match(approvalConversation.intro, /先给结论，再给依据/);
  assert.equal(approvalConversation.boundary, "我只做分析建议，不改变审批状态。");
  assert.deepEqual(
    approvalConversation.actions.map((action) => action.label),
    ["审这张单", "看异常清理清单", "看双版本差异", "生成审批意见"],
  );
  assert.deepEqual(
    approvalConversation.actions.map((action) => action.detail),
    [
      "结论先行：能不能直接同意，不能同意卡在哪",
      "下市与预下市、非季节品、货龄超期、需复核",
      "最新版与上一版改了哪些客户和商品",
      "采纳记录留痕：谁采纳、改前改后",
    ],
  );
  assert.deepEqual(approvalConversation.prompts, [
    "这张单能直接同意吗？",
    "哪些客户需要退回重提？",
    "汤圆品类为什么比上一版降了？",
    "省区整体达成偏乐观吗？",
  ]);
});

test("两版共用同一套结构，库存助手文案保持不变", () => {
  for (const config of [reportingConversation, approvalConversation, inventoryConversation]) {
    assert.equal(config.actions.length, 4);
    assert.equal(config.prompts.length, 4);
    for (const action of config.actions) {
      assert.ok(action.icon && action.label && action.prompt);
    }
  }
  assert.equal(inventoryConversation.name, "经销商补货助手");
  assert.deepEqual(inventoryConversation.prompts, [
    "哪些客户需要补货？",
    "重点客户的库存情况如何？",
    "生成下周的补货建议",
    "导出客户库存分析报告",
  ]);
});

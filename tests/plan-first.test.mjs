// "先给计划"检查点：一审模型开口前一路调工具（线上 3/6 个会话 0 字符文本）。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/plan-first.ts';",
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

test("没开口：第 1 次放行、第 2 次起催、第 5 次起暂停", () => {
  assert.equal(m.planVerdict(1, false), "ok");
  assert.equal(m.planVerdict(2, false), "nudge");
  assert.equal(m.planVerdict(4, false), "nudge");
  assert.equal(m.planVerdict(5, false), "pause");
  assert.equal(m.planVerdict(9, false), "pause");
});

test("已经开口过：一律放行（不再催、也不再暂停）", () => {
  for (const index of [1, 2, 5, 20])
    assert.equal(m.planVerdict(index, true), "ok", `第 ${index} 次已开口应放行`);
});

test("催促与暂停的文案：说清要什么，并带稳定 code", () => {
  assert.match(m.PLAN_NUDGE_NOTE, /先用一句话讲清计划/);
  assert.match(m.PLAN_NUDGE_NOTE, /不用逐步播报工具调用/);
  const pause = JSON.parse(m.planPausePayload(5));
  assert.equal(pause.code, "PLAN_REQUIRED");
  assert.equal(pause.availability, "plan-required");
  assert.match(pause.note, /已经调了 5 次取数工具/);
  assert.match(pause.note, /先给计划/);
});

test("接线：三个取数工具都过检查点；每步回报是否开口（提示词那条已由检查点替代）", async () => {
  const tools = await readFile("src/host/agent-tools.ts", "utf8");
  assert.match(tools, /const plan = planCheck\(scope\);/, "plan read / module mcp 都要过检查点");
  assert.match(tools, /const catalogPlan = planCheck\(catalogScope\);/);
  assert.match(tools, /withPlanNudge/);
  const anchor = await readFile("src/host/turn-anchor.ts", "utf8");
  assert.match(anchor, /hooks\.onStep\?\.\(\{ scope: scopeId, spoke \}\)/);
  const host = await readFile("src/host.ts", "utf8");
  assert.match(host, /business\.rememberTurnSpoke\(scope, spoke\)/);
  // "先给一句计划"不再占提示词：第 2 次调用催、第 5 次暂停由 plan-first 确定性执行
  // （提示词里那条已删，见 docs/reports 的收口记录）。
  assert.match(host, /business\.resetTurnPlan\(scope\)/);
  const planFirst = await readFile("src/host/plan-first.ts", "utf8");
  assert.match(planFirst, /PLAN_NUDGE_AFTER = 2/);
  assert.match(planFirst, /PLAN_PAUSE_AFTER = 5/);
});

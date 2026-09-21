/**
 * 防回归：业务预设不能把“当前页上下文”当成拒答前提。
 *
 * 线上问题：预设里原来的硬边界规则写死了“页面不可用 + 用户没给经销商编码时，
 * 只能说明当前页不可用、不得做泛化查询”，导致“查一下 9 月份需求预测的数据”
 * 这类按月问题也被拒答。这里把两边（预设正文 + 工具描述/返回值）都钉住。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("业务预设不再把当前页上下文当成拒答前提", async () => {
  const preset = await read("../presets/gea-readonly/agent.cordis.yml");
  // 旧的硬边界措辞必须消失——它让模型对“按月查数据”直接拒答。
  assert.equal(preset.includes("当前页引用是硬边界"), false);
  assert.equal(preset.includes("不得据此输出审批维度、风险表、建议或泛化查询"), false);
  // 新规则必须存在：按月/按范围的问题，页面上下文不是必要条件。
  assert.ok(preset.includes("页面上下文不是必要条件"));
  assert.ok(preset.includes("不得因为页面不可用而拒答"));
  assert.ok(preset.includes("gea_visible_workbench_context 每轮最多调用一次"));
});

test("页面上下文工具的描述与返回值都要求“按月问题去查数据、一轮一次”", async () => {
  const tools = await readFile(new URL("../src/host/agent-tools.ts", import.meta.url), "utf8");
  assert.ok(tools.includes("for month- or scope-wide questions answer from the read-only data tools"));
  assert.ok(tools.includes("Call this tool at most once per turn."));
  assert.equal(tools.includes("do not read, infer or invent business data"), false);

  const business = await readFile(new URL("../src/host/business.ts", import.meta.url), "utf8");
  assert.ok(business.includes("按月或按范围的数据问题请直接用只读数据工具查询并作答"));
  assert.ok(business.includes("本工具每轮最多调用一次"));
});

test("业务预设要求先加载对应技能，且只允许清单里出现过的技能名", async () => {
  const preset = await read("../presets/gea-readonly/agent.cordis.yml");
  // 实测过两种坏行为：完全不加载技能；猜造 sales-plan-forecast 导致 unknown。
  assert.ok(
    preset.includes("必须是本次系统提示 <available_skills> 里出现过的名字"),
    "缺少“只能用清单里的技能名”约束",
  );
  assert.ok(
    preset.includes("绝不根据业务工具名猜造"),
    "缺少禁止猜造技能名的约束",
  );
  assert.ok(
    preset.includes("查/问需求预测类问题一律先加载它（默认入口）"),
    "没有把 sinian-demand-dialogue 定为默认入口",
  );
  assert.ok(
    preset.includes("清单里没有这些技能时按普通会话作答"),
    "缺少未安装套件时的降级说明",
  );
});

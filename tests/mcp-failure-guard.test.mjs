/**
 * 模块 MCP 通道的失败熔断：连续失败到上限就停手，成功清零，窗口过了放行。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/host/mcp-failure-guard.ts"],
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
  createMcpFailureGuard,
  createMcpWasteGuard,
  MCP_FAILURE_LIMIT,
  MCP_FAILURE_WINDOW_MS,
  MCP_WASTE_LIMIT,
} = module.exports;

test("默认上限是 2 次、窗口 10 分钟", () => {
  assert.equal(MCP_FAILURE_LIMIT, 2);
  assert.equal(MCP_FAILURE_WINDOW_MS, 10 * 60 * 1000);
});

test("连续失败到上限后停手，并且说清缺什么而不是让它继续试", () => {
  const guard = createMcpFailureGuard();
  guard.check("branch-inventory");
  guard.note("branch-inventory", false);
  guard.check("branch-inventory"); // 第 1 次失败还没到上限
  guard.note("branch-inventory", false);
  assert.throws(
    () => guard.check("branch-inventory"),
    (error) => {
      assert.match(error.message, /^GEA_MCP_RETRY_STOPPED: branch-inventory/);
      assert.match(error.message, /不要再换模型、换成员或换写法重试/);
      return true;
    },
  );
  // 别的模块不受影响：一个模块被拒不该牵连其它模块。
  guard.check("base-safety-stock");
});

test("成功一次就清零：偶尔失败不会把模块判死", () => {
  const guard = createMcpFailureGuard();
  guard.note("branch-inventory", false);
  guard.note("branch-inventory", true);
  guard.note("branch-inventory", false);
  guard.check("branch-inventory");
  guard.note("branch-inventory", false);
  assert.throws(() => guard.check("branch-inventory"), /GEA_MCP_RETRY_STOPPED/);
});

test("窗口过了自动放行，不用重启会话", () => {
  let now = 1_000_000;
  const guard = createMcpFailureGuard({ windowMs: 1000, now: () => now });
  guard.note("branch-inventory", false);
  guard.note("branch-inventory", false);
  assert.throws(() => guard.check("branch-inventory"), /GEA_MCP_RETRY_STOPPED/);
  now += 1001;
  guard.check("branch-inventory");
  guard.note("branch-inventory", false);
  guard.check("branch-inventory");
});

test("计数按模块分开，且只在窗口内累加", () => {
  let now = 0;
  const guard = createMcpFailureGuard({ limit: 3, windowMs: 5000, now: () => now });
  guard.note("a", false);
  guard.note("b", false);
  guard.note("b", false);
  guard.check("a");
  guard.check("b");
  guard.note("b", false);
  assert.throws(() => guard.check("b"), /GEA_MCP_RETRY_STOPPED/);
  guard.check("a");
});

test("本轮整体熔断：跨模块白跑到上限就停手（换模块也拦）", () => {
  const waste = createMcpWasteGuard();
  assert.equal(MCP_WASTE_LIMIT, 6);
  for (let i = 0; i < 5; i += 1) waste.waste("session-1");
  waste.check("session-1"); // 还没到上限
  waste.waste("session-1");
  assert.throws(
    () => waste.check("session-1"),
    (error) => {
      assert.match(error.message, /^GEA_TURN_RETRY_STOPPED: /);
      assert.match(error.message, /不要再换模块、换模型、换成员或换写法试/);
      return true;
    },
  );
  // 别的会话不受影响；同一个会话拿到真数据后清零。
  waste.check("session-2");
  waste.progress("session-1");
  waste.check("session-1");
});

test("白跑计数窗口过了自动放行；clear 清空全部", () => {
  let now = 0;
  const waste = createMcpWasteGuard({ limit: 2, windowMs: 1000, now: () => now });
  waste.waste("s");
  waste.waste("s");
  assert.throws(() => waste.check("s"), /GEA_TURN_RETRY_STOPPED/);
  now += 1001;
  waste.check("s");
  waste.waste("s");
  waste.clear();
  waste.check("s");
});

test('failure budgets are scoped to the conversation; resetting one preserves the other and keeps the actual cause', () => {
  const guard=createMcpFailureGuard();
  for (const scope of ['one','two']) for(let n=0;n<2;n++)guard.note('sales_forecast',false,scope,'GEA_MCP_RESOURCE_MAPPING_FAILED');
  guard.clear('one');guard.check('sales_forecast','one');
  assert.throws(()=>guard.check('sales_forecast','two'),/GEA_MCP_RESOURCE_MAPPING_FAILED/);
  guard.clear();guard.check('sales_forecast','two');
});

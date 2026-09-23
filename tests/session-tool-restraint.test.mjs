// 业务会话里把浏览器/终端类全局工具从模型的工具清单里摘掉。
// 实测：25 个 mcp__browser__* 工具 = 18,498 字符，占工具块 66.7%（12.2k → 27.7k）。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/session-tool-restraint.ts';",
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

const KNOWN = [
  "mcp__browser__browser_click",
  "mcp__browser__browser_snapshot",
  "terminal_create",
  "terminal_send",
  "sidebar_open",
  "gea_module_mcp",
  "skill",
];

test("deny 目标：浏览器全禁；终端/侧栏在业务预设里也禁，编码预设里保留", () => {
  assert.deepEqual(m.denyTargetsFor(KNOWN, "gea-readonly").sort(), [
    "mcp__browser__browser_click",
    "mcp__browser__browser_snapshot",
    "sidebar_open",
    "terminal_create",
    "terminal_send",
  ]);
  // 标准编码预设：只禁浏览器，保留终端（别误伤同一个运行时里的编码会话）
  assert.deepEqual(m.denyTargetsFor(KNOWN, "auto-negotiation").sort(), [
    "mcp__browser__browser_click",
    "mcp__browser__browser_snapshot",
  ]);
  // 没有这些工具时什么都不禁（绝不凭空 deny 未知名字——restrict 会整体抛错）
  assert.deepEqual(m.denyTargetsFor(["gea_module_mcp", "skill"], undefined), []);
});

test("presetOf：顶层与 meta 两种位置都能取到", () => {
  assert.equal(m.presetOf({ session: { header: { agentPreset: "gea-readonly" } } }), "gea-readonly");
  assert.equal(m.presetOf({ session: { header: { meta: { agentPreset: "inventory-aqkc" } } } }), "inventory-aqkc");
  assert.equal(m.presetOf({}), undefined);
});

test("restrictToolsForAgent：先探已知清单再 deny；探不到就安静放弃", () => {
  const calls = [];
  const agent = {
    session: { header: { agentPreset: "gea-readonly" } },
    ctx: {
      tools: {
        restrict(filter) {
          calls.push(filter);
          if (filter.deny.includes("__session_restraint_probe__"))
            throw new Error(
              'tools.restrict() names unknown global tools "__session_restraint_probe__"; known global tools: mcp__browser__browser_click, terminal_create, sidebar_open, gea_module_mcp',
            );
          return () => {};
        },
      },
    },
  };
  assert.equal(typeof m.restrictToolsForAgent(agent), "function");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].deny.sort(), [
    "mcp__browser__browser_click",
    "sidebar_open",
    "terminal_create",
  ]);

  // 探测失败（拿不到已知清单）：只探一次，然后放弃，不抛错
  let probes = 0;
  const blind = {
    session: { header: {} },
    ctx: { tools: { restrict() { probes += 1; throw new Error("没有这句 known global tools"); } } },
  };
  assert.equal(m.restrictToolsForAgent(blind), undefined);
  assert.equal(probes, 1);
});

test("接线：宿主在 agent/pre-step 上装一次，且部署补丁默认不挂浏览器 MCP", async () => {
  const { readFile } = await import("node:fs/promises");
  const host = await readFile("src/host.ts", "utf8");
  assert.match(host, /mountSessionToolRestraint\(ctx/);
  const deployment = await readFile("scripts/deployment.mjs", "utf8");
  assert.match(deployment, /process\.env\.GEA_BROWSER_MCP === "1"/);
  assert.match(deployment, /浏览器 MCP（Playwright）\*\*默认不挂\*\*/);
});

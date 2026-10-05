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

test("deny 目标：浏览器全禁；终端在业务预设里禁；侧栏工具的注册归原BSP用户开关", () => {
  assert.deepEqual(m.denyTargetsFor(KNOWN, "gea-readonly").sort(), [
    "mcp__browser__browser_click",
    "mcp__browser__browser_snapshot",
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

test("the public restraint uses official projected presets and registry schemas without probing unknown tools", async()=>{
 const handlers=new Map();const restrictions=[];let known=[...KNOWN];let preset='gea-readonly';
 const agent={session:{header:{agentPreset:'standard'}},ctx:{tools:{restrict:filter=>{restrictions.push(filter);return ()=>{};}}}};
 const ctx={tools:{schemas:()=>known.map(name=>({name}))},agents:{list:()=>[agent]},sessionProjections:{stateOf:()=>preset},on:(name,handler)=>{handlers.set(name,handler);return ()=>handlers.delete(name);}};
 const dispose=m.mountSessionToolRestraint(ctx);
 await handlers.get('agent/pre-step')({agent},async()=>({kind:'enter'}));
 assert.equal(restrictions.length,1);
 assert.deepEqual(restrictions[0].deny.sort(),m.denyTargetsFor(KNOWN,'gea-readonly').sort());
 known.push('mcp__browser__new_tool');handlers.get('tools/change')();
 assert.ok(restrictions.at(-1).deny.includes('mcp__browser__new_tool'));
 preset='standard';handlers.get('agent-preset/selected')();
 assert.equal(restrictions.at(-1).deny.includes('terminal_create'),false);
 assert.ok(restrictions.every(filter=>!filter.deny.some(name=>name.includes('probe')||name==='run_code')));
 dispose();assert.equal(handlers.size,0);
});

test("接线：宿主在 agent/pre-step 上装一次，且部署补丁默认不挂浏览器 MCP", async () => {
  const { readFile } = await import("node:fs/promises");
  const host = await readFile("src/host.ts", "utf8");
  assert.match(host, /mountSessionToolRestraint\(ctx/);
  const deployment = await readFile("scripts/deployment.mjs", "utf8");
  assert.match(deployment, /process\.env\.GEA_BROWSER_MCP === "1"/);
  assert.match(deployment, /浏览器 MCP（Playwright）\*\*默认不挂\*\*/);
});

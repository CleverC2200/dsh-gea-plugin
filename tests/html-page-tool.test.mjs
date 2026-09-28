import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverPresets } from "@deepseek-ai/dsh-agent-presets";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { BUSINESS_MENU_PRESET } from "../src/business-navigation.ts";
import { prepareNativePreset } from "../scripts/deployment.mjs";
import { parse as parseYaml } from "yaml";

const session = "session-11111111-1111-1111-1111-111111111111";
const require = createRequire(import.meta.url);
const standardPreset = resolve(
  dirname(require.resolve("@deepseek-ai/dsh-agent-presets/package.json")),
  "presets/standard",
);

/** 建一个最小可用的 HTML 业务插件，只用来验证页面工具对模型的行为。 */
async function probePlugin(options = {}) {
  const id = options.id ?? "inventory-probe";
  const name = options.name ?? "探针页面";
  const skillName = options.skillName ?? "inventory-probe";
  // 探针默认是演示（mock）模块：它和真实模块共用同一套页面工具，但没有数据通道。
  const mode = options.mock === false ? undefined : "mock";
  const root = await mkdtemp(join(tmpdir(), "gea-html-probe-"));
  await mkdir(join(root, "skills", "probe"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><html><body>probe</body></html>\n");
  await writeFile(
    join(root, "skills", "probe", "SKILL.md"),
    "---\nname: " + skillName + "\ndescription: 探针业务规则。\n---\n\n# 探针页面\n\nPROBE-RULE-42：建议量 = ceil(max(0, 缺货量 − 调拨中量))。\n",
  );
  await writeFile(join(root, "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    name,
    version: "0.0.0",
    html: "index.html",
    skills: ["skills/probe/SKILL.md"],
    mcp: "mcp.json",
    mode,
    gea: { consumerCode: id + "-consumer", readonly: true, contract: "gea-html-v1" },
  }));
  await writeFile(join(root, "mcp.json"), JSON.stringify({
    provider: "gea",
    transport: "host-provided",
    contract: "gea-html-v1",
    consumer: { consumerType: "AGENT", consumerCode: id + "-consumer" },
    capabilities: ["governed-sql-read"],
  }));
  return root;
}

async function registeredPlugins(options = {}) {
  const roots = options.roots ?? [await probePlugin(options)];
  const runtimeDir = options.runtimeDir ?? (await mkdtemp(join(tmpdir(), "gea-html-runtime-")));
  const tools = [];
  const routes = [];
  const identities = new Map();
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (tool) => tools.push(tool) },
    connection: { fetch: { register: (route) => routes.push(route) } },
  };
  const business = {
    config: { runtimeDir },
    status: () => ({ authenticated: true, user: { id: "u-1" } }),
    watchIdentity: () => () => {},
    // 宿主侧"当前页身份"：页面打开/轮询时刷新（见 host/page-identity.ts）。
    touchPageIdentity: (sessionId, identity) =>
      identities.set(sessionId, { ...identity, at: Date.now() }),
    currentPageIdentity: (sessionId) => identities.get(sessionId),
    clearPageIdentity: (sessionId, pluginId) => {
      const current = identities.get(sessionId);
      if (!current) return;
      if (pluginId && current.pluginId !== pluginId) return;
      identities.delete(sessionId);
    },
  };
  await registerHtmlPlugins(ctx, business, roots);
  return { tool: tools.find((tool) => tool.name === "gea_page"), routes, runtimeDir };
}

test("a page tool reports not-in-workbench instead of failing the conversation", async () => {
  const { tool } = await registeredPlugins();
  assert.ok(tool, "页面工具已注册");
  for (const name of ["context", "refresh", "filter", "draft"]) {
    const result = JSON.parse(
      await tool.execute({ action: name, parameters: "{}" }, { agent: { id: session }, signal: new AbortController().signal }),
    );
    assert.equal(result.availability, "not-in-workbench", name);
    assert.equal(result.code, "PAGE_NOT_IN_WORKBENCH", name);
    assert.equal(result.action, name);
    // 没有打开任何页面时不说具体模块，只给"改用模块 MCP"的下一步。
    assert.equal(result.page, undefined);
    assert.match(result.reason, /gea_module_mcp/);
  }
});

test("a page that was used and then closed is a plain conversation again", async () => {
  const { tool, routes } = await registeredPlugins();
  const open = routes.find((route) => route.path === "/api/gea-html/inventory-probe/open");
  const call = routes.find((route) => route.path === "/api/gea-html/inventory-probe/call");
  const { lease } = await (
    await open.fetch(
      new Request("http://local/api/gea-html/inventory-probe/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session }),
      }),
    )
  ).json();
  await call.fetch(
    new Request("http://local/api/gea-html/inventory-probe/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease, method: "context", parameters: { rows: [{ name: "中心仓" }] } }),
    }),
  );
  // 页面开着：读得到页面证据
  const live = JSON.parse(
    await tool.execute({ action: "context", parameters: "{}" }, { agent: { id: session }, signal: new AbortController().signal }),
  );
  assert.equal(live.source, "page-observation");
  assert.deepEqual(live.context, { rows: [{ name: "中心仓" }] });
  // 页面关闭：这个对话回到普通状态，不再关联业务数据
  await call.fetch(
    new Request("http://local/api/gea-html/inventory-probe/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lease, method: "close" }),
    }),
  );
  const closed = JSON.parse(
    await tool.execute({ action: "context", parameters: "{}" }, { agent: { id: session }, signal: new AbortController().signal }),
  );
  assert.equal(closed.availability, "not-in-workbench");
  assert.equal(closed.context, undefined, "关闭后不再泄露页面数据");
  assert.equal(closed.renderedAt, undefined);
});

test("同一屏第二次读取只回 unchanged：不把整包重复塞进历史", async () => {
  const { tool, routes } = await registeredPlugins();
  const open = routes.find((route) => route.path === "/api/gea-html/inventory-probe/open");
  const call = routes.find((route) => route.path === "/api/gea-html/inventory-probe/call");
  const { lease } = await (
    await open.fetch(
      new Request("http://local/api/gea-html/inventory-probe/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session }),
      }),
    )
  ).json();
  await call.fetch(
    new Request("http://local/api/gea-html/inventory-probe/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lease,
        method: "context",
        parameters: { rows: [{ name: "中心仓" }, { name: "分仓二" }] },
      }),
    }),
  );
  const exec = { agent: { id: session }, signal: new AbortController().signal };
  const first = JSON.parse(
    await tool.execute({ action: "context", parameters: "{}" }, exec),
  );
  assert.equal(first.source, "page-observation");
  const second = JSON.parse(
    await tool.execute({ action: "context", parameters: "{}" }, exec),
  );
  assert.equal(second.unchanged, true, "同一份内容第二次只回没变");
  assert.equal(second.context, undefined, "不再重复发送整包");
  assert.match(second.note, /未重复发送/);
  // 换个 focus 就是新的一道，正常回内容。
  const focused = JSON.parse(
    await tool.execute({ action: "context", focus: "中心仓", parameters: "{}" }, exec),
  );
  assert.equal(focused.unchanged, undefined);
  assert.ok(JSON.stringify(focused.context).includes("中心仓"));
});

test("each plugin's SKILL.md is published for the main conversation", async () => {
  const previous = process.env.DSH_HOME;
  const home = await mkdtemp(join(tmpdir(), "gea-dsh-home-"));
  process.env.DSH_HOME = home;
  try {
    await registeredPlugins();
    const published = await readFile(join(home, "skills", "inventory-probe", "SKILL.md"), "utf8");
    assert.match(published, /PROBE-RULE-42/);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("preset names follow the repo override table without a duplicate full-chain choice", async () => {
  const { runtimeDir } = await registeredPlugins({
    roots: [
      await probePlugin({ mock: false }),
      await probePlugin({ id: "inventory-aqkc", name: "安全库存", skillName: "inventory-aqkc", mock: false }),
      await probePlugin({ id: "inventory-qll", name: "全链路库存", skillName: "inventory-qll", mock: false }),
    ],
  });
  const read = async (id) =>
    JSON.parse(
      await readFile(
        join(runtimeDir, "native-presets", "gea-html-" + id, "preset.yml"),
        "utf8",
      ),
    );
  // 没登记的插件保留插件包自己的名字。
  assert.equal((await read("inventory-probe")).name, "探针页面");
  // 登记过的模块用仓库里的业务名，改名不必重发插件包。
  assert.equal((await read("inventory-aqkc")).name, "基地库存Agent");
  assert.equal((await read("inventory-qll")).name, "全链库存管理Agent");
  await assert.rejects(
    readFile(join(runtimeDir, "native-presets", "gea-html-inventory-all", "preset.yml"), "utf8"),
    { code: "ENOENT" },
  );
});

test("new-conversation preset roster follows the left business menu", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-preset-order-"));
  await prepareNativePreset(runtimeDir, standardPreset);
  await registeredPlugins({
    runtimeDir,
    roots: [
      await probePlugin({ id: "inventory-apsplan", name: "产销协同工作台", mock: false }),
      await probePlugin({ id: "inventory-qll", name: "全链库存", mock: false }),
      await probePlugin({ id: "inventory-aqkc", name: "基地库存", mock: false }),
      await probePlugin({ id: "inventory-fc", name: "分仓库存", mock: false }),
      await probePlugin({ id: "inventory-dealer", name: "经销商库存", mock: false }),
      await probePlugin({ id: "inventory-customer", name: "客户库存" }),
      await probePlugin({ id: "inventory-orderworkbench", name: "订单工作台" }),
      await probePlugin({ id: "inventory-orderfulfillment", name: "订单履约" }),
    ],
  });
  const roster = await discoverPresets(
    [
      { path: join(runtimeDir, "native-presets"), trust: "system" },
      { path: resolve("presets"), trust: "system" },
    ],
    import.meta.url,
  );
  // 此单元环境未安装桌面运行图的所有可选包；只核对 DSH 扫描器返回的真实排序。
  assert.deepEqual(roster.map((preset) => preset.id), [
    "auto-negotiation",
    "gea-html-inventory-apsplan",
    "gea-readonly",
    "gea-html-inventory-qll",
    "gea-html-inventory-aqkc",
    "gea-html-inventory-fc",
    "gea-html-inventory-dealer",
  ]);
  assert.equal(roster[0].name, "智能编排");
  const menuIdByPreset = new Map([
    ["gea-html-inventory-apsplan", "inventory-apsplan"],
    ["gea-readonly", "gea-proof"],
    ["gea-html-inventory-qll", "inventory-qll"],
    ["gea-html-inventory-aqkc", "inventory-aqkc"],
    ["gea-html-inventory-fc", "inventory-fc"],
  ]);
  const inPicker = roster.map((preset) => menuIdByPreset.get(preset.id)).filter(Boolean);
  const inSidebar = BUSINESS_MENU_PRESET.flatMap((group) => group.items.map((item) => item.id))
    .filter((id) => inPicker.includes(id));
  assert.deepEqual(inPicker, inSidebar);
});

test("each page agent card describes its own capability", async () => {
  const { runtimeDir } = await registeredPlugins({ roots: [await probePlugin({ mock: false })] });
  // 没登记在 presets/agent-capabilities.json 的插件，回退到它自己 SKILL.md 的 description。
  const probe = parseYaml(
    await readFile(join(runtimeDir, "native-presets", "gea-html-inventory-probe", "preset.yml"), "utf8"),
  );
  assert.equal(probe.description, "探针业务规则。");
  const capabilities = JSON.parse(await readFile(join("presets", "agent-capabilities.json"), "utf8"));
  for (const id of [
    "inventory-apsboard",
    "inventory-apsdemand",
    "inventory-apsdelivery",
    "inventory-personal",
    "inventory-aqkc",
    "inventory-dealer",
    "inventory-fc",
    "inventory-qll",
  ])
    assert.ok(capabilities[id]?.length, `${id} 有独立介绍`);
  assert.notEqual(capabilities["inventory-fc"], capabilities["inventory-aqkc"]);
});

test("开发中演示页仍可登记，但不留下 Agent 预设", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-html-runtime-"));
  const native = join(runtimeDir, "native-presets");
  const residue = async (name) => {
    await mkdir(join(native, name), { recursive: true });
    await writeFile(join(native, name, "preset.yml"), "name: 老版本残留\n");
  };
  // 老版本装过的：全能业务助手、被产销协同 Agent 替代的看板、已经整包卸掉的 ghost 模块。
  for (const name of ["gea-agent-hub", "gea-html-inventory-apsboard", "gea-html-inventory-ghost", "gea-html-inventory-all",
    "gea-html-inventory-customer", "gea-html-inventory-orderworkbench", "gea-html-inventory-orderfulfillment"])
    await residue(name);
  // 不是本仓库生成的预设目录，清理时不能顺手删。
  await residue("auto-negotiation");
  const { routes } = await registeredPlugins({
    runtimeDir,
    roots: [
      // 真实模块照常出现在预设列表里。
      await probePlugin({ mock: false }),
      // 演示（mock）模块与下架名单里的模块都不能被选中。
      await probePlugin({ id: "inventory-customer", name: "客户库存" }),
      await probePlugin({ id: "inventory-orderworkbench", name: "订单工作台" }),
      await probePlugin({ id: "inventory-orderfulfillment", name: "订单履约" }),
      await probePlugin({ id: "inventory-otherdemo", name: "其他演示" }),
      await probePlugin({ id: "inventory-personal", name: "库存管理工作台", mock: false }),
    ],
  });
  assert.deepEqual((await readdir(native)).sort(), ["auto-negotiation", "gea-html-inventory-probe"]);
  const list = routes.find(route => route.path === "/api/gea-html/plugins");
  const plugins = await (await list.fetch(new Request("http://local/api/gea-html/plugins"))).json();
  for (const id of ["inventory-customer", "inventory-orderworkbench", "inventory-orderfulfillment"]) {
    const plugin = plugins.find(item => item.id === id);
    assert.equal(plugin.retired, false, "隐藏 Agent 不下架业务页面");
    assert.equal(plugin.presetHidden, true);
    const open = routes.find(route => route.path === `/api/gea-html/${id}/open`);
    const response = await open.fetch(new Request(`http://local/api/gea-html/${id}/open`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session }),
    }));
    assert.equal(response.status, 200, "演示页面仍可建立页面会话");
    assert.ok((await response.json()).lease);
  }
});

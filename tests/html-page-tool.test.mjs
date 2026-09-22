import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { parse as parseYaml } from "yaml";

const session = "session-11111111-1111-1111-1111-111111111111";

/** 建一个最小可用的 HTML 业务插件，只用来验证页面工具对模型的行为。 */
async function probePlugin(options = {}) {
  const id = options.id ?? "inventory-probe";
  const name = options.name ?? "探针页面";
  const skillName = options.skillName ?? "inventory-probe";
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
    mode: "mock",
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
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-html-runtime-"));
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
    // 没有打开任何页面时不说具体模块，只给"改用直读"的下一步。
    assert.equal(result.page, undefined);
    assert.match(result.reason, /gea_plugin_read/);
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

test("preset names follow the repo override table and hidden modules drop their preset", async () => {
  const { runtimeDir } = await registeredPlugins({
    roots: [
      await probePlugin(),
      await probePlugin({ id: "inventory-aqkc", name: "安全库存", skillName: "inventory-aqkc" }),
      await probePlugin({ id: "inventory-qll", name: "全链路库存", skillName: "inventory-qll" }),
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
  // 下架的模块不再生成预设。
  await assert.rejects(
    readFile(
      join(runtimeDir, "native-presets", "gea-html-inventory-qll", "preset.yml"),
      "utf8",
    ),
  );
});

test("each page agent card describes its own capability", async () => {
  const { runtimeDir } = await registeredPlugins();
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

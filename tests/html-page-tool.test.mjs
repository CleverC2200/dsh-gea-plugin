import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { parse as parseYaml } from "yaml";

const session = "session-11111111-1111-1111-1111-111111111111";

/** 建一个最小可用的 HTML 业务插件，只用来验证页面工具对模型的行为。 */
async function probePlugin() {
  const root = await mkdtemp(join(tmpdir(), "gea-html-probe-"));
  await mkdir(join(root, "skills", "probe"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><html><body>probe</body></html>\n");
  await writeFile(
    join(root, "skills", "probe", "SKILL.md"),
    "---\nname: inventory-probe\ndescription: 探针业务规则。\n---\n\n# 探针页面\n\nPROBE-RULE-42：建议量 = ceil(max(0, 缺货量 − 调拨中量))。\n",
  );
  await writeFile(join(root, "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "inventory-probe",
    name: "探针页面",
    version: "0.0.0",
    html: "index.html",
    skills: ["skills/probe/SKILL.md"],
    mcp: "mcp.json",
    mode: "mock",
    gea: { consumerCode: "probe-consumer", readonly: true, contract: "gea-html-v1" },
  }));
  await writeFile(join(root, "mcp.json"), JSON.stringify({
    provider: "gea",
    transport: "host-provided",
    contract: "gea-html-v1",
    consumer: { consumerType: "AGENT", consumerCode: "probe-consumer" },
    capabilities: ["governed-sql-read"],
  }));
  return root;
}

async function registeredPlugins() {
  const root = await probePlugin();
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-html-runtime-"));
  const tools = [];
  const routes = [];
  const ctx = {
    effect: (fn) => fn(),
    tools: { register: (tool) => tools.push(tool) },
    connection: { fetch: { register: (route) => routes.push(route) } },
  };
  const business = {
    config: { runtimeDir },
    status: () => ({ authenticated: true }),
    watchIdentity: () => () => {},
  };
  await registerHtmlPlugins(ctx, business, [root]);
  return { tool: tools.find((tool) => tool.name === "inventory_probe_page"), routes, runtimeDir };
}

test("a page tool reports not-in-workbench instead of failing the conversation", async () => {
  const { tool } = await registeredPlugins();
  assert.ok(tool, "页面工具已注册");
  for (const name of ["context", "refresh", "filter", "draft"]) {
    const result = JSON.parse(
      await tool.execute({ name, parameters: "{}" }, { agent: { id: session }, signal: new AbortController().signal }),
    );
    assert.equal(result.availability, "not-in-workbench", name);
    assert.equal(result.code, "PAGE_NOT_IN_WORKBENCH", name);
    assert.equal(result.action, name);
    assert.equal(result.page, "探针页面");
    assert.match(result.reason, /不在业务工作台/);
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
    await tool.execute({ name: "context", parameters: "{}" }, { agent: { id: session }, signal: new AbortController().signal }),
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
    await tool.execute({ name: "context", parameters: "{}" }, { agent: { id: session }, signal: new AbortController().signal }),
  );
  assert.equal(closed.availability, "not-in-workbench");
  assert.equal(closed.context, undefined, "关闭后不再泄露页面数据");
  assert.equal(closed.renderedAt, undefined);
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

test("the all-in-one agent preset is generated from the repo template with the plugin index", async () => {
  const { runtimeDir } = await registeredPlugins();
  const generated = await readFile(
    join(runtimeDir, "native-presets", "gea-agent-hub", "agent.cordis.yml"),
    "utf8",
  );
  assert.match(generated, /全能业务助手/);
  assert.match(generated, /inventory-probe/);
  assert.match(generated, /探针业务规则/);
  assert.doesNotMatch(generated, /\{\{SKILL_INDEX\}\}/, "占位符已替换");
  assert.doesNotMatch(generated, /\{\{SKILL_REFERENCE\}\}/);
  assert.match(generated, /lib\/skill-reference\.js/);
  const preset = await readFile(
    join(runtimeDir, "native-presets", "gea-agent-hub", "preset.yml"),
    "utf8",
  );
  assert.match(preset, /name: 全能业务助手/);
  // 生成的 preset 必须是合法 YAML，且索引落在 persona 的块标量里（曾经因为缩进错整份加载失败）。
  const rows = parseYaml(generated);
  const persona = rows.find((row) => row.id === "persona");
  assert.ok(persona, "persona 行存在");
  assert.match(persona.config.prefix, /inventory-probe/);
  assert.match(persona.config.prefix, /探针业务规则/);
  assert.match(persona.config.prefix, /共 1 个模块/);
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

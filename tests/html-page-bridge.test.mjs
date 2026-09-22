/**
 * 迁移过来的 HTML 业务页面：宿主把适配器注入页面，页面通过它报元素、收改单。
 *
 * 这里验证接线而不是重复验证扫描算法（算法在 html-page-scan.test.mjs 里跑真实脚本）：
 *   - 页面 HTML 被注入扫描脚本（页面本身不用改）；
 *   - 页面报的元素经宿主校验后变成页面目录（surface / tool / 说明由宿主写死）；
 *   - 页面报空或撤走时，宿主撤掉这个会话的页面能力；
 *   - 页面的改动回执原样交给桥。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import {
  compilePageCatalog,
  validatePageCatalog,
} from "../src/page-bridge/catalog.ts";

const session = "session-11111111-1111-1111-1111-111111111111";

async function probePlugin(id = "inventory-probe", name = "探针页面", options = {}) {
  const mock = options.mock !== false;
  const root = await mkdtemp(join(tmpdir(), "gea-html-bridge-"));
  await mkdir(join(root, "skills", "probe"), { recursive: true });
  await writeFile(
    join(root, "index.html"),
    "<!doctype html><html><body><table><thead><tr><th>SKU</th></tr></thead>" +
      "<tbody><tr><td>SKU-1</td></tr></tbody></table></body></html>\n",
  );
  await writeFile(
    join(root, "skills", "probe", "SKILL.md"),
    `---\nname: ${id}\ndescription: 探针业务规则。\n---\n\n## 口径\n\n建议量 = ceil(max(0, 缺货量 − 调拨中量))。\n`,
  );
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name,
      version: "0.0.0",
      html: "index.html",
      skills: ["skills/probe/SKILL.md"],
      mcp: "mcp.json",
      ...(mock ? { mode: "mock" } : {}),
      gea: {
        consumerCode: id + "-consumer",
        readonly: true,
        contract: "gea-html-v1",
      },
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      provider: "gea",
      transport: "host-provided",
      contract: "gea-html-v1",
      consumer: { consumerType: "AGENT", consumerCode: id + "-consumer" },
      capabilities: ["governed-sql-read"],
    }),
  );
  return root;
}

async function registered(specs = ["inventory-probe"]) {
  const roots = [];
  for (const spec of specs) {
    const item = typeof spec === "string" ? { id: spec } : spec;
    roots.push(await probePlugin(item.id, item.name, item));
  }
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-html-bridge-runtime-"));
  const routes = [];
  const declared = [];
  const tools = [];
  const ctx = {
    effect: (fn) => fn(),
    tools: {
      register: (tool) => {
        tools.push(tool);
        return () => {};
      },
    },
    connection: { fetch: { register: (route) => routes.push(route) } },
  };
  // 宿主侧的"当前页身份"：页面每一次活动都会刷新它（见 page-identity.ts）。
  const identities = new Map();
  const business = {
    config: { runtimeDir },
    status: () => ({ authenticated: true, user: { id: "u-1" } }),
    watchIdentity: () => () => {},
    identitySignal: () => new AbortController().signal,
    htmlLaunch: async (consumerCode) => ({ sessionId: "deleg-" + consumerCode }),
    pullPageBridgeEvents: (sessionId, toolMessages) => ({
      events: [{ sessionId, received: toolMessages }],
    }),
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
  const plugins = await registerHtmlPlugins(ctx, business, roots, {
    declare: (sessionId, catalog) => declared.push({ sessionId, catalog }),
  });
  return {
    routes,
    declared,
    tools,
    identities,
    plugin: plugins.capabilityContracts[0],
    consumerForSession: plugins.consumerForSession,
  };
}

const post = (route, body) =>
  route.fetch(
    new Request("http://local" + route.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("页面 HTML 里被注入扫描脚本，页面自己不用改", async () => {
  const { routes } = await registered();
  const html = routes.find((route) => route.path.endsWith("/html"));
  const body = await (await html.fetch(new Request("http://local/html"))).text();
  assert.match(body, /gea-html-v2/);
  assert.match(body, /__geaPageScan/);
  // 页面原本的内容还在。
  assert.match(body, /SKU-1/);
});

test("页面报的元素经宿主校验后变成这一屏的页面能力", async () => {
  const { routes, declared, plugin } = await registered();
  const open = routes.find((route) => route.path.endsWith("/open"));
  const call = routes.find((route) => route.path.endsWith("/call"));
  const { lease } = await (await post(open, { session })).json();
  const elements = [
    {
      id: "field:sku-1:补货量",
      role: "field",
      label: "补货量",
      value: "10",
      editable: true,
    },
    {
      id: "readout:sku-1:缺货量",
      role: "field",
      label: "缺货量 · sku-1",
      value: "180",
    },
    {
      id: "control:通过",
      role: "control",
      label: "通过",
      actions: ["invoke"],
      effect: "approve",
    },
  ];
  const response = await (
    await post(call, {
      lease,
      method: "page-bridge",
      parameters: {
        sessionId: session,
        toolMessages: [
          { id: "r1", role: "tool", toolCallId: "t1", content: '{"applied":true}' },
        ],
        catalog: { elements },
      },
    })
  ).json();
  // 改动回执交给桥。
  assert.equal(response.events[0].received[0].toolCallId, "t1");

  assert.equal(declared.length, 1);
  assert.equal(declared[0].sessionId, session);
  const declaredCatalog = declared[0].catalog;
  // 页面标识 / 工具名 / 说明由宿主写死，页面只能报元素。
  assert.equal(plugin.view.surface, "gea-html-inventory-probe");
  assert.equal(plugin.maxEffect, "view");
  assert.equal(declaredCatalog.surface, plugin.view.surface);
  assert.equal(declaredCatalog.tool, "gea_plugin_page_apply");
  assert.match(declaredCatalog.description, /探针页面/);
  const validated = validatePageCatalog(declaredCatalog);
  assert.equal(validated.elements.length, 3);
  assert.equal(validated.elements[2].effect, "approve");
  // 说明里写清只读元素与提交/审批类元素的规矩。
  const compiled = compilePageCatalog(validated);
  assert.match(compiled.description, /只读元素/);
  assert.match(compiled.description, /审批类/);
  assert.ok(compiled.parameters.some((parameter) => parameter.name === "confirm"));
});

test("页面报空或撤走时，宿主把这个会话的页面能力撤掉", async () => {
  const { routes, declared } = await registered();
  const open = routes.find((route) => route.path.endsWith("/open"));
  const call = routes.find((route) => route.path.endsWith("/call"));
  const { lease } = await (await post(open, { session })).json();
  await post(call, {
    lease,
    method: "page-bridge",
    parameters: { sessionId: session, toolMessages: [], catalog: { elements: [] } },
  });
  assert.equal(declared.at(-1).catalog, null, "空元素 = 这一屏没有可操作能力");
  await post(call, {
    lease,
    method: "page-bridge",
    parameters: { sessionId: session, toolMessages: [], catalog: null },
  });
  assert.equal(declared.at(-1).catalog, null);
});

test("页面工具只对当前打开的页面有效：读错页面会被纠正，而不是给空上下文", async () => {
  // 模块 id 受宿主校验（^inventory-[a-z]+$），第二个页面用 inventory-two。
  const { routes, identities, tools } = await registered([
    "inventory-probe",
    { id: "inventory-two", name: "第二个页面" },
  ]);
  const openA = routes.find((route) => route.path === "/api/gea-html/inventory-probe/open");
  const openB = routes.find((route) => route.path === "/api/gea-html/inventory-two/open");
  const exec = { agent: { id: session }, signal: new AbortController().signal };
  const toolA = tools.find((tool) => tool.name === "inventory_probe_page");
  const toolB = tools.find((tool) => tool.name === "inventory_two_page");
  assert.ok(toolA && toolB, "每个模块一个页面工具");

  // A 页打开：当前页身份就是 A。
  await post(openA, { session });
  assert.equal(identities.get(session).pluginId, "inventory-probe");
  assert.equal(identities.get(session).pageTool, "inventory_probe_page");

  // 拿 B 的页面工具去读 A 这一屏：要被纠正到当前页，而不是回一个空 context。
  const wrong = JSON.parse(
    await toolB.execute({ name: "context", parameters: "{}" }, exec),
  );
  assert.equal(wrong.code, "PAGE_IDENTITY_MISMATCH");
  assert.equal(wrong.currentPage.pluginId, "inventory-probe");
  assert.match(wrong.reason, /inventory_probe_page/);

  // 切到 B：身份跟着走，这时才轮到 A 的工具被纠正。
  await post(openB, { session });
  assert.equal(identities.get(session).pluginId, "inventory-two");
  const wrongA = JSON.parse(
    await toolA.execute({ name: "context", parameters: "{}" }, exec),
  );
  assert.equal(wrongA.code, "PAGE_IDENTITY_MISMATCH");
  assert.match(wrongA.reason, /inventory_two_page/);

  // 当前页自己调用仍然真的读页面。
  const ok = JSON.parse(
    await toolB.execute({ name: "context", parameters: "{}" }, exec),
  );
  assert.equal(ok.source, "page-observation");
});

test("页面关掉后身份清空；真实模块的模型 agentCode 跟着当前页走", async () => {
  const { routes, identities, consumerForSession } = await registered([
    { id: "inventory-real", mock: false },
  ]);
  const open = routes.find((route) => route.path === "/api/gea-html/inventory-real/open");
  const call = routes.find((route) => route.path === "/api/gea-html/inventory-real/call");

  const { lease } = await (await post(open, { session })).json();
  assert.equal(identities.get(session).pluginId, "inventory-real");
  assert.equal(identities.get(session).mock, false);
  // 模型侧的 agentCode（决定技能/口径）必须跟着当前页，而不是上一个页面。
  assert.equal(consumerForSession(session), "inventory-real-consumer");

  await post(call, { lease, method: "close" });
  assert.equal(identities.get(session), undefined);
  assert.equal(consumerForSession(session), undefined, "没有页面时回到默认 agent");
});

import {currentHtmlResource} from "./fixtures/html-resource.mjs";
/** Current pages own their catalogs; Host validates identity and permissions. */
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
        contract: "gea-html-v2",
      },
    }),
  );
  await writeFile(
    join(root, "mcp.json"),
    JSON.stringify({
      provider: "gea",
      transport: "host-provided",
      contract: "gea-html-v2",
      consumer: { consumerType: "AGENT", consumerCode: id + "-consumer" },
      capabilities: ["governed-sql-read"],
    }),
  );
  await currentHtmlResource(root);
  return root;
}

async function registered(t, specs = ["inventory-probe"], options = {}) {
  const roots = [];
  for (const spec of specs) {
    const item = typeof spec === "string" ? { id: spec } : spec;
    roots.push(await probePlugin(item.id, item.name, item));
  }
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-html-bridge-runtime-"));
  const routes = [];
  const declared = [];
  const tools = [];
  const identityListeners = new Set();
  let identityScope = "fixture-scope";
  let identityController = new AbortController();
  const disposers = [];
  const ctx = {
    agents: { get: id => id === session ? { session: {} } : undefined },
    sessionProjections: { stateOf: () => `gea-html-${specs.find(spec => typeof spec !== "string" && spec.mock === false)?.id}` },
    get: name => name === "agentPresets" ? {resolve: async id => ({id})} : undefined,
    effect: (fn) => { const value = fn(); if (typeof value === "function") disposers.push(value); return value; },
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
    pageSessionScope: () => identityScope,
    watchIdentity: (listener) => { identityListeners.add(listener); return () => identityListeners.delete(listener); },
    identitySignal: () => identityController.signal,
    htmlLaunch: options.htmlLaunch ?? (async (consumerCode) => ({ sessionId: "deleg-" + consumerCode })),
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
  const dispose = async () => { for (const cleanup of disposers.splice(0).reverse()) await cleanup(); };
  t.after(dispose);
  return {
    routes,
    declared,
    tools,
    identities,
    plugin: plugins.capabilityContracts[0],
    consumerForSession: plugins.consumerForSession,
    authorizeReference: plugins.authorizeReference,
    business,
    dispose,
    changeIdentity: () => {
      identityController.abort();
      identityController = new AbortController();
      identityScope = "next-scope";
      for (const listener of identityListeners) listener();
    },
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

test("mock HTML references retain their real Session/lease boundary without GEA login", async t => {
  const fixture = await registered(t);
  fixture.business.status = () => ({ authenticated: false, user: null });
  const open = fixture.routes.find(route => route.path.endsWith("/open"));
  const { lease } = await (await post(open, { session })).json();
  assert.equal(typeof lease, "string");
  const reference = { sessionId: session, surface: "gea-html-inventory-probe", lease };
  assert.doesNotThrow(() => fixture.authorizeReference(reference));
  assert.throws(() => fixture.authorizeReference({ ...reference, lease: undefined }), /LEASE_REQUIRED/);
  assert.throws(() => fixture.authorizeReference({ ...reference, surface: "gea-html-another" }), /ACCESS_DENIED/);
  assert.throws(() => fixture.authorizeReference({ ...reference, sessionId: "missing-session" }), /ACCESS_DENIED/);
  assert.throws(() => fixture.authorizeReference({ ...reference, surface: "gea-workbench" }), /LOGIN_REQUIRED|ACCESS_DENIED/);
});

test("宿主保留页面内容和引用工具，不再注入扫描器", async t => {
  const { routes } = await registered(t);
  const html = routes.find((route) => route.path.endsWith("/html"));
  const body = await (await html.fetch(new Request("http://local/html"))).text();
  assert.doesNotMatch(body, /__geaPageScan|MutationObserver|gea-html-v1/);
  // 页面原本的内容还在。
  assert.match(body, /SKU-1/);
});

test("页面报的元素经宿主校验后变成这一屏的页面能力", async t => {
  const { routes, declared, plugin } = await registered(t);
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

test("页面报空或撤走时，宿主把这个会话的页面能力撤掉", async t => {
  const { routes, declared } = await registered(t);
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

test("页面入口只有一个工具：按当前页身份路由，切页后同一个工具读新页", async t => {
  // 模块 id 受宿主校验（^inventory-[a-z]+$），第二个页面用 inventory-two。
  const { routes, identities, tools } = await registered(t, [
    "inventory-probe",
    { id: "inventory-two", name: "第二个页面" },
  ]);
  const openA = routes.find((route) => route.path === "/api/gea-html/inventory-probe/open");
  const openB = routes.find((route) => route.path === "/api/gea-html/inventory-two/open");
  const callA = routes.find((route) => route.path === "/api/gea-html/inventory-probe/call");
  const callB = routes.find((route) => route.path === "/api/gea-html/inventory-two/call");
  const exec = { agent: { id: session }, signal: new AbortController().signal };
  const pageTools = tools.filter((tool) => tool.name === "gea_page");
  assert.equal(pageTools.length, 1, "装几个模块都只注册一个页面工具");
  const tool = pageTools[0];

  // A 页打开：身份是 A，同一个工具读到 A 的证据。
  const openedA = await (await post(openA, { session })).json();
  await post(callA, {
    lease: openedA.lease,
    method: "context",
    parameters: { rows: [{ name: "A 行" }] },
  });
  assert.equal(identities.get(session).pluginId, "inventory-probe");
  assert.equal(identities.get(session).pageTool, "gea_page");
  const onA = JSON.parse(
    await tool.execute({ action: "context", parameters: "{}" }, exec),
  );
  assert.equal(onA.source, "page-observation");
  assert.deepEqual(onA.context, { rows: [{ name: "A 行" }] });

  // 切到 B：身份跟着走，同一个工具读到的是 B 的证据（不再有"读错页面"这条路）。
  const openedB = await (await post(openB, { session })).json();
  await post(callB, {
    lease: openedB.lease,
    method: "context",
    parameters: { rows: [{ name: "B 行" }] },
  });
  assert.equal(identities.get(session).pluginId, "inventory-two");
  const onB = JSON.parse(
    await tool.execute({ action: "context", parameters: "{}" }, exec),
  );
  assert.equal(onB.source, "page-observation");
  assert.deepEqual(onB.context, { rows: [{ name: "B 行" }] });
});

test("页面关掉后身份清空；真实模块的模型 agentCode 跟着当前页走", async t => {
  const { routes, identities, consumerForSession } = await registered(t, [
    { id: "inventory-real", mock: false },
  ]);
  const open = routes.find((route) => route.path === "/api/gea-html/inventory-real/open");
  const call = routes.find((route) => route.path === "/api/gea-html/inventory-real/call");

  const { lease } = await (await post(open, { session, scope: "fixture-scope" })).json();
  assert.equal(identities.get(session).pluginId, "inventory-real");
  assert.equal(identities.get(session).mock, false);
  // 模型侧的 agentCode（决定技能/口径）必须跟着当前页，而不是上一个页面。
  assert.equal(consumerForSession(session), "inventory-real-consumer");

  await post(call, { lease, method: "close" });
  assert.equal(identities.get(session), undefined);
  assert.equal(consumerForSession(session), "inventory-real-consumer", "关闭页面不改变持久Session已选Agent的授权身份");
});

test("a page launch finishing after identity change cannot mount its old lease", async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { routes, identities, changeIdentity } = await registered(t,
    [{ id: "inventory-real", mock: false }],
    { htmlLaunch: async () => { entered.resolve(); await release.promise; return { sessionId: "old-delegation" }; } },
  );
  const open = routes.find(route => route.path === "/api/gea-html/inventory-real/open");
  const pending = post(open, { session, scope: "fixture-scope" });
  await entered.promise;
  changeIdentity();
  release.resolve();
  const response = await pending;
  assert.equal(response.status, 400);
  assert.equal(identities.has(session), false, "late launch must not install a page identity");
});

test("resource teardown clears its page identity and rejects the old lease", async t => {
  const subject = await registered(t, [{id:"inventory-real",mock:false}]);
  const open = subject.routes.find(route => route.path.endsWith("/open"));
  const call = subject.routes.find(route => route.path.endsWith("/call"));
  const {lease} = await (await post(open, {session,scope:"fixture-scope"})).json();
  assert.equal(subject.identities.get(session)?.pluginId,"inventory-real");
  await subject.dispose();
  assert.equal(subject.identities.has(session),false,"disabled resources cannot remain the current page");
  assert.equal(subject.declared.at(-1)?.catalog,null,"resource teardown must withdraw page capabilities");
  const response = await post(call,{lease,method:"context",parameters:{rows:[{name:"late"}]}});
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/PAGE_LEASE_EXPIRED/);
});
test("closing a previous page lease cannot clear another page's current identity", async t => {
  const subject = await registered(t,["inventory-a","inventory-b"]);
  const openA = subject.routes.find(route => route.path === "/api/gea-html/inventory-a/open");
  const openB = subject.routes.find(route => route.path === "/api/gea-html/inventory-b/open");
  const callA = subject.routes.find(route => route.path === "/api/gea-html/inventory-a/call");
  const {lease} = await (await post(openA,{session})).json();
  await post(openB,{session});
  const declarations = subject.declared.length;
  assert.equal((await post(callA,{lease,method:"close"})).status,200);
  assert.equal(subject.identities.get(session)?.pluginId,"inventory-b");
  assert.equal(subject.declared.length,declarations);
});
test("reopening the same page keeps the new lease's current identity", async t => {
  const subject = await registered(t,["inventory-probe"]);
  const open = subject.routes.find(route => route.path.endsWith("/open"));
  const call = subject.routes.find(route => route.path.endsWith("/call"));
  const first = await (await post(open,{session})).json();
  const second = await (await post(open,{session})).json();
  assert.notEqual(second.lease,first.lease);
  assert.equal(subject.identities.get(session)?.pluginId,"inventory-probe");
  assert.equal((await post(call,{lease:second.lease,method:"context",parameters:{rows:[]}})).status,200);
  assert.equal((await post(call,{lease:first.lease,method:"context",parameters:{rows:[]}})).status,400);
});
test("an opening finished after resource teardown cannot install a page identity", async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const subject = await registered(t,[{id:"inventory-real",mock:false}],{
    htmlLaunch: async () => {entered.resolve();await release.promise;return {sessionId:"late-delegation"};},
  });
  const open = subject.routes.find(route => route.path.endsWith("/open"));
  const opening = post(open,{session,scope:"fixture-scope"});
  await entered.promise;
  await subject.dispose();
  release.resolve();
  const response = await opening;
  assert.equal(response.status,400);
  assert.equal(subject.identities.has(session),false);
});

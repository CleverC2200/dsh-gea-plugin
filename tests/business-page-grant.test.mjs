import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHtmlPlugins } from "../src/html-plugins.ts";
import { writeHtmlDeclarations } from "./fixtures/html-resource.mjs";
const session = "session-11111111-1111-4111-8111-111111111111";
test("registered regional, category and MPS mock resources authorize only their current page and no business query", async (t) => {
  for (const [id, pageId, consumer] of [
    ["plan-regional", "gea-regional-plan", "regional-plan-prototype"],
    ["category-plan", "plan-region-category", "category-plan-prototype"],
    ["inventory-mps", "plan-category-production", "mps-prototype"],
  ]) {
    const h = await fixture(t, {
      id,
      pageId,
      consumer,
      mock: true,
      ...(id === "plan-regional" ? { resourceRoot: "../dsh-agent-workbench/static/regional" } : {}),
    });
    assert.ok(h.resources.has(`gea-html-${id}`));
    assert.ok(h.adapters.has(pageId));
    const grant = await h.authorize();
    assert.equal(grant.allowsEffect("view"), true);
    assert.equal(grant.allowsEffect("approve"), false);
    assert.deepEqual(h.launches, []);
    await assert.rejects(
      grant.readSql({ sql: "select 1" }, new AbortController().signal),
      /MOCK_DATA_ONLY/,
    );
    assert.deepEqual(h.queries, []);
    grant.release();
    assert.equal(h.identities.size, 0);
    h.dispose();
    assert.equal(h.resources.size, 0);
    assert.equal(h.adapters.size, 0);
    assert.equal(h.surfaces.size, 0);
  }
});
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "gea-business-grant-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = options.id ?? "inventory-grant",
    preset = "gea-html-" + id,
    consumer = options.consumer ?? id + "-consumer";
  const pageId = options.pageId ?? id;
  await writeFile(join(directory, "index.html"), "<html><body>Unchanged original</body></html>");
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${id}\ndescription: original\n---\nOriginal business rule.\n`,
  );
  await writeFile(
    join(directory, "plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: "Original page",
      html: "index.html",
      pages: [{ id: pageId, name: "Original page", view: "" }],
      skills: ["SKILL.md"],
      mcp: "mcp.json",
      ...(options.mock ? { mode: "mock" } : {}),
      declarations: { page: "page.json", capability: "capability.json" },
      agentResources: { provider: "dsh-agent-manage", prompt: "prompt.json" },
      gea: { contract: "gea-html-v2", consumerCode: consumer, readonly: true },
    }),
  );
  await writeFile(
    join(directory, "mcp.json"),
    JSON.stringify({
      provider: "gea",
      transport: "host-provided",
      contract: "gea-html-v2",
      consumer: { consumerType: "AGENT", consumerCode: consumer },
      capabilities: options.mock ? [] : ["governed-sql-read"],
    }),
  );
  await writeHtmlDeclarations(directory, {
    page: {
      surface: `gea-html-${id}`,
      protocol: "self-report",
      pageIds: [pageId],
      consumerCode: consumer,
      maxEffect: "view",
    },
    capability: {
      id: id,
      label: "Original page",
      data: {
        consumerCode: consumer,
        tables: [],
        rules: [],
        ...(options.mock ? { mock: true } : {}),
      },
      maxEffect: "view",
      layers: ["read"],
      skills: [id],
      routing: { keywords: [id], summary: "Original page" },
    },
    prompt: {
      label: "Original page",
      consumerCode: consumer,
      persona: "只读测试页面，保留用户会话与权限边界。",
      skills: [id],
    },
  });
  if (options.resourceRoot) await cp(options.resourceRoot, directory, { recursive: true });
  const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
  const packages = [{ directory, htmlPath: join(directory, "index.html"), manifest }];
  if (options.second) {
    const second = join(directory, "second");
    await mkdir(second);
    for (const name of ["index.html", "SKILL.md", "mcp.json"])
      await writeFile(join(second, name), await readFile(join(directory, name)));
    const m = {
      ...manifest,
      id: "inventory-other",
      pages: [{ id: "inventory-other", name: "Other interpreter", view: "" }],
      name: "Other interpreter",
      gea: { ...manifest.gea, consumerCode: "other-consumer" },
    };
    await writeFile(join(second, "plugin.json"), JSON.stringify(m));
    const secondMcp = JSON.parse(await readFile(join(second, "mcp.json"), "utf8"));
    secondMcp.consumer.consumerCode = "other-consumer";
    await writeFile(join(second, "mcp.json"), JSON.stringify(secondMcp));
    await writeFile(
      join(second, "SKILL.md"),
      "---\nname: inventory-other\ndescription: Other interpreter\n---\nOther original rules.\n",
    );
    await writeHtmlDeclarations(second, {
      page: {
        surface: `gea-html-${m.id}`,
        protocol: "self-report",
        pageIds: ["inventory-other"],
        consumerCode: "other-consumer",
        maxEffect: "view",
      },
      capability: {
        id: m.id,
        label: m.name,
        data: {
          consumerCode: "other-consumer",
          tables: [],
          rules: [],
          ...(options.mock ? { mock: true } : {}),
        },
        maxEffect: "view",
        layers: ["read"],
        skills: [m.id],
        routing: { keywords: [m.id], summary: m.name },
      },
      prompt: {
        label: m.name,
        consumerCode: "other-consumer",
        persona: "只读测试页面，保留用户会话与权限边界。",
        skills: [m.id],
      },
    });
    packages.push({
      directory: second,
      htmlPath: join(second, "index.html"),
      manifest: JSON.parse(await readFile(join(second, "plugin.json"), "utf8")),
    });
  }
  const surfaces = new Map();
  const cleanups = [],
    adapters = new Map(),
    resources = new Set(),
    routes = new Map(),
    identities = new Map(),
    queries = [],
    launches = [];
  let identity = new AbortController(),
    scope = "original-principal",
    selected = preset,
    authenticated = !options.mock;
  const ctx = {
    agents: { get: (id) => (id === session ? { session: {} } : undefined) },
    sessionProjections: { stateOf: () => selected },
    get: () => ({ resolve: async (id) => ({ id }) }),
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    agentResources: {
      register: async (entries) => {
        entries.forEach((e) => resources.add(e.id));
        return () => entries.forEach((e) => resources.delete(e.id));
      },
      interpreters: () => [...resources],
    },
    workbenchPages: {
      registerBusinessPage(page, authorize) {
        adapters.set(page.id, authorize);
        return () => adapters.delete(page.id);
      },
    },
  };
  const business = {
    config: { analysisAgentCode: "aps", runtimeDir: directory },
    status: () => ({
      environment: "test",
      authenticated,
      user: authenticated ? { id: "user", tenantId: "tenant" } : null,
    }),
    pageSessionScope: () => scope,
    identitySignal: () => identity.signal,
    htmlLaunch: async (code, signal) => {
      launches.push(code);
      if (options.launch) return options.launch(signal);
      return { sessionId: "delegation", roleProfile: { roles: ["reader"] } };
    },
    pluginSql: async (input, signal) => {
      signal.throwIfAborted();
      queries.push(input);
      if (options.queryError) throw Error(options.queryError);
      return { rows: [{ qty: 42 }] };
    },
    setSurface: (id, value) => {
      const surface = { ...value };
      surfaces.set(id, surface);
      return surface;
    },
    surfaceFor: (id) => surfaces.get(id),
    clearSurface: (id, menu) => {
      if (surfaces.get(id)?.menu === menu) surfaces.delete(id);
    },
    touchPageIdentity: (id, value) => identities.set(id, value),
    clearPageIdentity: (id, plugin) => {
      if (identities.get(id)?.pluginId === plugin) identities.delete(id);
    },
    currentPageIdentity: (id) => identities.get(id),
  };
  await registerHtmlPlugins(ctx, business, packages);
  const dispose = () => {
    cleanups
      .splice(0)
      .reverse()
      .forEach((off) => off());
  };
  t.after(dispose);
  return {
    adapters,
    queries,
    launches,
    identities,
    routes,
    dispose,
    authorize: (signal = new AbortController().signal) =>
      adapters.get(pageId)(session, preset, signal),
    changeIdentity() {
      identity.abort();
      identity = new AbortController();
      scope = "replacement-principal";
    },
    select(value) {
      selected = value;
    },
    resources,
    surfaces,
    id,
    preset,
  };
}
test("actual HTML grant retains its declared Consumer and protected SQL failures without a generic GEA method route", async (t) => {
  const h = await fixture(t);
  const grant = await h.authorize();
  assert.equal(grant.access.principalId, "user");
  assert.equal(grant.access.gatewayScopeRef, "delegation");
  assert.equal(grant.allowsEffect("view"), true);
  assert.equal(grant.allowsEffect("approve"), false);
  assert.equal(grant.allowsEffect("draft"), false);
  assert.deepEqual(
    await grant.readSql({ consumerCode: "forged", sql: "select 1" }, new AbortController().signal),
    { rows: [{ qty: 42 }] },
  );
  assert.equal(h.queries[0].consumerCode, "inventory-grant-consumer");
  assert.equal(
    [...h.routes.keys()].some((path) => path.endsWith("/open") || path.endsWith("/call")),
    false,
  );
  grant.release();
  assert.equal(h.identities.size, 0);
});
test("real grant verifies selected official preset and installed resource before any Consumer launch", async (t) => {
  const h = await fixture(t);
  h.select("unrelated");
  await assert.rejects(h.authorize(), /PAGE_AGENT_PRESET_NOT_ALLOWED/);
  assert.equal(h.launches.length, 0);
  h.select(h.preset);
  h.resources.clear();
  await assert.rejects(h.authorize(), /PAGE_AGENT_PRESET_NOT_ALLOWED/);
  assert.equal(h.launches.length, 0);
});
test("identity revocation blocks a pending authorization and the historical Session cannot bind a different principal", async (t) => {
  const gate = Promise.withResolvers();
  const h = await fixture(t, { launch: () => gate.promise });
  const opening = h.authorize();
  await new Promise((r) => setImmediate(r));
  h.changeIdentity();
  gate.resolve({ sessionId: "obsolete" });
  await assert.rejects(opening);
  assert.equal(h.identities.size, 0);
  h.dispose();
  const other = await fixture(t);
  await other.authorize();
  other.changeIdentity();
  await assert.rejects(other.authorize(), /PAGE_SESSION_IDENTITY_MISMATCH/);
});
test("resource teardown or replacement request cannot install a late business projection", async (t) => {
  const gate = Promise.withResolvers();
  const h = await fixture(t, { launch: () => gate.promise });
  const controller = new AbortController();
  const opening = h.authorize(controller.signal);
  await new Promise((r) => setImmediate(r));
  controller.abort();
  gate.resolve({ sessionId: "late" });
  await assert.rejects(opening);
  assert.equal(h.identities.size, 0);
  h.dispose();
  const gate2 = Promise.withResolvers();
  const other = await fixture(t, { launch: () => gate2.promise });
  const pending = other.authorize();
  await new Promise((r) => setImmediate(r));
  other.dispose();
  gate2.resolve({ sessionId: "late" });
  await assert.rejects(pending);
  assert.equal(other.identities.size, 0);
});
test("explicit mock grant never launches GEA and never reads business SQL", async (t) => {
  const h = await fixture(t, { mock: true });
  const grant = await h.authorize();
  assert.equal(grant.access.mode, "mock");
  assert.equal(h.launches.length, 0);
  await assert.rejects(grant.readSql({}, new AbortController().signal), /MOCK_DATA_ONLY/);
});
test("actual SQL permission refusal stays a refusal rather than selecting another Consumer", async (t) => {
  const h = await fixture(t, { queryError: "RESOURCE_ACCESS_DENIED" });
  const grant = await h.authorize();
  await assert.rejects(
    grant.readSql({ sql: "select 1" }, new AbortController().signal),
    /RESOURCE_ACCESS_DENIED/,
  );
  assert.deepEqual(h.launches, ["inventory-grant-consumer"]);
});

test("releasing an obsolete business grant cannot clear the replacement projection of the same page", async (t) => {
  const h = await fixture(t);
  const old = await h.authorize();
  const current = await h.authorize();
  old.release();
  assert.equal(h.identities.size, 1);
  current.release();
  assert.equal(h.identities.size, 0);
});

test("the page grant authorizes an installed permitted interpreter using its actual Core Session projection", async (t) => {
  const h = await fixture(t, { second: true });
  h.select("gea-html-inventory-other");
  const grant = await h.authorize();
  assert.deepEqual(h.launches, ["other-consumer", "inventory-grant-consumer"]);
  assert.equal(grant.access.gatewayScopeRef, "delegation");
  assert.equal(h.identities.size, 1);
  grant.release();
  assert.equal(h.identities.size, 0);
});

test("the current HTML grant publishes only its owned menu surface and an old release cannot clear a replacement", async (t) => {
  const h = await fixture(t);
  const old = await h.authorize();
  assert.equal(h.surfaces.get(session)?.menu, h.id);
  const replacement = await h.authorize();
  old.release();
  assert.equal(h.surfaces.get(session)?.menu, h.id);
  h.identities.clear();
  replacement.release();
  assert.equal(h.surfaces.size, 0);
});

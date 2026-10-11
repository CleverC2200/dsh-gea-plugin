import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";
const core = resolve("../../official-latest-standard");
const official = (path) => import(pathToFileURL(resolve(core, path, "lib/index.js")).href);
const { Context } = await official("vendor/cordis");
const {
  default: SessionStore,
  SessionId,
  SESSION_FORMAT_VERSION,
} = await official("packages/core/session");
const { default: Agents } = await official("packages/core/agent");
const { default: Tools } = await official("packages/core/tools");
const { default: SystemPrompt } = await official("packages/core/system-prompt");
const { default: Llm } = await official("packages/llm/llm");
const { default: Projections } = await official("packages/session/session-projection");
const { default: Query } = await official("packages/session-query/session-query");
const { default: Typert } = await official("packages/typert/registry");
const { default: SessionController } = await official("packages/api/session-controller");
const { agentPresetProjectionDefinition } = await official("packages/preset/agent-preset-registry");
const { default: Persistence } = await official("packages/session/session-persistence-jsonl");
const { default: Loop } = await official("packages/core/agent-loop");
async function compiled(contents, repo, directory, url) {
  const result = await build({
    stdin: { contents, resolveDir: repo },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [
      {
        name: "source-owned-external-packages",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, async (args) => {
            if (args.pluginData === "source-package-resolution") return;
            const resolved = await build.resolve(args.path, {
              resolveDir: repo,
              kind: args.kind,
              pluginData: "source-package-resolution",
            });
            if (resolved.errors.length) return { errors: resolved.errors };
            return { path: resolved.path, external: true };
          });
        },
      },
    ],
    define: { "import.meta.url": JSON.stringify(pathToFileURL(url).href) },
  });
  const output = join(directory, "source.mjs");
  await writeFile(output, result.outputFiles[0].text);
  return import(pathToFileURL(output).href);
}
test("isolated APS mock fixture retains original resources through Manage selection and official Core Session while SQL/model stay before wire", async (t) => {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(resolve(".runtime/aps-reception-r1-"));
  const manage = resolve("../dsh-agent-manage");
  const manageOutput = join(root, "manage");
  await mkdir(manageOutput);
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  fixtureEnvironment(t, {
    DSH_HOME: join(root, "home"),
    GEA_HTML_LOCAL_QUERY_CONFIG: "",
    GEA_DESKTOP_CONTROL_URL: "",
    GEA_WEB_LOGIN_PERSIST: "0",
  });
  const external = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    external.push(String(input));
    assert.fail("offline public contract must stop before external wire");
  });
  const { apply: applyManage } = await compiled(
    "export {apply} from './src/index.ts';",
    manage,
    manageOutput,
    join(manage, "src/index.ts"),
  );
  const compiledGea = join(root, "gea");
  await mkdir(compiledGea);
  const { registerHtmlPlugins, Business } = await compiled(
    "export {registerHtmlPlugins} from './src/html-plugins.ts';export {Business} from './src/host/business.ts';",
    process.cwd(),
    compiledGea,
    resolve("src/host.ts"),
  );
  const compiledWorkbench = join(root, "workbench");
  await mkdir(compiledWorkbench);
  const workbench = resolve("../dsh-agent-workbench");
  const { HtmlPages } = await compiled(
    "export {HtmlPages} from './src/html-pages.ts';",
    workbench,
    compiledWorkbench,
    join(workbench, "src/host.ts"),
  );
  const routes = new Map(),
    providers = [],
    cleanups = [],
    pending = [],
    presets = new Map();
  const ctx = {
    skills: {
      registerProvider(create) {
        const provider = create({ invalidate() {}, signal: new AbortController().signal });
        providers.push(provider);
        return () => providers.splice(providers.indexOf(provider), 1);
      },
      async list(options) {
        return (await Promise.all(providers.map((provider) => provider.list(options)))).flat();
      },
    },
    agentPresets: {
      async register(definition) {
        presets.set(definition.id, definition);
        return async () => presets.delete(definition.id);
      },
      async resolve(id) {
        return { id };
      },
      async mount(_scope, id) {
        assert.ok(presets.has(id), "the real selected Manage preset is registered");
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
      return () => {};
    },
    provide(name, value) {
      ctx[name] = value;
    },
    logger: { warn() {} },
    inject(names, callback) {
      if (names.includes("connection")) pending.push(Promise.resolve(callback(ctx)));
    },
  };
  const real = new Context();
  let business;
  t.after(async () => {
    for (const off of cleanups.reverse()) await off();
    await real.fiber.dispose();
    business?.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(manageOutput, { recursive: true, force: true });
  });
  await applyManage(ctx, { geaMcp: false });
  await Promise.all(pending);
  real.provide("connection", ctx.connection);
  await real.plugin(Typert);
  await real.plugin(Persistence, { root: join(root, "sessions"), compression: "none" });
  await real.plugin(Llm);
  await real.plugin(SessionStore);
  await real.plugin(Projections);
  new Query(real);
  await real.plugin(SystemPrompt);
  await real.plugin(Tools);
  await real.plugin(Agents);
  await real.plugin(Loop, { agents: [] });
  real.sessionProjections.register(agentPresetProjectionDefinition);
  real.provide("agentDefaultModel", {
    currentSelection: () => ({}),
    saveSelection: async () => {},
  });
  real.provide("fileUploads", {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit() {}, [Symbol.dispose]() {} }),
    retirePrompt() {},
  });
  real.provide("agentPresets", ctx.agentPresets);
  const controller = new SessionController(real, { nativeOpen: false });
  const pages = new HtmlPages(real, "", async () => "<picker-fixture>");
  const apsDirectory = join(root, "aps");
  await cp(join(workbench, "lib/business/inventory-apsplan"), apsDirectory, { recursive: true });
  const manifestPath = join(apsDirectory, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.mode = "mock";
  await writeFile(manifestPath, JSON.stringify(manifest));
  const capabilityPath = join(apsDirectory, "capability.json");
  const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
  capability.data.mock = true;
  await writeFile(capabilityPath, JSON.stringify(capability));
  const mcpPath = join(apsDirectory, "mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  mcp.capabilities = [];
  await writeFile(mcpPath, JSON.stringify(mcp));
  const packages = await pages.registerHtml([apsDirectory]);
  assert.equal(packages[0].manifest.mode, "mock", "only the owned APS fixture is simulated");
  ctx.workbenchPages = pages;
  ctx.agents = real.agents;
  ctx.sessionProjections = real.sessionProjections;
  business = new Business({
    geaBaseUrl: "https://fixture.invalid",
    workbenchCapability: { enabled: false },
    requestTimeoutMs: 1000,
  });
  const registered = await registerHtmlPlugins(ctx, business, packages);
  business.setCapabilities(
    (await import("./../src/capability/registry.ts")).createCapabilityRegistry(
      registered.capabilityContracts,
    ),
  );
  const listResponse = await routes
    .get("/api/agent-manage/resources")
    .fetch(
      new Request(
        "https://fixture.invalid/api/agent-manage/resources?" + new URLSearchParams({ cwd }),
      ),
    );
  assert.equal(listResponse.status, 200);
  const resources = await listResponse.json();
  const resource = resources.find((item) => item.id === "gea-html-inventory-apsplan");
  assert.equal(resource.enabled, true, "the actual registered APS resource must remain selectable");
  assert.deepEqual(resource.missingSkills ?? [], []);
  const response = await routes.get("/api/agent-manage/resources/select").fetch(
    new Request("https://fixture.invalid/api/agent-manage/resources/select", {
      method: "POST",
      body: JSON.stringify({ id: resource.id, cwd }),
    }),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const selected = await response.json();
  assert.equal(selected.preset, resource.id);
  assert.ok(presets.has(selected.preset));
  const id = SessionId("session-11111111-1111-4111-8111-111111111147");
  const writer = await real.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd,
    isSeeded: false,
    agentPreset: selected.preset,
  });
  await writer.append([
    { type: "agent-preset/selected", seq: 0, time: 1, data: { agentPreset: selected.preset } },
  ]);
  await writer.flush();
  await writer.close();
  const open = await routes.get("/api/agent-workbench/page").fetch(
    new Request("https://fixture.invalid/api/agent-workbench/page", {
      method: "POST",
      body: JSON.stringify({
        operation: "open",
        pageId: "inventory-apsplan",
        sessionId: id,
        resourceId: selected.preset,
      }),
    }),
  );
  assert.equal(open.status, 200, JSON.stringify(await open.clone().json()));
  const owned = await open.json();
  const resolved = await controller.resolveAgent(id);
  assert.equal(resolved.agent.id, id);
  assert.equal(resolved.agent.session.header.cwd, cwd);
  const call = async (operation, parameters) => {
    const response = await routes.get("/api/agent-workbench/page").fetch(
      new Request("https://fixture.invalid/api/agent-workbench/page", {
        method: "POST",
        body: JSON.stringify({ operation, owner: owned.owner, parameters }),
      }),
    );
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await call("access")).value.mode, "mock");
  assert.equal(
    (
      await call("context", {
        mode: "APS_MOCK",
        realData: false,
        simulated: true,
        scope: { base: "华东" },
      })
    ).status,
    200,
  );
  const sql = await call("sql", { sql: "SELECT 1" });
  assert.equal(sql.status, 400);
  assert.match(sql.value.error, /MOCK_DATA_ONLY/);
  await assert.rejects(
    business.modelRoute(new AbortController().signal, "aps"),
    /GEA_CAPABILITY_MOCK_ONLY/,
  );
  await assert.rejects(
    business.pluginSql({ consumerCode: "aps", sql: "SELECT 1" }, new AbortController().signal),
    /GEA_CAPABILITY_MOCK_ONLY/,
  );
  assert.equal((await real.sessionPersistence.list()).length, 1);
  assert.deepEqual(external, []);
});

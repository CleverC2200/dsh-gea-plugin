import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BusinessResources } from "dsh-agent-manage/business-resources";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { LlmRuntime, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";

// Exercise Host's registered public routes and adapter. No profile, Task or HTTP server starts.
async function fixture(
  t,
  enabled,
  { mock = false, workbenchEnabled = true, actualBusiness = false } = {},
) {
  fixtureEnvironment(t, {
    GEA_DESKTOP_CONTROL_URL: "",
    GEA_WEB_LOGIN_PERSIST: "0",
    GEA_HTML_LOCAL_QUERY_CONFIG: "",
  });
  const originalFetch = globalThis.fetch;
  const external = [];
  globalThis.fetch = async (input) => {
    external.push(String(input));
    assert.fail("offline resource fixture forbids network");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(resolve(".runtime/disabled-resource-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compiled = await build({
    stdin: {
      contents:
        "export {apply} from './src/host.ts'; export {Business} from './src/host/business.ts';",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
    define: {
      "import.meta.url": JSON.stringify(pathToFileURL(resolve("src/host.ts")).href),
    },
  });
  const output = join(root, "host.mjs");
  await writeFile(output, compiled.outputFiles[0].text);
  const { apply, Business } = await import(pathToFileURL(output));
  const directory = join(root, "dealer");
  await cp(resolve("../dsh-agent-workbench/lib/business/inventory-dealer"), directory, {
    recursive: true,
  });
  const contractPath = join(directory, "capability.json");
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  contract.enabled = enabled;
  if (mock) contract.data.mock = true;
  else delete contract.data.mock;
  await writeFile(contractPath, JSON.stringify(contract));
  const pagePath = join(directory, "page.json");
  const page = JSON.parse(await readFile(pagePath, "utf8"));
  page.visible = false;
  await writeFile(pagePath, JSON.stringify(page));
  const manifest = JSON.parse(await readFile(join(directory, "plugin.json"), "utf8"));
  if (mock) {
    manifest.mode = "mock";
    await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
  }
  if (!mock) {
    delete manifest.mode;
    await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
  }
  const mcpPath = join(directory, "mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  mcp.capabilities = mock ? [] : ["governed-sql-read"];
  await writeFile(mcpPath, JSON.stringify(mcp));
  const pages = new Map();
  const routes = new Map(),
    adapters = new Map(),
    handlers = new Map(),
    tools = new Map(),
    cleanups = [];
  const preset = "gea-html-inventory-dealer";
  // A pre-existing Session's persisted preset projection survives resource changes.
  const agent = {
    id: "session-11111111-1111-4111-8111-111111111111",
    session: { preset, header: { cwd: root }, snapshotEvents: () => [] },
  };
  const ctx = {
    effect(fn) {
      const off = fn();
      if (typeof off === "function") cleanups.push(off);
    },
    on(name, fn) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
      return () => {};
    },
    inject() {},
    provide() {},
    get(name) {
      return ctx[name];
    },
    skills: {
      registerProvider: () => () => {},
      list: async () => [
        {
          name: "inventory-dealer",
          invocation: { userInvocable: true },
          provider: "fixture",
        },
      ],
    },
    agentPresets: {
      register: async () => async () => {},
      resolve: async (id) => ({ id }),
    },
    agents: { get: () => agent, list: () => [agent] },
    sessionProjections: { stateOf: (session) => session.preset },
    workbenchPages: {
      packages: () => [{ directory, manifest, htmlPath: join(directory, "index.html") }],
      registerBusinessPage: (page, authorize) => {
        pages.set(page.id, authorize);
        return () => {};
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route.fetch);
          return () => {};
        },
      },
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => {};
      },
      guard: () => () => {},
      schemas: () => [],
      get: () => undefined,
    },
    llm: {
      registerAdapter(names, adapter) {
        for (const name of names) adapters.set(name, adapter);
        const off = () => {};
        off.replace = () => {};
        return off;
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({}),
      saveSelection: async () => {},
    },
  };
  agent.ctx = { effect: ctx.effect };
  ctx.agentResources = new BusinessResources(ctx, join(root, "selected.json"));
  const register = ctx.agentResources.register.bind(ctx.agentResources);
  let definition, releaseDealer;
  ctx.agentResources.register = async (definitions) => {
    const release = await register(definitions);
    const dealer = definitions.find((item) => item.id === preset);
    if (dealer) {
      definition = dealer;
      releaseDealer = release;
    }
    return release;
  };
  const calls = { route: [], transport: [] };
  if (!actualBusiness) {
    Business.prototype.status = () => ({
      authenticated: true,
      environment: "test",
      user: { id: "fixture-user" },
    });
    Business.prototype.modelRoute = async (_signal, consumer) => {
      calls.route.push(consumer);
      return {
        agentCode: consumer,
        models: ["fixture-model"],
        names: { "fixture-model": "Fixture" },
        baseUrl: "https://fixture.invalid",
        secret: "fixture-only",
      };
    };
    Business.prototype.fetchExternal = async (url) => {
      calls.transport.push(url);
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"fixture answer"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
  }
  t.after(async () => {
    for (const off of cleanups.reverse()) await off();
    await ctx.agentResources.dispose();
  });
  await apply(ctx, {
    workbenchCapability: { enabled: workbenchEnabled },
    geaBaseUrl: "https://fixture.invalid",
    runtimeDir: root,
    analysisMode: "model",
    analysisSource: "gea",
    analysisAgentCode: "sales_forecast",
    analysisModel: "fixture-model",
    modelRequestTimeoutMs: 1000,
    maxSnapshotBytes: 100000,
    requestTimeoutMs: 1000,
    mcpRequestTimeoutMs: 1000,
    pageSize: 10,
    periodPageSize: 100,
    inputByteBudget: 10000,
  });
  return {
    ctx,
    agent,
    external,
    pages,
    async route(endpoint, payload = {}) {
      const response = await routes.get("/api/gea-proof/" + endpoint)(
        new Request("https://fixture.invalid/api/gea-proof/" + endpoint, {
          method: "POST",
          body: JSON.stringify(payload),
          headers: { "content-type": "application/json" },
        }),
      );
      return response.json();
    },
    async preStep() {
      const payload = { agent, messages: [], signal: new AbortController().signal };
      const run = (handlers.get("agent/pre-step") ?? []).reduceRight(
        (next, handler) => () => handler(payload, next),
        async () => assert.fail("disabled business Task must stop before Core model processing"),
      );
      await run();
    },
    preset,
    calls,
    handlers,
    adapter: adapters.get("gea-analysis"),
    async changeResource(enabled) {
      await releaseDealer();
      if (enabled !== undefined) cleanups.push(await register([{ ...definition, enabled }]));
    },
    async streamThroughCore(preset) {
      agent.session.preset = preset;
      const core = new Context();
      const runtime = new LlmRuntime(core);
      class CapturedDirectProvider extends LlmAdapter {
        async *stream() {
          external.push("direct-model-wire");
          yield { type: "finish", reason: { kind: "stop" } };
        }
      }
      const off = runtime.registerAdapter(["gea-analysis"], new CapturedDirectProvider());
      const detaches = (handlers.get("llm/stream") ?? []).map((handler) =>
        core.on("llm/stream", handler),
      );
      try {
        for await (const _chunk of runtime.stream({
          provider: "gea-analysis",
          sessionId: agent.id,
          model: "fixture-model",
          messages: [],
          signal: new AbortController().signal,
        })) {
        }
      } finally {
        detaches.forEach((detach) => detach());
        off();
      }
    },
    async executeTool(name) {
      const core = new Context();
      core.provide("systemPrompt", { tools: () => () => {} });
      const runtime = new ToolRuntime(core);
      const off = runtime.register(tools.get(name));
      const detach = core.on("tools/execute", handlers.get("tools/execute")[0]);
      try {
        return await runtime.execute({
          name,
          agent,
          callId: "fixture-call",
          arguments: {},
          signal: new AbortController().signal,
        });
      } finally {
        detach();
        off();
      }
    },
    async discover(agentPreset = preset) {
      return (
        await routes.get("/api/gea-proof/model/discover")(
          new Request("https://fixture.invalid/api/gea-proof/model/discover", {
            method: "POST",
            body: JSON.stringify({ agentPreset }),
            headers: { "content-type": "application/json" },
          }),
        )
      ).json();
    },
  };
}

test("disabled installed capability refuses the public model directory before credentials or transport", async (t) => {
  const app = await fixture(t, false);
  const result = await app.discover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, "GEA_AGENT_RESOURCE_DISABLED", JSON.stringify(result));
  assert.deepEqual(app.calls, { route: [], transport: [] });
});

test("hiding an enabled page preserves discovery and the Session Consumer while native fallbacks stay valid", async (t) => {
  const app = await fixture(t, true);
  assert.equal((await app.discover()).ok, true);
  for await (const _chunk of app.adapter.stream({
    sessionId: app.agent.id,
    model: "fixture-model",
    messages: [],
  })) {
  }
  assert.deepEqual(app.calls.route, [
    "dealer-inventory-replenishment",
    "dealer-inventory-replenishment",
  ]);
  assert.equal(app.calls.transport.length, 1);
  app.agent.session.preset = "gea-readonly";
  for await (const _chunk of app.adapter.stream({
    sessionId: app.agent.id,
    model: "fixture-model",
    messages: [],
  })) {
  }
  app.agent.session.preset = "standard";
  for await (const _chunk of app.adapter.stream({
    sessionId: app.agent.id,
    model: "fixture-model",
    messages: [],
  })) {
  }
  assert.deepEqual(app.calls.route.slice(2), ["sales_forecast", "sales_forecast"]);
});

test("current disablement or withdrawal refuses persisted presets even after an earlier directory was available", async (t) => {
  for (const enabled of [false, undefined]) {
    await t.test(enabled === false ? "disabled" : "withdrawn", async (t) => {
      const app = await fixture(t, true);
      assert.equal((await app.discover()).ok, true);
      await app.changeResource(enabled);
      const code = enabled === false ? "GEA_AGENT_RESOURCE_DISABLED" : "GEA_AGENT_RESOURCE_MISSING";
      const discovered = await app.discover();
      assert.equal(discovered.ok, false);
      assert.equal(discovered.error.code, code);
      await assert.rejects(
        async () => {
          for await (const _chunk of app.adapter.stream({
            sessionId: app.agent.id,
            model: "fixture-model",
            messages: [],
          })) {
          }
        },
        (error) => {
          assert.equal(error.code, code);
          return true;
        },
      );
      const tool = await app.executeTool("gea_module_mcp");
      assert.equal(tool.isError, true);
      assert.equal(tool.error.message, code);
      assert.deepEqual(app.calls, {
        route: ["dealer-inventory-replenishment"],
        transport: [],
      });
    });
  }
});

test("a persistent disabled preset refuses the registered GEA model stream before routing", async (t) => {
  const app = await fixture(t, false);
  await assert.rejects(
    async () => {
      for await (const _chunk of app.adapter.stream({
        sessionId: app.agent.id,
        model: "fixture-model",
        messages: [],
      })) {
      }
    },
    (error) => {
      assert.equal(error.code, "GEA_AGENT_RESOURCE_DISABLED");
      return true;
    },
  );
  assert.deepEqual(app.calls, { route: [], transport: [] });
});

test("a persistent disabled preset refuses business tool dispatch before query execution", async (t) => {
  const app = await fixture(t, false);
  const tool = await app.executeTool("gea_cube_query");
  assert.equal(tool.isError, true);
  assert.equal(tool.error.message, "GEA_AGENT_RESOURCE_DISABLED");
  assert.deepEqual(app.calls, { route: [], transport: [] });
});

test("actual Host rejects a restored disabled native Task before any selected provider can run", async (t) => {
  const app = await fixture(t, false, { workbenchEnabled: false, actualBusiness: true });
  app.agent.session.preset = "gea-readonly";
  await assert.rejects(app.preStep(), /GEA_AGENT_RESOURCE_DISABLED/);
  const result = await app.executeTool("gea_cube_query");
  assert.equal(result.isError, true);
  assert.match(result.error.message, /GEA_AGENT_RESOURCE_DISABLED/);
  assert.deepEqual(app.external, []);
});

test("actual registered Host business routes reject disabled execution with zero captured external requests", async (t) => {
  const app = await fixture(t, false, { workbenchEnabled: false, actualBusiness: true });
  for (const endpoint of [
    "workbench/query",
    "workbench/prepare",
    "sales-plan/draft",
    "sales-plan/submit",
    "sales-plan/action",
    "workflow/config",
    "approval/roles",
    "notifications",
    "plans",
    "periods",
    "detail",
    "versions",
    "skus",
    "model/advice",
    "api-log/replay",
  ]) {
    const result = await app.route(endpoint);
    assert.equal(result.ok, false, endpoint + JSON.stringify(result));
    assert.equal(result.error.code, "GEA_CAPABILITY_DISABLED", endpoint + JSON.stringify(result));
  }
  const sql = await app.route("plugin/sql", {
    consumerCode: "dealer-inventory-replenishment",
    sql: "SELECT 1",
  });
  assert.equal(sql.error.code, "GEA_CAPABILITY_DISABLED");
  assert.deepEqual(app.external, []);
});

test("actual mock Host preserves its view and observation while model execution and SQL stay forbidden", async (t) => {
  const app = await fixture(t, true, { mock: true, workbenchEnabled: false, actualBusiness: true });
  await assert.rejects(app.preStep(), /GEA_CAPABILITY_MOCK_ONLY/);
  await assert.rejects(
    async () => {
      for await (const _chunk of app.adapter.stream({
        sessionId: app.agent.id,
        model: "fixture-model",
        messages: [],
      })) {
      }
    },
    (error) => error.code === "GEA_CAPABILITY_MOCK_ONLY",
  );
  const grant = await app.pages.get("inventory-dealer")(
    app.agent.id,
    app.preset,
    new AbortController().signal,
  );
  assert.equal(grant.access.mode, "mock");
  assert.equal(grant.allowsEffect("view"), true);
  for (const effect of ["draft", "submit", "approve"])
    assert.equal(grant.allowsEffect(effect), false);
  grant.observe({});
  await assert.rejects(
    grant.readSql({ sql: "SELECT 1" }, new AbortController().signal),
    /MOCK_DATA_ONLY/,
  );
  assert.equal(grant.workspace, undefined);
  grant.release();
  assert.deepEqual(app.external, []);
});

test("the official LLM stream seam denies a retained direct GEA provider before its wire runs", async (t) => {
  const app = await fixture(t, true, { mock: true, workbenchEnabled: false, actualBusiness: true });
  await assert.rejects(app.streamThroughCore(app.preset), /GEA_CAPABILITY_MOCK_ONLY/);
  await assert.rejects(app.streamThroughCore("gea-readonly"), /GEA_AGENT_RESOURCE_DISABLED/);
  await assert.rejects(app.streamThroughCore("standard"), /GEA_CAPABILITY_DISABLED/);
  assert.deepEqual(app.external, []);
});

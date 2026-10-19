import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BusinessResources } from "dsh-agent-manage/business-resources";
import { Context } from "@deepseek-ai/cordis";
import { ToolRuntime, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { LlmRuntime, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";

// Exercise Host's registered public routes and adapter. No profile, Task or HTTP server starts.
async function fixture(
  t,
  enabled,
  {
    mock = false,
    workbenchEnabled = true,
    actualBusiness = false,
    modelFailure,
    login = false,
    ui = false,
  } = {},
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
    if (login) {
      const path = new URL(String(input)).pathname;
      const result = path.endsWith("/getLoginQrcode")
        ? { qrcodeId: "native-grant-qr" }
        : path.endsWith("/getQrcodeToken")
          ? { success: true, token: "native-grant-token" }
          : path.endsWith("/getUserInfo")
            ? {
                userInfo: {
                  id: "native-user",
                  loginTenantId: "0",
                  realname: "Native fixture",
                },
              }
            : path.endsWith("/getPermCode")
              ? { codeList: [] }
              : path.endsWith("/ai/gateway/agent/session")
                ? {
                    accessDecision: { allowed: true },
                    delegationToken: "native-delegation",
                    gatewayContext: { sessionId: "native-session" },
                  }
                : path.endsWith("/current-user/resolve")
                  ? { success: true, roles: [] }
                  : undefined;
      assert.ok(result, "Unexpected external request: " + path);
      return Response.json({ success: true, result });
    }
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
        "export {apply} from './src/host.ts'; export {Business} from './src/host/business.ts'; export {createRenderUiTool, createValidateDshUiTool} from '../../upstream-inputs/genui/src/plugin/tool.ts';",
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
  const { apply, Business, createRenderUiTool, createValidateDshUiTool } = await import(
    pathToFileURL(output)
  );
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
  if (mock) manifest.mode = "mock";
  else delete manifest.mode;
  await writeFile(join(directory, "plugin.json"), JSON.stringify(manifest));
  const mcpPath = join(directory, "mcp.json");
  const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
  mcp.capabilities = mock ? [] : ["governed-sql-read"];
  await writeFile(mcpPath, JSON.stringify(mcp));
  const pages = new Map();
  const routes = new Map(),
    adapters = new Map(),
    handlers = new Map(),
    tools = new Map(),
    cleanups = [],
    guards = [];
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
    provide(name, value) {
      this[name] = value;
    },
    get(name) {
      return ctx[name];
    },
    skills: {
      registerProvider: () => () => {},
      get: async (name) =>
        name === "inventory-dealer"
          ? {
              name,
              provider: "fixture",
              content: "Dealer fixture rules",
              invocation: { userInvocable: true },
            }
          : undefined,
      list: async () => [
        {
          name: "inventory-dealer",
          invocation: { userInvocable: true },
          provider: "fixture",
        },
      ],
    },
    agentPresets: {
      // This route-only fixture supplies the registry's public declaration document.
      // Actual standard composition and Agent scopes run in the source-profile tests.
      readDocument: async () => ({
        agentPreset: "standard",
        content: JSON.stringify([{ name: "@deepseek-ai/dsh-persona" }]),
      }),
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
      guard: (guard) => {
        guards.push(guard);
        return () => {};
      },
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
  if (ui)
    for (const tool of [createRenderUiTool(), createValidateDshUiTool()])
      tools.set(tool.name, tool);
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
      if (modelFailure) return modelFailure();
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
    toolSchema: (name) => tools.get(name).parameters,
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
      const payload = {
        agent,
        messages: [],
        signal: new AbortController().signal,
      };
      const run = (handlers.get("agent/pre-step") ?? []).reduceRight(
        (next, handler) => () => handler(payload, next),
        async () => assert.fail("disabled business Task must stop before Core model processing"),
      );
      await run();
    },
    preset,
    calls,
    handlers,
    executeRegistered: (name, args, scope = agent.id) =>
      tools.get(name).execute(args, {
        agent: { id: scope, session: agent.session },
        signal: new AbortController().signal,
      }),
    claimQuestion: async (scope, text) => {
      for (const handler of handlers.get("agent/inbox/claimed") ?? [])
        await handler({
          agent: { id: scope },
          message: {
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text }],
          },
        });
    },
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
    async executeTool(name, args = {}) {
      const core = new Context();
      core.provide("systemPrompt", { tools: () => () => {} });
      const runtime = new ToolRuntime(core);
      const definition =
        name === "mcp__gea-gateway__query_business_data"
          ? {
              name,
              description: "Direct Cube-New query",
              parameters: { type: "object" },
              output: {
                schema: { type: "string" },
                render: (_args, value) => [{ type: "text", text: value }],
              },
              execute: (args, exec) =>
                ctx.geaMcp.call(exec.agent.id, "query_business_data", args, exec.signal),
            }
          : tools.get(name);
      const off = runtime.register(definition);
      const guardOffs = guards.map((guard) => runtime.guard(guard));
      const detaches = ["tools/execute", "tools/post-execute"].flatMap((event) =>
        (handlers.get(event) ?? []).map((handler) => core.on(event, handler)),
      );
      try {
        return await runtime.execute({
          name,
          agent,
          callId: "fixture-call",
          arguments: args,
          signal: new AbortController().signal,
        });
      } finally {
        detaches.forEach((detach) => detach());
        guardOffs.forEach((dispose) => dispose());
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
  const initialDiscovery = await app.discover();
  assert.equal(
    initialDiscovery.ok,
    true,
    JSON.stringify({
      initialDiscovery,
      resources: await app.ctx.agentResources.list(),
    }),
  );
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
      const initialDiscovery = await app.discover();
      assert.equal(
        initialDiscovery.ok,
        true,
        JSON.stringify({
          initialDiscovery,
          resources: await app.ctx.agentResources.list(),
        }),
      );
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
      const tool = await app.executeTool("mcp__gea-gateway__query_business_data");
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
  const tool = await app.executeTool("mcp__gea-gateway__query_business_data");
  assert.equal(tool.isError, true);
  assert.equal(tool.error.message, "GEA_AGENT_RESOURCE_DISABLED");
  assert.deepEqual(app.calls, { route: [], transport: [] });
});

test("actual Host rejects a restored disabled native Task before any selected provider can run", async (t) => {
  const app = await fixture(t, false, {
    workbenchEnabled: false,
    actualBusiness: true,
  });
  app.agent.session.preset = "gea-readonly";
  await assert.rejects(app.preStep(), /GEA_AGENT_RESOURCE_DISABLED/);
  const result = await app.executeTool("mcp__gea-gateway__query_business_data");
  assert.equal(result.isError, true);
  assert.match(result.error.message, /GEA_AGENT_RESOURCE_DISABLED/);
  assert.deepEqual(app.external, []);
});

test("actual registered Host business routes reject disabled execution with zero captured external requests", async (t) => {
  const app = await fixture(t, false, {
    workbenchEnabled: false,
    actualBusiness: true,
  });
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
  ]) {
    const result = await app.route(endpoint);
    assert.equal(result.ok, false, endpoint + JSON.stringify(result));
    assert.equal(result.error.code, "GEA_CAPABILITY_DISABLED", endpoint + JSON.stringify(result));
  }
  const replay = await app.route("api-log/replay");
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.value, {
    outcome: "rejected",
    recordId: null,
    reason: "GEA_CAPABILITY_DISABLED",
  });
  const batch = await app.route("api-log/batch/start");
  assert.equal(batch.ok, false);
  assert.equal(batch.error.code, "GEA_CAPABILITY_DISABLED");
  const sql = await app.route("plugin/sql", {
    consumerCode: "dealer-inventory-replenishment",
    sql: "SELECT 1",
  });
  assert.equal(sql.error.code, "GEA_CAPABILITY_DISABLED");
  assert.deepEqual(app.external, []);
});

test("actual mock Host preserves its view and observation while model execution and SQL stay forbidden", async (t) => {
  const app = await fixture(t, true, {
    mock: true,
    workbenchEnabled: false,
    actualBusiness: true,
  });
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
  const app = await fixture(t, true, {
    mock: true,
    workbenchEnabled: false,
    actualBusiness: true,
  });
  await assert.rejects(app.streamThroughCore(app.preset), /GEA_CAPABILITY_MOCK_ONLY/);
  await assert.rejects(app.streamThroughCore("gea-readonly"), /GEA_AGENT_RESOURCE_DISABLED/);
  await assert.rejects(app.streamThroughCore("standard"), /GEA_CAPABILITY_DISABLED/);
  assert.deepEqual(app.external, []);
});

test("model/advice shares the adapter idle lifetime without an outer total deadline", async (t) => {
  let writer;
  let closed = false;
  const encoder = new TextEncoder();
  const app = await fixture(t, true, {
    modelFailure: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            writer = controller;
          },
          cancel() {
            closed = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  app.ctx.llm.stream = (options) => app.adapter.stream(options);
  const result = app.route("model/advice", { question: "fixture" });
  const heartbeat = setInterval(() => {
    if (writer && !closed) writer.enqueue(encoder.encode(": keepalive\n\n"));
  }, 150);
  t.after(() => clearInterval(heartbeat));
  await new Promise((done) => setTimeout(done, 1400));
  if (!closed)
    writer.enqueue(
      encoder.encode(
        'data: {"choices":[{"index":0,"delta":{"content":"fixture answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
  const reply = await result;
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.value.answer, "fixture answer");
  assert.equal(closed, true);
});

test("the registered GEA model adapter preserves a chat 403 without treating it as a network outage", async (t) => {
  const app = await fixture(t, true, {
    modelFailure: () =>
      Response.json(
        {
          error: { code: "permission_denied", message: "请求的Agent无权访问" },
        },
        { status: 403 },
      ),
  });
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
      assert.equal(error.code, "GEA_MODEL_HTTP_403");
      assert.match(error.message, /permission_denied/);
      assert.match(error.message, /请求的Agent无权访问/);
      assert.doesNotMatch(error.message, /网络.*抖动|重问一次|代理/);
      return true;
    },
  );
  assert.equal(app.calls.transport.length, 1);
});

test("the registered GEA model adapter translates connection and stream failures at its actual outlet", async (t) => {
  for (const stage of ["connection", "stream"])
    await t.test(stage, async (t) => {
      const failure = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("reset"), {
          code: "ECONNRESET",
          hostname: "localhost",
        }),
      });
      const app = await fixture(t, true, {
        modelFailure: () => {
          if (stage === "connection") throw failure;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
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
          assert.equal(error.code, "GEA_NETWORK_FAILED");
          assert.match(error.message, /ECONNRESET/);
          if (stage === "stream") assert.match(error.message, /流式读取/);
          return true;
        },
      );
      assert.equal(app.calls.transport.length, 1);
    });
});

test("the actual Native Host grant binds and withdraws its current page projection", async (t) => {
  const app = await fixture(t, true, {
    actualBusiness: true,
    login: true,
    mock: true,
  });
  app.agent.session.preset = "gea-readonly";
  const qr = await app.route("login/start");
  assert.equal(qr.ok, true, JSON.stringify(qr));
  const logged = await app.route("login/poll", { loginId: qr.value.loginId });
  assert.equal(logged.ok, true, JSON.stringify(logged));
  const bound = async () => JSON.parse(await app.executeRegistered("gea_runtime_diagnose", {}));
  assert.equal((await bound()).pageBound, false);
  const acquire = () =>
    app.pages.get("gea-proof")(app.agent.id, "gea-readonly", new AbortController().signal);
  const grant = await acquire();
  assert.equal(
    (await bound()).pageBound,
    true,
    "a valid Native grant must reach the current page guard",
  );
  const context = JSON.parse(await app.executeRegistered("gea_visible_workbench_context", {}));
  assert.equal(context.availability, "in-workbench-no-snapshot");
  assert.equal(context.currentPage.tool, "gea_workbench_apply");
  assert.doesNotMatch(context.reason, /gea_page|HTML/);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 90_001);
  assert.equal((await bound()).pageBound, false, "idle projection expires");
  const contextSnapshot = {
    format: "gea-workbench-visible-v1",
    sequence: 1,
    view: "regional-approval",
    scope: {
      month: "2026-10",
      planType: "Y",
      approvalStage: "province",
      dimension: "customer",
    },
    visibleRows: [],
    selectedPlanIds: [],
    pagination: { page: 1, pageSize: 20, total: 0 },
    evidence: {
      source: "gea-user-session",
      completeness: "paged-queue",
      queryState: "success",
      dataVersion: "sales-plan-v1.11",
    },
  };
  grant.observe(contextSnapshot);
  assert.equal((await bound()).pageBound, true, "active owner refreshes its page projection");
  assert.equal(grant.snapshot().sequence, 1);
  t.mock.restoreAll();
  const replacement = await acquire();
  assert.throws(() => grant.observe(contextSnapshot), /PAGE_OWNER_RELEASED/);
  grant.release();
  assert.equal((await bound()).pageBound, true, "old release cannot clear the new owner");
  replacement.observe({ ...contextSnapshot, sequence: 2 });
  assert.equal(replacement.snapshot().sequence, 2);
  replacement.release();
  assert.equal((await bound()).pageBound, false);
  assert.equal(replacement.snapshot(), undefined);
  const previousPage = await acquire();
  app.agent.session.preset = app.preset;
  const html = await app.pages.get("inventory-dealer")(
    app.agent.id,
    app.preset,
    new AbortController().signal,
  );
  assert.throws(() => previousPage.observe(contextSnapshot), /PAGE_OWNER_RELEASED/);
  previousPage.release();
  assert.equal((await bound()).pageBound, true, "old Native release preserves the new HTML grant");
  html.release();
  assert.equal((await bound()).pageBound, false);
  app.agent.session.preset = "gea-readonly";
  const revoked = await acquire();
  const loggedOut = await app.route("logout");
  assert.equal(loggedOut.ok, true, JSON.stringify(loggedOut));
  assert.equal(revoked.signal.aborted, true);
  assert.throws(() => revoked.observe(contextSnapshot), /abort/i);
  revoked.release();
  assert.equal((await bound()).pageBound, false);
});

for (const entry of ["RPC", "HTML"])
  test(`actual ${entry} SQL reads recover from repeated failures across Session and login changes`, async (t) => {
    const app = await fixture(t, true, { actualBusiness: true, login: true });
    const login = async () => {
      const qr = await app.route("login/start");
      assert.equal(qr.ok, true, JSON.stringify(qr));
      const result = await app.route("login/poll", { loginId: qr.value.loginId });
      assert.equal(result.ok, true, JSON.stringify(result));
    };
    await login();
    const loginFetch = globalThis.fetch;
    let failing = true;
    let reads = 0;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const path = new URL(String(input)).pathname;
      init.signal.throwIfAborted();
      if (path.endsWith("/ai/gateway/session")) {
        const wire = JSON.parse(init.body);
        return Response.json({
          success: true,
          result: {
            accessDecision: { allowed: true },
            delegationToken: "sql-page-delegation",
            gatewayContext: { ...wire, sessionId: "sql-page-session" },
          },
        });
      }
      if (!path.endsWith("/ai/gateway/sql/execute")) return loginFetch(input, init);
      reads++;
      return failing
        ? Response.json(
            { success: false, code: "SQL_UNAVAILABLE", message: "temporary failure" },
            { status: 503 },
          )
        : Response.json({ success: true, result: { rows: [{ sku: "fresh" }], total: 1 } });
    });
    const query = { sql: "SELECT sku FROM inventory ORDER BY sku", pageNo: 1, pageSize: 1 };
    let grant;
    const open = async () => {
      grant = await app.pages.get("inventory-dealer")(
        app.agent.id,
        app.preset,
        new AbortController().signal,
      );
    };
    const configuredQuery = {
      queryId: "dealer.customers",
      parameters: { search_pattern: null, customer: null, page_size: 10, offset: 0 },
    };
    if (entry === "HTML") {
      await open();
      const rejected = await grant.readSql(query, new AbortController().signal);
      assert.equal(rejected.success, false);
      assert.equal(rejected.errorCode, "INVALID_CONFIGURED_QUERY");
      assert.equal(reads, 0, "raw page SQL never reaches the gateway");
    }
    const read = async () => {
      if (entry === "HTML") {
        const result = await grant.readSql(configuredQuery, new AbortController().signal);
        if (result.success === false)
          throw Object.assign(Error(result.message), { code: result.errorCode });
        assert.match(result.configVersion, /^[a-f0-9]{64}$/);
        return result;
      }
      const result = await app.route("plugin/sql", {
        consumerCode: "dealer-inventory-replenishment",
        ...query,
      });
      if (!result.ok) throw Object.assign(Error(result.error.message), result.error);
      return result.value;
    };
    for (let i = 0; i < 4; i++)
      await assert.rejects(read(), /503|SQL_UNAVAILABLE|temporary failure/);
    assert.equal(reads, 4);
    failing = false;
    assert.deepEqual((await read()).rows, [{ sku: "fresh" }]);
    failing = true;
    for (let i = 0; i < 3; i++)
      await assert.rejects(read(), /503|SQL_UNAVAILABLE|temporary failure/);
    app.agent.id = "session-22222222-2222-4222-8222-222222222222";
    if (entry === "HTML") {
      grant.release();
      await open();
    }
    failing = false;
    assert.deepEqual((await read()).rows, [{ sku: "fresh" }]);
    failing = true;
    for (let i = 0; i < 3; i++)
      await assert.rejects(read(), /503|SQL_UNAVAILABLE|temporary failure/);
    await app.route("logout");
    if (entry === "HTML") {
      assert.equal(grant.signal.aborted, true);
      grant.release();
    }
    await login();
    app.agent.id = "session-33333333-3333-4333-8333-333333333333";
    if (entry === "HTML") await open();
    failing = false;
    assert.deepEqual((await read()).rows, [{ sku: "fresh" }]);
    assert.equal(reads, 13);
    grant?.release();
  });

test("registered online detail reads execute beyond twenty calls", async (t) => {
  const app = await fixture(t, true, { actualBusiness: true, login: true });
  app.agent.session.preset = "gea-readonly";
  const qr = await app.route("login/start");
  await app.route("login/poll", { loginId: qr.value.loginId });
  const loginFetch = globalThis.fetch;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!/\/sales-plan\/plans\/p-\d+$/.test(path)) return loginFetch(input, init);
    reads++;
    const planId = path.split("/").at(-1);
    return Response.json({
      success: true,
      result: {
        planId,
        currentVersion: { id: "v-" + reads, planId },
        skus: [],
        versions: [],
        logs: [],
      },
    });
  });
  for (let n = 1; n <= 21; n++) {
    const result = JSON.parse(
      await app.executeRegistered("gea_sales_plan_read", {
        kind: "detail",
        query: { planId: "p-" + n },
      }),
    );
    assert.equal(result.value?.planId, "p-" + n, JSON.stringify(result));
    assert.equal(result.coverage, "partial");
  }
  assert.equal(reads, 21);
});

test("registered aggregate reads refresh the same query beyond eight calls", async (t) => {
  const app = await fixture(t, true, { actualBusiness: true, login: true });
  app.agent.session.preset = "gea-readonly";
  const qr = await app.route("login/start");
  await app.route("login/poll", { loginId: qr.value.loginId });
  const loginFetch = globalThis.fetch;
  let amount = "1.25";
  let scans = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/sales-plan/plans")) {
      scans++;
      return Response.json({
        success: true,
        result: {
          records: [
            {
              planId: "p",
              versionId: "v",
              periodId: "20261001",
              orderType: "M",
              planTypeCode: "Y",
              skuCount: 1,
            },
          ],
          total: 1,
          current: 1,
          size: 200,
        },
      });
    }
    if (path.endsWith("/sales-plan/plans/versions/v/skus"))
      return Response.json({
        success: true,
        result: [{ versionId: "v", skuCode: "s", amt: amount, qty: "2" }],
      });
    return loginFetch(input, init);
  });
  for (let n = 1; n <= 9; n++) {
    amount = n === 9 ? "9007199254740993.125" : String(n) + ".25";
    const result = JSON.parse(
      await app.executeRegistered("gea_sales_plan_read", {
        kind: "aggregate",
        query: { periodId: "20261001" },
      }),
    );
    assert.equal(result.value?.totals[0].amt, amount, JSON.stringify(result));
    assert.equal(result.coverage, "complete");
  }
  assert.equal(scans, 18);
});

test("authorized page reads return current content after missing snapshots, new questions and repeated focus", async (t) => {
  const app = await fixture(t, true, { actualBusiness: true, login: true, mock: true });
  app.agent.session.preset = "gea-readonly";
  const qr = await app.route("login/start");
  await app.route("login/poll", { loginId: qr.value.loginId });
  const read = async () =>
    JSON.parse(await app.executeRegistered("gea_visible_workbench_context", { focus: "qty" }));
  assert.equal((await read()).coverage, "none");
  const grant = await app.pages.get("gea-proof")(
    app.agent.id,
    "gea-readonly",
    new AbortController().signal,
  );
  assert.equal((await read()).availability, "in-workbench-no-snapshot");
  grant.observe({
    format: "gea-workbench-visible-v1",
    sequence: 1,
    view: "regional-approval",
    scope: { month: "2026-10", planType: "Y", approvalStage: "province", dimension: "customer" },
    visibleRows: [{ planId: "p-page", qty: "-5.125" }],
    selectedPlanIds: [],
    pagination: { page: 1, pageSize: 20, total: 10 },
    evidence: {
      source: "gea-user-session",
      completeness: "paged-queue",
      queryState: "success",
      dataVersion: "sales-plan-v1.11",
    },
  });
  await app.claimQuestion(app.agent.id, "What is the quantity?");
  const first = await read();
  assert.match(JSON.stringify(first.context), /-5.125/);
  assert.equal(first.coverage, "current-visible-page");
  for (let n = 0; n < 3; n++) assert.deepEqual(await read(), first);
  await app.claimQuestion(app.agent.id, "请核对数量");
  assert.deepEqual(await read(), first);
  grant.release();
  assert.equal((await read()).coverage, "none");
  assert.throws(() => grant.observe({ sequence: 2 }), /PAGE_OWNER_RELEASED/);
});

test("actual UI tools accept signed values, delta and totals under the business guard", async (t) => {
  const app = await fixture(t, true, { actualBusiness: true, login: true, ui: true });
  const qr = await app.route("login/start");
  await app.route("login/poll", { loginId: qr.value.loginId });
  const spec = {
    items: [
      {
        type: "table",
        columns: ["差额"],
        rows: [["-5"], ["+10"], ["−10"]],
        types: ["delta"],
        total: true,
      },
      { type: "stat", label: "差额", value: "-5", delta: "+10" },
      { type: "hero", title: "数量", value: "-5", delta: "−10" },
    ],
  };
  for (const name of ["render_ui", "validate_dsh_ui"]) {
    const result = await app.executeTool(name, { spec });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /status=(rendered|valid)/);
    const invalid = await app.executeTool(name, { spec: 123 });
    assert.match(JSON.stringify(invalid.content), /status=invalid/);
    assert.ok(validateJsonSchemaValue(app.toolSchema(name), { spec: 123 }).length > 0);
    assert.doesNotMatch(JSON.stringify(invalid), /GEA_UI_BUSINESS_SEMANTICS/);
  }
});

test("repeated registered reads recover from failure and keep full current partial results", async (t) => {
  const app = await fixture(t, true, { actualBusiness: true, login: true });
  app.agent.session.preset = "gea-readonly";
  const qr = await app.route("login/start");
  await app.route("login/poll", { loginId: qr.value.loginId });
  const loginFetch = globalThis.fetch;
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!path.endsWith("/sales-plan/plans")) return loginFetch(input, init);
    reads++;
    return reads === 1
      ? Response.json({ success: false, message: "temporary read failure" }, { status: 503 })
      : Response.json({
          success: true,
          result: {
            records: [
              { planId: "p", note: "x".repeat(8500), current: reads, tail: "CURRENT_EVIDENCE_END" },
            ],
            total: 2,
            current: 1,
            size: 1,
          },
        });
  });
  const args = { kind: "list", query: { pageNo: 1, pageSize: 1 } };
  await assert.rejects(app.executeRegistered("gea_sales_plan_read", args), /503/);
  for (let n = 2; n <= 12; n++) {
    const result = JSON.parse(await app.executeRegistered("gea_sales_plan_read", args));
    assert.equal(result.value.records[0].current, n);
    assert.equal(result.value.records[0].note.length, 8500);
    assert.equal(result.value.records[0].tail, "CURRENT_EVIDENCE_END");
    assert.equal(result.coverage, "partial");
    assert.equal(result.value.total, 2);
  }
  assert.equal(reads, 12);
});

test("explicit page rereads restore content after official Session tool-result pruning", async (t) => {
  const { Session, SessionId } = await import("@deepseek-ai/dsh-session");
  const { createToolResultMessage, ToolCallId } = await import("@deepseek-ai/dsh-llm");
  const { default: SessionProjectionRegistry } = await import(
    pathToFileURL(
      resolve("../../official-latest-standard/packages/session/session-projection/lib/index.js"),
    )
  );
  const { default: TokenMeter } = await import(
    pathToFileURL(resolve("../../official-latest-standard/packages/llm/token-meter/lib/index.js"))
  );
  const { default: ToolResultPruner } = await import(
    pathToFileURL(
      resolve(
        "../../official-latest-standard/packages/compaction/compaction-tool-result-pruner/lib/index.js",
      ),
    )
  );
  const app = await fixture(t, true, { actualBusiness: true, login: true, mock: true });
  app.agent.session.preset = "gea-readonly";
  const qr = await app.route("login/start");
  await app.route("login/poll", { loginId: qr.value.loginId });
  const grant = await app.pages.get("gea-proof")(
    app.agent.id,
    "gea-readonly",
    new AbortController().signal,
  );
  grant.observe({
    format: "gea-workbench-visible-v1",
    sequence: 1,
    view: "regional-approval",
    scope: { month: "2026-10", planType: "Y", approvalStage: "province", dimension: "customer" },
    visibleRows: Array.from({ length: 20 }, (_, n) => ({
      planId: "p-" + n,
      note: n === 10 ? "PAGE_MIDDLE_EVIDENCE" : "x".repeat(500),
    })),
    selectedPlanIds: [],
    pagination: { page: 1, pageSize: 20, total: 20 },
    evidence: {
      source: "gea-user-session",
      completeness: "paged-queue",
      queryState: "success",
      dataVersion: "sales-plan-v1.11",
    },
  });
  const first = await app.executeTool("gea_visible_workbench_context");
  assert.equal(first.isError, false, JSON.stringify(first));
  assert.match(first.value, /PAGE_MIDDLE_EVIDENCE/);
  const session = Session.create(SessionId("page-prune-session"));
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId("page-read"),
        content: first.content,
        isError: false,
      }),
    },
    { surfaceOp: "append" },
  );
  const core = new Context();
  new SessionProjectionRegistry(core);
  new TokenMeter(core);
  const pruner = new ToolResultPruner(core, {
    thresholdChars: 1000,
    headChars: 500,
    tailChars: 200,
  });
  assert.equal(pruner.pruneSession(session).pruned.length, 1);
  assert.ok(session.snapshotEvents().some((event) => event.type === "compaction/prune"));
  assert.match(JSON.stringify(session.deriveMessages()), /tool result middle pruned/);
  const reread = await app.executeTool("gea_visible_workbench_context");
  assert.equal(reread.isError, false, JSON.stringify(reread));
  assert.equal(reread.value, first.value);
  const projected = JSON.parse(reread.content[0].text);
  assert.equal(projected.projection, "reference");
  let offset = 0,
    restored = "";
  while (offset !== null) {
    const result = await app.executeTool("gea_evidence_read", {
      evidenceId: projected.evidenceId,
      format: "raw",
      offset,
      limit: 4000,
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    const part = JSON.parse(result.value);
    restored += part.content;
    offset = part.nextOffset;
  }
  assert.equal(restored, first.value);
  assert.match(restored, /PAGE_MIDDLE_EVIDENCE/);
  grant.release();
});

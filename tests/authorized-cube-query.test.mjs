import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
const built = await build({
  stdin: {
    contents:
      "export {prepareGatewayMcp} from './src/host/gateway-mcp.ts';export {planCubeQuery} from './src/host/cube-query-plan.ts';export {Business} from './src/host/business.ts';export {registerGeaTools} from './src/host/agent-tools.ts';export {resourceConsumers} from './src/host/catalog-consumers.ts';export {installPromptProfile} from './src/host/prompt-policy.ts'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { prepareGatewayMcp, planCubeQuery, Business, registerGeaTools, resourceConsumers } =
  mod.exports;
const resource = (model, extra = {}) => ({
  capabilityCode: "MCP_TOOL:cube:query_business_data",
  resourceCode: model + "-cube",
  resourceName: model,
  resourceType: "EXTERNAL_MCP",
  queryTarget: model,
  version: "1",
  maxRows: 200,
  maxBytes: 262144,
  ...extra,
});
const snapshot = (models = ["inv", "ship"]) => ({
  resources: models.map((x) => resource(x)),
  fetchedAt: "now",
});
const query = (model, name = model) => ({
  name,
  query: { measures: [model + ".row_count"], limit: 3 },
});

test("resource discovery uses the negotiated route and trusted session, handles audit failure and 429 without fallback", async () => {
  let response = { success: true, resources: [resource("inv")] };
  let rate = false;
  const calls = [];
  const consumer = { consumerType: "AGENT", consumerCode: "sales_forecast" };
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith("/session"))
      return Response.json({
        success: true,
        result: {
          accessDecision: { allowed: true },
          gatewayContext: { ...consumer, sessionId: "session", conversationId: "conversation" },
          delegationToken: "fixture-secret",
        },
      });
    if (url.endsWith("/resources"))
      return rate
        ? new Response("", { status: 429, headers: { "Retry-After": "12" } })
        : Response.json(response);
    return Response.json({
      id: 1,
      result: { tools: [{ name: "query_business_data", _meta: { sourceCode: "cube" } }] },
    });
  };
  const signal = new AbortController().signal;
  const t = await prepareGatewayMcp(
    "https://fixture",
    { token: "login-secret", tenantId: "0" },
    consumer,
    signal,
    1000,
    fake,
  );
  await assert.rejects(t.authorizedResources("query_business_data", signal), /ROUTE_REQUIRED/);
  await t.fetch(t.url, { method: "POST", body: JSON.stringify({ id: 1, method: "tools/list" }) });
  const result = await t.authorizedResources("query_business_data", signal);
  assert.equal(result.resources.length, 1);
  const sent = calls.at(-1);
  assert.deepEqual(sent.body, {
    sessionId: "session",
    conversationId: "conversation",
    delegationToken: "fixture-secret",
    agentCode: "sales_forecast",
    mcpCode: "cube",
    toolName: "query_business_data",
  });
  assert.doesNotMatch(sent.url, /fixture-secret|login-secret/);
  assert.equal(new Headers(sent.headers).has("X-Access-Token"), false);
  response = {
    success: false,
    code: "AI_GATEWAY_AUDIT_UNAVAILABLE",
    resources: [resource("hidden")],
  };
  await assert.rejects(
    t.authorizedResources("query_business_data", signal),
    (e) => /AUDIT_UNAVAILABLE/.test(e.message) && !e.message.includes("hidden"),
  );
  response = {
    success: false,
    code: "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
    category: "SESSION",
    resources: [resource("hidden")],
  };
  await assert.rejects(
    t.authorizedResources("query_business_data", signal),
    (e) => e.code === "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED" && !e.message.includes("hidden"),
  );
  response = { success: true, resources: [resource("inv", { maxRows: -1 })] };
  await assert.rejects(t.authorizedResources("query_business_data", signal), /INVALID_LIMIT/);
  response = { success: true, resources: [resource("inv", { version: "" })] };
  await assert.rejects(t.authorizedResources("query_business_data", signal), /INVALID_RESOURCE/);
  response = {
    success: true,
    resources: [resource("inv", { capabilityCode: "MCP_TOOL:other:query_business_data" })],
  };
  await assert.rejects(t.authorizedResources("query_business_data", signal), /INVALID_RESOURCE/);
  rate = true;
  await assert.rejects(
    t.authorizedResources("query_business_data", signal),
    (e) => e.retryAfterMs === 12000,
  );
  assert.equal(calls.filter((x) => x.url.endsWith("/resources")).length, 7);
});

test("planner separates independent models, rejects internal joins and ambiguous or unauthorized targets, and enforces resource bounds", () => {
  let plan = planCubeQuery({ action: "query", queries: [query("inv"), query("ship")] }, snapshot());
  assert.equal(plan.groups.length, 2);
  assert.deepEqual(
    plan.groups.map((x) => x.names),
    [["inv"], ["ship"]],
  );
  plan = planCubeQuery(
    {
      action: "query",
      queries: [
        { name: "join", query: { dimensions: ["inv.id"], measures: ["ship.row_count"] } },
        query("inv"),
      ],
    },
    snapshot(),
  );
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.groups.length, 1);
  assert.equal(
    planCubeQuery({ action: "query", queries: [query("hidden")] }, snapshot()).rejected[0].code,
    "GEA_RESOURCE_NOT_AUTHORIZED",
  );
  assert.equal(
    planCubeQuery(
      { action: "query", queries: [query("inv")] },
      {
        resources: [resource("inv"), resource("inv", { resourceCode: "duplicate" })],
        fetchedAt: "now",
      },
    ).rejected[0].code,
    "GEA_RESOURCE_AMBIGUOUS",
  );
  assert.equal(
    planCubeQuery(
      { action: "query", queries: [query("inv")] },
      { resources: [resource("inv", { maxRows: 2 })], fetchedAt: "now" },
    ).rejected[0].code,
    "GEA_RESOURCE_ROW_LIMIT",
  );
  plan = planCubeQuery(
    { action: "query", queries: [{ name: "default", query: { measures: ["inv.row_count"] } }] },
    { resources: [resource("inv", { maxRows: null, maxBytes: null })], fetchedAt: "now" },
  );
  assert.equal(plan.groups[0].parameters.queries[0].query.limit, 50);
  assert.throws(
    () =>
      planCubeQuery(
        { action: "query", queries: [query("inv", "same"), query("ship", "same")] },
        snapshot(),
      ),
    /重复/,
  );
  const a = resourceConsumers(snapshot(["inv"]), "one"),
    b = resourceConsumers(snapshot(["ship"]), "two");
  assert.equal(a.get("inv"), "one");
  assert.equal(b.has("inv"), false);
});

function fixture(t, capability) {
  const business = new Business({
    geaBaseUrl: "https://fixture",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 1000,
  });
  t.after(() => business.dispose());
  const tools = new Map();
  const profiles = new Map([["one", "gea-readonly"]]);
  if (capability) {
    for (const {
      data: { consumerCode },
    } of capability.readModules()) {
      const preset = "cube-fixture-" + consumerCode;
      const dispose = mod.exports.installPromptProfile(preset, {
        label: consumerCode,
        consumerCode,
        skills: [],
      });
      t.after(dispose);
      profiles.set("agent-" + consumerCode, preset);
    }
  }
  registerGeaTools(
    {
      effect: (f) => f(),
      tools: {
        register: (x) => {
          tools.set(x.name, x);
          return () => {};
        },
      },
      agents: { get: (id) => (profiles.has(id) ? { session: { fixtureId: id } } : undefined) },
      sessionProjections: {
        stateOf: (session, key) =>
          key === "agentPreset" ? profiles.get(session.fixtureId) : undefined,
      },
      agentResources: {
        list: async () =>
          [...profiles.values()].map((id) => ({
            id,
            kind: "prompt",
            installed: true,
            enabled: true,
          })),
      },
    },
    business,
    capability,
  );
  return {
    business,
    tools,
    select: (preset) => profiles.set("one", preset),
    call: (name, args, signal = new AbortController().signal, agentId = "one") =>
      tools.get(name).execute(args, { agent: { id: agentId }, signal }),
  };
}

test("typed and legacy entry share splitting, receipts and authorization refresh; failed group does not erase success", async (t) => {
  const f = fixture(t);
  let authorized = ["inv", "ship"];
  const sent = [];
  t.mock.method(f.business, "moduleMcp", async () => ({
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => snapshot(authorized),
    call: async (_name, args) => {
      if (args.action === "inspect") return "{}";
      sent.push(args);
      if (args.queries[0].name === "ship") throw Error("fixture upstream failure");
      return JSON.stringify({
        datasets: args.queries.map((q) => ({ name: q.name, rows: [{ "inv.row_count": 42 }] })),
      });
    },
  }));
  const result = JSON.parse(
    await f.call("gea_cube_query", {
      consumerCode: "sales_forecast",
      queries: [query("inv"), query("ship")],
    }),
  );
  assert.deepEqual(
    result.results.map((x) => x.status),
    ["returned", "failed"],
  );
  assert.equal(sent.length, 2);
  assert.match(JSON.stringify(result.availableEvidence), /42/);
  assert.equal(f.business.pendingMcpQueries("one").length, 1);
  authorized = [];
  const denied = JSON.parse(
    await f.call("gea_module_mcp", {
      consumerCode: "sales_forecast",
      tool: "query_business_data",
      arguments: { action: "query", queries: [query("inv")] },
    }),
  );
  assert.equal(denied.results[0].code, "GEA_RESOURCE_NOT_AUTHORIZED");
  assert.equal(sent.length, 2);
  const schema = f.tools.get("gea_cube_query").parameters;
  assert.ok(
    schema.properties.queries.items.properties.query.properties.order.items.properties.direction.enum.includes(
      "desc",
    ),
  );
});

test("catalog shows only the current authorization snapshot and never revives old inspect results after revocation", async (t) => {
  const f = fixture(t);
  let allowed = ["inv"];
  let inspect = 0;
  const module = {
    tools: () => [],
    authorizedResources: async () => snapshot(allowed),
    call: async () => {
      inspect++;
      return JSON.stringify({
        semanticModel: [
          { name: "inv", measures: [{ name: "inv.row_count" }] },
          { name: "hidden", measures: [{ name: "hidden.row_count" }] },
        ],
      });
    },
  };
  t.mock.method(f.business, "moduleMcp", async () => module);
  const first = await f.call("gea_gateway_catalog", {});
  assert.match(first, /inv/);
  assert.doesNotMatch(first, /hidden/);
  allowed = [];
  const empty = JSON.parse(await f.call("gea_gateway_catalog", {}));
  assert.equal(empty.availability, "no-authorized-resources");
  assert.equal(inspect, 1);
  module.authorizedResources = async () => {
    throw Error("AI_GATEWAY_AUDIT_UNAVAILABLE");
  };
  await assert.rejects(f.call("gea_gateway_catalog", {}), /AUDIT_UNAVAILABLE/);
  assert.equal(inspect, 1);
});

test("Cube-New catalog calls the separate inspection tool and filters metadata by the current resource grant", async (t) => {
  const f = fixture(t);
  const calls = [];
  const module = {
    tools: () => [{ name: "inspect_cube_model" }, { name: "query_business_data" }],
    authorizedResources: async () => snapshot(["inv"]),
    call: async (name, args) => {
      calls.push({ name, args });
      return JSON.stringify({
        action: "inspect",
        semanticModel: [
          { name: "inv", measures: [{ name: "inv.row_count" }] },
          { name: "hidden", measures: [{ name: "hidden.row_count" }] },
        ],
      });
    },
  };
  t.mock.method(f.business, "moduleMcp", async () => module);
  const catalog = await f.call("gea_gateway_catalog", {});
  assert.match(catalog, /inv/);
  assert.doesNotMatch(catalog, /hidden/);
  assert.deepEqual(calls, [{ name: "inspect_cube_model", args: { limit: 50 } }]);
});

test("cancellation stops subsequent model groups", async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  let sent = 0;
  t.mock.method(f.business, "moduleMcp", async () => ({
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => snapshot(),
    call: async (_name, args) => {
      if (args.action === "inspect") return "{}";
      sent++;
      controller.abort();
      return "{}";
    },
  }));
  await assert.rejects(
    f.call(
      "gea_cube_query",
      { consumerCode: "sales_forecast", queries: [query("inv"), query("ship")] },
      controller.signal,
    ),
  );
  assert.equal(sent, 1);
});

test("legacy inspect is filtered and authorization failure occurs before public metadata access", async (t) => {
  const f = fixture(t);
  let reads = 0;
  let fail = false;
  t.mock.method(f.business, "moduleMcp", async () => ({
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => {
      if (fail) throw Error("DISCOVERY_DOWN");
      return snapshot(["inv"]);
    },
    call: async () => {
      reads++;
      return JSON.stringify({ semanticModel: [{ name: "inv" }, { name: "hidden" }] });
    },
  }));
  const x = await f.call("gea_module_mcp", {
    consumerCode: "sales_forecast",
    tool: "query_business_data",
    arguments: { action: "inspect", queries: [] },
  });
  assert.match(x, /inv/);
  assert.doesNotMatch(x, /hidden/);
  fail = true;
  await assert.rejects(
    f.call("gea_cube_query", { consumerCode: "sales_forecast", queries: [query("inv")] }),
    /DISCOVERY_DOWN/,
  );
  assert.equal(reads, 1);
});

test("two Agent catalogs in one host do not share authorization or metadata", async (t) => {
  const f = fixture(t, {
    readModules: () => ["one", "two"].map((consumerCode) => ({ data: { consumerCode } })),
    readToolIndex: () => "",
    byConsumer: () => undefined,
  });
  t.mock.method(f.business, "moduleMcp", async (consumer) => ({
    tools: () => [],
    authorizedResources: async () => snapshot(consumer === "one" ? ["inv"] : ["ship"]),
    call: async () =>
      JSON.stringify({
        semanticModel: [
          { name: "inv", measures: [{ name: "inv.row_count" }] },
          { name: "ship", measures: [{ name: "ship.row_count" }] },
        ],
      }),
  }));
  const a = await f.call("gea_gateway_catalog", { consumerCode: "one" }, undefined, "agent-one"),
    b = await f.call("gea_gateway_catalog", { consumerCode: "two" }, undefined, "agent-two");
  assert.match(a, /inv/);
  assert.doesNotMatch(a, /ship/);
  assert.match(b, /ship/);
  assert.doesNotMatch(b, /inv/);
});

test("expired gateway session stops every read entry for this turn and never falls back to inspect", async (t) => {
  const f = fixture(t);
  let opened = 0,
    inspects = 0;
  t.mock.method(f.business, "moduleMcp", async () => {
    opened++;
    return {
      tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
      authorizedResources: async () => {
        throw Object.assign(Error("AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED"), {
          code: "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
          category: "SESSION",
        });
      },
      call: async () => {
        inspects++;
        return "{}";
      },
    };
  });
  await assert.rejects(
    f.call("gea_gateway_catalog", { consumerCode: "sales_forecast" }),
    /GEA_GATEWAY_SESSION_EXPIRED/,
  );
  const stopped = JSON.parse(
    await f.call("gea_module_mcp", {
      consumerCode: "sales_forecast",
      tool: "query_business_data",
      arguments: { action: "inspect", queries: [] },
    }),
  );
  assert.equal(stopped.availability, "turn-stopped");
  assert.equal(opened, 1);
  assert.equal(inspects, 0);
});

test("expired session in a model group stops the batch before another model is sent", async (t) => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(f.business, "moduleMcp", async () => ({
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => snapshot(),
    call: async (_name, args) => {
      if (args.action === "inspect") return "{}";
      calls++;
      throw Object.assign(Error("AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED"), {
        code: "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
      });
    },
  }));
  await assert.rejects(
    f.call("gea_cube_query", {
      consumerCode: "sales_forecast",
      queries: [query("inv"), query("ship")],
    }),
    /GEA_GATEWAY_SESSION_EXPIRED/,
  );
  assert.equal(calls, 1);
});

test("invalidating an expired business Session creates a fresh module on the next turn", async (t) => {
  const f = fixture(t);
  const signal = new AbortController().signal;
  let opened = 0;
  f.business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://fixture",
    auth: {
      token: "login",
      tenantId: "0",
      name: "Fixture",
      id: "user",
      username: "fixture",
      avatar: "",
    },
  });
  t.mock.method(f.business, "openMcpConnection", async () => {
    opened++;
    return {
      url: "https://fixture/mcp",
      authorizedResources: async () => snapshot(),
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.method === "notifications/initialized") return new Response("", { status: 202 });
        const result =
          body.method === "initialize"
            ? { protocolVersion: body.params.protocolVersion }
            : {
                tools: [
                  { name: "query_business_data", inputSchema: { type: "object", properties: {} } },
                ],
              };
        return Response.json(
          { jsonrpc: "2.0", id: body.id, result },
          { headers: { "MCP-Session-Id": "fixture-transport" } },
        );
      },
    };
  });
  const old = await f.business.moduleMcp("sales_forecast", signal);
  assert.equal(await f.business.moduleMcp("sales_forecast", signal), old);
  f.business.invalidateModuleMcp("sales_forecast");
  const fresh = await f.business.moduleMcp("sales_forecast", signal);
  assert.notEqual(fresh, old);
  assert.equal(opened, 2);
});

test("sample lookup keeps authorized models when another member has ambiguous resources", async (t) => {
  const f = fixture(t);
  let sent = 0;
  const module = {
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => ({
      fetchedAt: "now",
      resources: [
        resource("inv"),
        resource("accuracy"),
        resource("accuracy", { resourceCode: "accuracy-other" }),
      ],
    }),
    call: async (_name, args) => {
      if (args.action === "inspect") return "{}";
      sent++;
      return JSON.stringify({
        datasets: [{ name: "sample", rows: [{ "inv.date": "2026-10-01" }] }],
      });
    },
    artifact: async () => "",
  };
  t.mock.method(f.business, "moduleMcp", async () => module);
  const result = await f.call("gea_gateway_catalog", {
    consumerCode: "sales_forecast",
    members: ["inv.date", "accuracy.month"],
    values: true,
  });
  assert.match(result, /inv.date/);
  assert.match(result, /GEA_RESOURCE_AMBIGUOUS/);
  assert.match(result, /accuracy.month/);
  assert.equal(sent, 1);
});

test("resource version change refreshes the same module field index", async (t) => {
  const f = fixture(t);
  let version = "1",
    inspects = 0;
  const module = {
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => ({
      fetchedAt: "now",
      resources: [resource("inv", { version })],
    }),
    call: async (_name, args) => {
      if (args.action === "inspect") {
        inspects++;
        return JSON.stringify({
          semanticModel: [
            {
              name: "inv",
              measures: [{ name: version === "1" ? "inv.row_count" : "inv.new_count" }],
            },
          ],
        });
      }
      return JSON.stringify({ datasets: [{ name: args.queries[0].name, rows: [{ value: 1 }] }] });
    },
  };
  t.mock.method(f.business, "moduleMcp", async () => module);
  await f.call("gea_cube_query", { consumerCode: "sales_forecast", queries: [query("inv")] });
  version = "2";
  const result = await f.call("gea_cube_query", {
    consumerCode: "sales_forecast",
    queries: [{ name: "new", query: { measures: ["inv.new_count"], limit: 1 } }],
  });
  assert.doesNotMatch(result, /GEA_CUBE_MEMBER_UNKNOWN/);
  assert.equal(inspects, 2);
});

test("catalog samples reject measures and segments before dispatch and keep valid dimensions", async (t) => {
  const f = fixture(t);
  const sent = [];
  const module = {
    tools: () => [{ name: "query_business_data", required: ["action", "queries"] }],
    authorizedResources: async () => snapshot(["inv"]),
    call: async (_name, args) => {
      if (args.action === "inspect")
        return JSON.stringify({
          semanticModel: [
            {
              name: "inv",
              dimensions: [{ name: "inv.month" }],
              measures: [{ name: "inv.count" }],
              segments: [{ name: "inv.active" }],
            },
          ],
        });
      sent.push(args);
      return JSON.stringify({ datasets: [{ name: "sample", rows: [{ "inv.month": "202609" }] }] });
    },
  };
  t.mock.method(f.business, "moduleMcp", async () => module);
  const result = await f.call("gea_gateway_catalog", {
    consumerCode: "sales_forecast",
    members: ["inv.month", "inv.count", "inv.active", "inv.missing"],
    values: true,
  });
  assert.match(result, /202609/);
  assert.match(result, /该成员是度量/);
  assert.match(result, /该成员是分段/);
  assert.match(result, /该成员是未发布成员/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].queries[0].query.dimensions, ["inv.month"]);
});

test("generic Skill and unregistered Consumer cannot enter governed reads", async (t) => {
  const f = fixture(t, {
    readModules: () => [{ data: { consumerCode: "other" } }],
    readToolIndex: () => "",
    byConsumer: () => undefined,
  });
  let opened = 0;
  t.mock.method(f.business, "moduleMcp", async () => {
    opened++;
    throw Error("must not open transport");
  });
  f.select("agent-resource-skill");
  await assert.rejects(
    f.call("gea_cube_query", { consumerCode: "sales_forecast", queries: [query("inv")] }),
    /GEA_BUSINESS_PROFILE_REQUIRED/,
  );
  await assert.rejects(f.call("gea_gateway_catalog", {}), /GEA_BUSINESS_PROFILE_REQUIRED/);
  f.select("gea-readonly");
  await assert.rejects(
    f.call("gea_cube_query", { consumerCode: "other", queries: [query("inv")] }),
    /GEA_CONSUMER_ROUTE_NOT_REGISTERED/,
  );
  assert.equal(opened, 0);
});

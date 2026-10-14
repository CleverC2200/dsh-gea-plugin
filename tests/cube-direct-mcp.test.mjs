import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents:
      "export {openCubeMcp} from './src/host/cube-mcp-client.ts';export {gatewayMcpTransport} from './src/host/gateway-mcp.ts';export {createCubeMcpService} from './src/host/cube-mcp-service.ts';export {registerGeaTools} from './src/host/agent-tools.ts';",
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
const { openCubeMcp, gatewayMcpTransport, createCubeMcpService, registerGeaTools } = mod.exports;
const code = "2109581866385289217";
const schema = {
  type: "object",
  properties: { keyword: { type: "string" } },
  additionalProperties: false,
};
const raw =
  '{"action":"query","status":"completed","executedQueryCount":1,"datasets":[{"name":"forecast","rowCount":1,"complete":true,"hasMore":false,"dataStatus":"ok","totalRowCount":1,"offset":0,"hasMorePages":false,"fields":[{"name":"forecast.amount","type":"number"}],"rows":[{"forecast.amount":9007199254740993.1234,"forecast.code":"001","forecast.null":null,"forecast.zero":0}]}]}';
const query = {
  action: "query",
  response_mode: "inline_complete",
  queries: [
    {
      name: "forecast",
      query: {
        measures: ["forecast.amount"],
        order: { "forecast.amount": "desc" },
        limit: 1,
        offset: 0,
        total: true,
      },
    },
  ],
};

async function clientFixture({ badHash = false, failure } = {}) {
  const sent = [];
  const signal = new AbortController().signal;
  const transport = gatewayMcpTransport(
    "https://fixture",
    {
      agentCode: "sales_forecast",
      sessionId: "business-session",
      conversationId: "conversation",
      delegationToken: "private-fixture-token",
    },
    signal,
    1000,
    async (url, init) => {
      const wire = JSON.parse(init.body);
      sent.push({ url, wire, headers: new Headers(init.headers) });
      const reply = (result, headers) =>
        Response.json({ jsonrpc: "2.0", id: wire.id, result }, { headers });
      if (wire.method === "initialize")
        return reply({ protocolVersion: "2025-06-18" }, { "MCP-Session-Id": "transport-session" });
      if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (wire.method === "tools/list")
        return reply({
          tools: [
            {
              name: "query_business_data",
              inputSchema: schema,
              _meta: { sourceType: "MCP", sourceCode: "old-cube" },
            },
            {
              name: "lightrag_query",
              inputSchema: schema,
              _meta: { sourceType: "MCP", sourceCode: "rag" },
            },
            ...["inspect_cube_model", "query_business_data"].map((name) => ({
              name,
              description: name,
              inputSchema: schema,
              _meta: { sourceType: "MCP", sourceCode: code },
            })),
          ],
        });
      if (wire.method === "tools/call" && wire.params.name === "inspect_cube_model")
        return reply({
          structuredContent: {
            action: "inspect",
            semanticModel: [
              {
                name: "forecast_qa",
                type: "view",
                measures: [
                  {
                    name: "forecast_qa.amount",
                    aliasMember: "forecast.amount",
                  },
                ],
              },
            ],
          },
        });
      if (wire.method === "tools/call")
        return failure
          ? reply({ isError: true, structuredContent: failure })
          : reply({
              content: [
                {
                  type: "resource_link",
                  uri: "data-artifact://gateway/fixture",
                  mimeType: "application/json",
                  _meta: {
                    sha256: createHash("sha256").update(raw).digest("hex"),
                  },
                },
              ],
            });
      if (wire.method === "resources/read")
        return reply({
          contents: [
            {
              uri: wire.params.uri,
              mimeType: "application/json",
              text: raw,
              _meta: {
                sha256: badHash ? "0".repeat(64) : createHash("sha256").update(raw).digest("hex"),
              },
            },
          ],
        });
      throw Error("unexpected request");
    },
    { cubeMcpCode: code },
  );
  return { client: await openCubeMcp(transport, signal), sent, signal };
}

test("direct Cube methods preserve server schemas, original decimals and the original business/transport sessions", async () => {
  const f = await clientFixture();
  assert.deepEqual(
    f.client.tools().map((t) => t.name),
    ["inspect_cube_model", "query_business_data"],
  );
  assert.deepEqual(f.client.tools()[0].inputSchema, schema);
  const metadata = JSON.parse(
    await f.client.call("inspect_cube_model", { keyword: "预测" }, f.signal),
  );
  assert.equal(metadata.semanticModel[0].measures[0].aliasMember, "forecast.amount");
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.deepEqual(
    f.sent.find((x) => x.wire.params?.name === "query_business_data").wire.params.arguments,
    query,
  );
  assert.ok(
    f.sent.every((x) => x.url.endsWith("/mcp")),
    "new calls must not run the old resource/planner adapters",
  );
  for (const x of f.sent.filter((x) => ["tools/call", "resources/read"].includes(x.wire.method))) {
    assert.equal(x.wire.params._meta.mcpCode, code);
    assert.equal(x.wire.params._meta.sessionId, "business-session");
    assert.equal(x.headers.get("MCP-Protocol-Version"), "2025-06-18");
    assert.equal(x.headers.get("MCP-Session-Id"), "transport-session");
  }
});

test("direct Cube rejects forged artifacts and caller-supplied platform identity without publication or retries", async () => {
  const f = await clientFixture({ badHash: true });
  await assert.rejects(f.client.call("query_business_data", query, f.signal), /RESOURCE_DIGEST/);
  const calls = f.sent.length;
  await assert.rejects(
    f.client.call("query_business_data", { ...query, consumerCode: "other" }, f.signal),
    /PLATFORM_ARGUMENT_REJECTED/,
  );
  assert.equal(f.sent.length, calls);
});

test("member publication failure keeps the server code and does not suggest parameter retries", async () => {
  const f = await clientFixture({
    failure: {
      success: false,
      code: "DATA_QUERY_MEMBER_NOT_PUBLISHED",
      businessCode: "DATA_QUERY_MEMBER_NOT_PUBLISHED",
      retryable: false,
      category: "VALIDATION",
      message: "MCP 上游调用失败",
      requestId: "fixture-request",
    },
  });
  await assert.rejects(f.client.call("query_business_data", query, f.signal), (error) => {
    assert.equal(error.code, "DATA_QUERY_MEMBER_NOT_PUBLISHED");
    assert.equal(error.retryable, false);
    assert.match(error.message, /fixture-request|服务端/);
    assert.doesNotMatch(error.message, /改好参数后可以|重新调用一次|private-fixture-token/);
    return true;
  });
  assert.equal(f.sent.filter((x) => x.wire.method === "tools/call").length, 1);
});

function serviceFixture() {
  const profiles = new Map([
    ["sales", "gea-readonly"],
    ["dealer", "gea-html-inventory-dealer"],
    ["code", "standard"],
  ]);
  const calls = [],
    stopped = new Map();
  const identity = new AbortController();
  const listeners = new Map();
  const ctx = {
    on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    agents: {
      get: (id) => (profiles.has(id) ? { id, session: { id } } : undefined),
      list: () => [...profiles.keys()].map((id) => ({ id, session: { id } })),
    },
    sessionProjections: { stateOf: (session) => profiles.get(session.id) },
    agentResources: {
      list: async () =>
        ["gea-readonly", "gea-html-inventory-dealer"].map((id) => ({
          id,
          kind: "prompt",
          installed: true,
          enabled: true,
        })),
    },
  };
  const module = {
    tools: () => [],
    call: async (name, args) => {
      calls.push({ name, args });
      return "result";
    },
  };
  const business = {
    config: { analysisAgentCode: "sales_forecast" },
    status: () => ({ authenticated: true }),
    identitySignal: () => identity.signal,
    watchIdentity: () => () => {},
    invalidateModuleMcp: () => {},
    moduleMcp: async (consumer) => {
      calls.push({ consumer });
      return module;
    },
    turnStopped: (id) => stopped.get(id),
    stopTurn: (id, message) => stopped.set(id, message),
  };
  return {
    service: createCubeMcpService(ctx, business),
    business,
    module,
    profiles,
    calls,
    identity,
    listeners,
    ctx,
  };
}

test("discovery uses real business Sessions; a denied sales Consumer does not hide inventory tools", async () => {
  const f = serviceFixture();
  f.module.tools = () => [{ name: "inspect_cube_model", inputSchema: schema }];
  f.business.moduleMcp = async (consumer) => {
    f.calls.push({ consumer });
    if (consumer === "sales_forecast") throw Error("SALES_PERMISSION_DENIED");
    return f.module;
  };
  const tools = await f.service.listTools(new AbortController().signal);
  assert.equal(tools[0].name, "inspect_cube_model");
  assert.deepEqual(
    f.calls.map((x) => x.consumer),
    ["sales_forecast", "dealer-inventory-replenishment"],
  );
  f.profiles.delete("sales");
  f.profiles.delete("dealer");
  f.calls.length = 0;
  assert.deepEqual(await f.service.listTools(new AbortController().signal), []);
  assert.equal(f.calls.length, 0);
});

test("discovery reacts to Session lifecycle and rejects disabled resources or a late identity", async () => {
  const f = serviceFixture();
  let changes = 0;
  const stop = f.service.watch(() => changes++);
  for (const event of ["agent/created", "agent/disposed", "agent-preset/selected"])
    f.listeners.get(event)();
  f.listeners.get("skills/change")();
  assert.equal(changes, 4);
  stop();
  assert.equal(f.listeners.size, 0);
  f.profiles.delete("sales");
  f.ctx.agentResources.list = async () => [
    {
      id: "gea-html-inventory-dealer",
      kind: "prompt",
      installed: true,
      enabled: false,
    },
  ];
  await assert.rejects(f.service.listTools(new AbortController().signal), /RESOURCE_DISABLED/);
  assert.equal(f.calls.length, 0);
  f.ctx.agentResources.list = async () => [
    {
      id: "gea-html-inventory-dealer",
      kind: "prompt",
      installed: true,
      enabled: true,
    },
  ];
  f.business.moduleMcp = async () => {
    f.identity.abort();
    return f.module;
  };
  await assert.rejects(f.service.listTools(new AbortController().signal), /abort/i);
});

test("different business Consumer schemas cannot overwrite each other's registered tools", async () => {
  const f = serviceFixture();
  f.business.moduleMcp = async (consumer) => ({
    tools: () => [
      {
        name: "inspect_cube_model",
        inputSchema: consumer === "sales_forecast" ? schema : { type: "object" },
      },
    ],
  });
  await assert.rejects(f.service.listTools(new AbortController().signal), /SCHEMA_CONFLICT/);
});

test("direct MCP derives sales and dealer Consumers from real Session presets and rejects unprofiled callers", async () => {
  const f = serviceFixture(),
    signal = new AbortController().signal;
  assert.equal(f.service.allows("code"), false);
  assert.equal(f.service.allows("dealer"), true);
  await f.service.call("sales", "query_business_data", query, signal);
  await f.service.call("dealer", "query_business_data", query, signal);
  assert.deepEqual(
    f.calls.filter((x) => x.consumer).map((x) => x.consumer),
    ["sales_forecast", "dealer-inventory-replenishment"],
  );
  await assert.rejects(
    f.service.call("code", "query_business_data", query, signal),
    /BUSINESS_PROFILE_REQUIRED/,
  );
});

test("a changed preset cannot receive a late direct MCP result; publication failure closes the query turn", async () => {
  const f = serviceFixture(),
    signal = new AbortController().signal;
  f.module.call = async () => {
    f.profiles.set("sales", "gea-html-inventory-dealer");
    return "old result";
  };
  await assert.rejects(
    f.service.call("sales", "query_business_data", query, signal),
    /EXECUTION_OWNER_CHANGED/,
  );
  f.profiles.set("sales", "gea-readonly");
  let sent = 0;
  f.module.call = async () => {
    sent++;
    throw Object.assign(Error("member not published"), {
      code: "DATA_QUERY_MEMBER_NOT_PUBLISHED",
    });
  };
  await assert.rejects(
    f.service.call("sales", "query_business_data", query, signal),
    /member not published/,
  );
  await assert.rejects(
    f.service.call("sales", "query_business_data", query, signal),
    /TURN_STOPPED/,
  );
  assert.equal(sent, 1);
});

test("the legacy catalog, batch and module tools are no longer registered", () => {
  const names = [];
  registerGeaTools(
    {
      effect: (fn) => fn(),
      tools: {
        register: (tool) => {
          names.push(tool.name);
          return () => {};
        },
      },
    },
    { config: { analysisAgentCode: "sales_forecast", requestTimeoutMs: 1000 } },
  );
  for (const name of ["gea_gateway_catalog", "gea_cube_query", "gea_module_mcp"])
    assert.equal(names.includes(name), false);
  assert.ok(names.includes("gea_sales_plan_read"));
});

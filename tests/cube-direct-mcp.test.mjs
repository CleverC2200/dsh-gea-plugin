import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents:
      "export {openGatewayMcp} from './src/host/gateway-mcp-client.ts';export {gatewayMcpTransport} from './src/host/gateway-mcp.ts';export {createGatewayMcpService} from './src/host/gateway-mcp-service.ts';export {registerGeaTools} from './src/host/agent-tools.ts';",
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
const { openGatewayMcp, gatewayMcpTransport, createGatewayMcpService, registerGeaTools } =
  mod.exports;
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

async function clientFixture({
  badHash = false,
  failure,
  inline,
  maxResponseBytes,
  sse = false,
  artifact = raw,
} = {}) {
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
              name: "weknora_ask",
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
      if (wire.method === "tools/call" && inline !== undefined) {
        const result = typeof inline === "function" ? inline(wire) : inline;
        const body =
          '{"jsonrpc":"2.0","id":' + JSON.stringify(wire.id) + ',"result":' + result + "}";
        return new Response(sse ? "event: message\ndata: " + body + "\n\n" : body, {
          headers: { "content-type": sse ? "text/event-stream" : "application/json" },
        });
      }
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
                    sha256: createHash("sha256").update(artifact).digest("hex"),
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
              text: artifact,
              _meta: {
                sha256: badHash
                  ? "0".repeat(64)
                  : createHash("sha256").update(artifact).digest("hex"),
              },
            },
          ],
        });
      throw Error("unexpected request");
    },
    { cubeMcpCode: code, maxResponseBytes },
  );
  return { client: await openGatewayMcp(transport, signal), sent, signal };
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
    service: createGatewayMcpService(ctx, business),
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

test("compatible Consumer tool subsets and property order keep the server schemas", async () => {
  const f = serviceFixture();
  const inspect = { name: "inspect_cube_model", description: "inspect", inputSchema: schema };
  const query = { name: "query_business_data", description: "query", inputSchema: schema };
  f.business.moduleMcp = async (consumer) => ({
    tools: () =>
      consumer === "sales_forecast"
        ? [inspect]
        : [
            query,
            {
              ...inspect,
              inputSchema: {
                additionalProperties: false,
                properties: { keyword: { type: "string" } },
                type: "object",
              },
            },
          ],
  });
  const tools = await f.service.listTools(new AbortController().signal);
  assert.deepEqual(tools, [inspect, query]);
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

const inlineResult = (payload = raw) =>
  '{"structuredContent":' +
  payload +
  ',"content":[{"type":"text","text":' +
  JSON.stringify(payload) +
  "}]}";
const resourceReads = (f) => f.sent.filter((x) => x.wire.method === "resources/read").length;

test("inline structuredContent consumes once, keeps exact number tokens and never reads a Resource", async () => {
  const f = await clientFixture({ inline: inlineResult() });
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.equal(resourceReads(f), 0);
  assert.equal(f.sent.filter((x) => x.wire.method === "tools/call").length, 1);
});

test("inline SSE preserves exact values and the existing protocol and route", async () => {
  const f = await clientFixture({ inline: inlineResult(), sse: true });
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.equal(resourceReads(f), 0);
  const call = f.sent.find((x) => x.wire.method === "tools/call");
  assert.equal(call.wire.params._meta.mcpCode, code);
  assert.equal(call.headers.get("MCP-Session-Id"), "transport-session");
});

test("text-only results select one business JSON block without joining explanatory text", async () => {
  const f = await clientFixture({
    inline: JSON.stringify({
      content: [
        { type: "text", text: "以下是本次业务查询结果" },
        { type: "text", text: raw },
      ],
    }),
  });
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.equal(resourceReads(f), 0);
});

test("structuredContent takes priority over conflicting text and old links", async () => {
  const f = await clientFixture({
    inline:
      '{"structuredContent":' +
      raw +
      ',"content":' +
      JSON.stringify([
        { type: "text", text: raw.replace('"001"', '"002"') },
        {
          type: "resource_link",
          uri: "data-artifact://gateway/fixture",
          mimeType: "application/json",
        },
      ]) +
      "}",
  });
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.equal(resourceReads(f), 0);
});

for (const [label, change, code] of [
  ["wrong query count", (p) => (p.executedQueryCount = 0), /DATASETS/],
  ["missing dataset", (p) => (p.datasets = []), /DATASETS/],
  ["wrong dataset name", (p) => (p.datasets[0].name = "other"), /DATASET_NAME/],
  ["row count", (p) => (p.datasets[0].rowCount = 0), /PAGE_INCOMPLETE/],
  ["explicit incompleteness", (p) => (p.datasets[0].complete = false), /PAGE_INCOMPLETE/],
  ["undelivered rows", (p) => (p.datasets[0].hasMore = true), /PAGE_INCOMPLETE/],
  ["invalid completeness", (p) => (p.datasets[0].complete = null), /PAGE_INCOMPLETE/],
  ["invalid delivery remainder", (p) => (p.datasets[0].hasMore = "false"), /PAGE_INCOMPLETE/],
  ["truncation", (p) => (p.datasets[0].truncated = true), /PAGE_INCOMPLETE/],
  ["invalid truncation", (p) => (p.datasets[0].truncated = null), /PAGE_INCOMPLETE/],
  ["missing pagination", (p) => delete p.datasets[0].offset, /PAGE_METADATA/],
  ["inconsistent pagination", (p) => (p.datasets[0].hasMorePages = true), /PAGE_METADATA/],
])
  test("inline rejects " + label + " without resource fallback or retry", async () => {
    const payload = JSON.parse(raw);
    change(payload);
    const f = await clientFixture({ inline: inlineResult(JSON.stringify(payload)) });
    await assert.rejects(f.client.call("query_business_data", query, f.signal), code);
    assert.equal(resourceReads(f), 0);
    assert.equal(f.sent.filter((x) => x.wire.method === "tools/call").length, 1);
  });

test("empty and partial data keep their distinct statuses and null/zero values", async () => {
  for (const status of ["no_data", "partial"]) {
    const payload = JSON.parse(raw);
    const dataset = payload.datasets[0];
    dataset.dataStatus = status;
    if (status === "no_data") {
      dataset.rows = [];
      dataset.rowCount = 0;
      dataset.totalRowCount = 0;
    }
    const f = await clientFixture({ inline: inlineResult(JSON.stringify(payload)) });
    const result = JSON.parse(await f.client.call("query_business_data", query, f.signal));
    assert.equal(result.datasets[0].dataStatus, status);
    assert.deepEqual(result.datasets[0].rows, dataset.rows);
    assert.equal(resourceReads(f), 0);
  }
});

test("named query batches match by name and preserve business pagination and optional metadata", async () => {
  const payload = JSON.parse(raw);
  payload.executedQueryCount = 2;
  payload.datasets[0].totalRowCount = 2;
  payload.datasets[0].hasMorePages = true;
  payload.datasets[0].warnings = ["fixture-warning"];
  payload.datasets.push({ ...payload.datasets[0], name: "stock" });
  payload.datasets.reverse();
  const f = await clientFixture({ inline: inlineResult(JSON.stringify(payload)) });
  const args = { ...query, queries: [...query.queries, { ...query.queries[0], name: "stock" }] };
  assert.deepEqual(JSON.parse(await f.client.call("query_business_data", args, f.signal)), payload);
  assert.equal(resourceReads(f), 0);
});

test("ambiguous and unsupported query responses stop the current round without resource fallback", async () => {
  for (const [result, code] of [
    [
      {
        content: [
          { type: "text", text: raw },
          { type: "text", text: raw },
        ],
      },
      /AMBIGUOUS/,
    ],
    [{ content: [{ type: "text", text: "查询已处理" }] }, /QUERY_RESULT_INVALID/],
    [
      {
        content: [
          {
            type: "resource_link",
            uri: "https://example.invalid/data",
            mimeType: "application/json",
          },
        ],
      },
      /QUERY_RESOURCE_LINK/,
    ],
  ]) {
    const client = await clientFixture({ inline: JSON.stringify(result) });
    const service = serviceFixture();
    service.module.call = (name, args, signal) => client.client.call(name, args, signal);
    await assert.rejects(
      service.service.call("sales", "query_business_data", query, client.signal),
      code,
    );
    await assert.rejects(
      service.service.call("sales", "query_business_data", query, client.signal),
      /GEA_TURN_STOPPED/,
    );
    assert.equal(client.sent.filter((x) => x.wire.method === "tools/call").length, 1);
    assert.equal(resourceReads(client), 0);
  }
});

test("isError blocks valid-looking data and preserves server diagnostics and pagination guidance", async () => {
  for (const textOnly of [false, true]) {
    const failure = {
      success: false,
      code: "AI_GATEWAY_MCP_RESULT_TOO_LARGE",
      retryable: true,
      category: "CAPACITY",
      suggestedAction: "NARROW_QUERY_OR_PAGINATE",
      requestId: "fixture-request",
      traceId: "fixture-trace",
      auditId: "fixture-audit",
      details: { actualBytes: 200, maxBytes: 100 },
      message: "结果过大",
    };
    const result = textOnly
      ? { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] }
      : { isError: true, structuredContent: failure, content: [{ type: "text", text: raw }] };
    const f = await clientFixture({ inline: JSON.stringify(result) });
    await assert.rejects(f.client.call("query_business_data", query, f.signal), (error) => {
      assert.equal(error.code, failure.code);
      assert.equal(error.category, failure.category);
      assert.equal(error.suggestedAction, failure.suggestedAction);
      assert.equal(error.requestId, failure.requestId);
      assert.equal(error.traceId, failure.traceId);
      assert.equal(error.auditId, failure.auditId);
      assert.deepEqual(error.details, failure.details);
      assert.match(error.message, /不要原样重试/);
      return true;
    });
    assert.equal(resourceReads(f), 0);
    assert.equal(f.sent.filter((x) => x.wire.method === "tools/call").length, 1);
  }
  const f = await clientFixture({ inline: '{"isError":true,"structuredContent":' + raw + "}" });
  await assert.rejects(f.client.call("query_business_data", query, f.signal), /GEA_MCP_TOOL_ERROR/);
});

test("inline responses above the former 4MB cap succeed and configured wire byte budgets reject oversize", async () => {
  const payload = raw.replace('"001"', JSON.stringify("字".repeat(2_200_000)));
  const result = inlineResult(payload);
  const f = await clientFixture({ inline: result });
  assert.equal(await f.client.call("query_business_data", query, f.signal), payload);
  assert.equal(resourceReads(f), 0);
  const limited = await clientFixture({ inline: result, maxResponseBytes: 6000 });
  await assert.rejects(
    limited.client.call("query_business_data", query, limited.signal),
    (error) => {
      assert.equal(error.code, "GEA_MCP_RESPONSE_TOO_LARGE");
      assert.equal(error.maxBytes, 6000);
      assert.equal(error.suggestedAction, "NARROW_QUERY_OR_PAGINATE");
      return true;
    },
  );
  assert.equal(resourceReads(limited), 0);
});

test("consecutive business pages are separate tools/call responses without resource reads", async () => {
  const first = JSON.parse(raw),
    second = JSON.parse(raw);
  first.datasets[0].totalRowCount = 2;
  first.datasets[0].hasMorePages = true;
  second.datasets[0].offset = 1;
  second.datasets[0].totalRowCount = 2;
  second.datasets[0].rows[0]["forecast.code"] = "002";
  const f = await clientFixture({
    inline: (wire) =>
      inlineResult(
        JSON.stringify(wire.params.arguments.queries[0].query.offset === 0 ? first : second),
      ),
  });
  const page = JSON.parse(await f.client.call("query_business_data", query, f.signal)).datasets[0];
  const next = {
    ...query,
    queries: [
      {
        ...query.queries[0],
        query: { ...query.queries[0].query, offset: page.offset + page.rows.length },
      },
    ],
  };
  assert.deepEqual(JSON.parse(await f.client.call("query_business_data", next, f.signal)), second);
  const calls = f.sent.filter((x) => x.wire.method === "tools/call");
  assert.equal(calls.length, 2);
  assert.equal(resourceReads(f), 0);
  assert.equal(calls[1].wire.params.arguments.queries[0].query.offset, 1);
  assert.deepEqual(
    calls[1].wire.params.arguments.queries[0].query.order,
    query.queries[0].query.order,
  );
});

test("inline errors stop before parsing even when result.isError is absent", async () => {
  const f = await clientFixture({
    inline: JSON.stringify({
      structuredContent: {
        success: false,
        code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
        message: "拒权",
        retryable: false,
      },
    }),
  });
  await assert.rejects(f.client.call("query_business_data", query, f.signal), (error) => {
    assert.equal(error.code, "AI_GATEWAY_DATA_PERMISSION_DENIED");
    return true;
  });
  assert.equal(resourceReads(f), 0);
  assert.equal(f.sent.filter((x) => x.wire.method === "tools/call").length, 1);
});

test("nullable structuredContent does not block a valid text-only business result", async () => {
  const f = await clientFixture({
    inline: JSON.stringify({ structuredContent: null, content: [{ type: "text", text: raw }] }),
  });
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.equal(resourceReads(f), 0);
});

for (const [label, field] of [
  ["measure", { measures: ["amount"] }],
  ["dimension", { dimensions: ["month"] }],
  ["segment", { segments: ["active"] }],
  ["time", { timeDimensions: [{ dimension: "month" }] }],
  [
    "nested filter",
    { filters: [{ or: [{ and: [{ member: "code", operator: "equals", values: ["001"] }] }] }] },
  ],
  ["sort", { order: { month: "desc" } }],
  ["ordered sort", { order: [["month", "desc"]] }],
])
  test("bare " + label + " is rejected before any business request", async () => {
    const f = await clientFixture();
    const args = structuredClone(query);
    Object.assign(args.queries[0].query, field);
    await assert.rejects(f.client.call("query_business_data", args, f.signal), (error) => {
      assert.equal(error.code, "GEA_CUBE_QUERY_MEMBER_REQUIRED");
      assert.match(error.message, /aliasMember/);
      return true;
    });
    assert.equal(f.sent.filter((x) => x.wire.method === "tools/call").length, 0);
  });

test("deployed direct pages without artifact flags preserve raw data and remain queryable", async () => {
  const direct = raw.replace('"complete":true,"hasMore":false,', "");
  for (const mode of ["structured", "text"]) {
    const result =
      mode === "structured"
        ? inlineResult(direct)
        : JSON.stringify({ content: [{ type: "text", text: direct }] });
    const client = await clientFixture({ inline: result });
    const service = serviceFixture();
    service.module.call = (name, args, signal) => client.client.call(name, args, signal);
    assert.equal(
      await service.service.call("sales", "query_business_data", query, client.signal),
      direct,
    );
    assert.equal(
      await service.service.call("sales", "query_business_data", query, client.signal),
      direct,
    );
    assert.equal(client.sent.filter((x) => x.wire.method === "tools/call").length, 2);
    assert.equal(resourceReads(client), 0);
    assert.equal(JSON.parse(direct).datasets[0].complete, undefined);
    assert.match(direct, /9007199254740993\.1234/);
  }
});

for (const [label, change, code] of [
  ["row count", (p) => (p.datasets[0].rowCount = 2), /PAGE_INCOMPLETE/],
  ["missing total", (p) => delete p.datasets[0].totalRowCount, /PAGE_METADATA/],
  ["missing offset", (p) => delete p.datasets[0].offset, /PAGE_METADATA/],
  ["missing continuation", (p) => delete p.datasets[0].hasMorePages, /PAGE_METADATA/],
  ["contradictory continuation", (p) => (p.datasets[0].hasMorePages = true), /PAGE_METADATA/],
  ["truncation", (p) => (p.datasets[0].truncated = true), /PAGE_INCOMPLETE/],
])
  test("direct pages without artifact flags still reject " + label, async () => {
    const payload = JSON.parse(raw);
    delete payload.datasets[0].complete;
    delete payload.datasets[0].hasMore;
    change(payload);
    const client = await clientFixture({ inline: inlineResult(JSON.stringify(payload)) });
    await assert.rejects(client.client.call("query_business_data", query, client.signal), code);
    assert.equal(resourceReads(client), 0);
    assert.equal(client.sent.filter((x) => x.wire.method === "tools/call").length, 1);
  });

test("direct pages without artifact flags preserve business continuation and partial data", async () => {
  const payload = JSON.parse(raw);
  delete payload.datasets[0].complete;
  delete payload.datasets[0].hasMore;
  payload.datasets[0].totalRowCount = 2;
  payload.datasets[0].hasMorePages = true;
  payload.datasets[0].dataStatus = "partial";
  const client = await clientFixture({ inline: inlineResult(JSON.stringify(payload)) });
  assert.deepEqual(
    JSON.parse(await client.client.call("query_business_data", query, client.signal)),
    payload,
  );
  assert.equal(resourceReads(client), 0);
});

for (const key of ["complete", "hasMore"])
  test("legacy resource still requires " + key + " with a valid original digest", async () => {
    const payload = JSON.parse(raw);
    delete payload.datasets[0][key];
    const client = await clientFixture({ artifact: JSON.stringify(payload) });
    await assert.rejects(
      client.client.call("query_business_data", query, client.signal),
      /PAGE_INCOMPLETE/,
    );
    assert.equal(resourceReads(client), 1);
    assert.equal(client.sent.filter((x) => x.wire.method === "tools/call").length, 1);
  });

test("direct metadata with contradictory pagination fails with actionable fields and stops further queries", async () => {
  const payload = JSON.parse(raw);
  payload.deliveryMode = "inline_complete";
  delete payload.datasets[0].complete;
  delete payload.datasets[0].hasMore;
  payload.datasets[0].hasMorePages = true;
  const client = await clientFixture({ inline: inlineResult(JSON.stringify(payload)) });
  const service = serviceFixture();
  service.module.call = (name, args, signal) => client.client.call(name, args, signal);
  await assert.rejects(
    service.service.call("sales", "query_business_data", query, client.signal),
    (error) => {
      assert.match(error.message, /GEA_CUBE_NEW_PAGE_METADATA/);
      assert.match(error.message, /hasMorePages/);
      assert.match(error.message, /本轮停止查询/);
      return true;
    },
  );
  await assert.rejects(
    service.service.call("sales", "query_business_data", query, client.signal),
    /GEA_TURN_STOPPED/,
  );
  assert.equal(client.sent.filter((x) => x.wire.method === "tools/call").length, 1);
  assert.equal(resourceReads(client), 0);
  assert.equal(payload.datasets[0].complete, undefined);
});

test("response-contract stop is isolated to the calling session", async () => {
  const f = serviceFixture();
  f.module.call = async () => {
    throw Object.assign(Error("contract mismatch"), {
      category: "RESPONSE_CONTRACT",
      code: "GEA_CUBE_NEW_PAGE_INCOMPLETE",
    });
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    f.service.call("sales", "query_business_data", query, signal),
    /contract mismatch/,
  );
  f.module.call = async () => "other-session-result";
  assert.equal(
    await f.service.call("dealer", "query_business_data", query, signal),
    "other-session-result",
  );
});

test("a corrected member can proceed without changing identity or rewriting arguments", async () => {
  const f = await clientFixture({ inline: inlineResult(raw) });
  const bad = structuredClone(query);
  bad.queries[0].query.measures = ["amount"];
  await assert.rejects(f.client.call("query_business_data", bad, f.signal), /MEMBER_REQUIRED/);
  assert.equal(await f.client.call("query_business_data", query, f.signal), raw);
  assert.deepEqual(f.sent.find((x) => x.wire.method === "tools/call").wire.params.arguments, query);
});

test("a late response-contract error after cancellation cannot stop the next call", async () => {
  const f = serviceFixture();
  const controller = new AbortController();
  f.module.call = async () => {
    controller.abort();
    throw Object.assign(Error("late contract mismatch"), { category: "RESPONSE_CONTRACT" });
  };
  await assert.rejects(
    f.service.call("sales", "query_business_data", query, controller.signal),
    /late contract mismatch/,
  );
  f.module.call = async () => "new-turn-result";
  assert.equal(
    await f.service.call("sales", "query_business_data", query, new AbortController().signal),
    "new-turn-result",
  );
});

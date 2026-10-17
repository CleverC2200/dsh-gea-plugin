import test from "node:test";
import assert from "node:assert/strict";
import { currentMcp, queryTool, query } from "./fixtures/current-mcp.mjs";

const catalog = "mcp__gea-gateway__weknora_list_knowledge_bases";
const ask = "mcp__gea-gateway__weknora_ask";
const catalogSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const askSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 4000 },
    knowledgeBaseIds: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string" },
    },
  },
  required: ["query", "knowledgeBaseIds"],
  additionalProperties: false,
};
const tools = [
  {
    name: "weknora_list_knowledge_bases",
    description: "Server knowledge catalog",
    inputSchema: catalogSchema,
  },
  {
    name: "weknora_ask",
    description: "Server single-turn answer",
    inputSchema: askSchema,
  },
].map((tool) => ({
  ...tool,
  _meta: { sourceType: "MCP", sourceCode: "mcp.weknora" },
}));
const library = (id, actions = ["ASK"]) => ({
  id,
  name: `库 ${id}`,
  description: "",
  accessMode: "CONTROLLED",
  actions,
});
const args = {
  query: "请说明 GEA 用户同步接口的版本和差异。",
  knowledgeBaseIds: ["current-library"],
};
const answer = (ids = args.knowledgeBaseIds) => ({
  status: "COMPLETED",
  answer: "有依据的完整答案。",
  references: ids.map((knowledgeBaseId) => ({
    knowledgeBaseId,
    title: "受控文档",
    content: "依据片段",
  })),
});
const invoke = (f, tool, input, id = "sales", signal) => f.execute(tool, input, id, signal);
const count = (f, name) =>
  f.calls.filter(({ wire }) => wire.method === "tools/call" && wire.params.name === name).length;
async function fixture(t, options = {}) {
  return currentMcp(t, {
    extraTools: tools,
    readyTool: ask,
    handler: (wire, _init, reply) =>
      reply({
        structuredContent:
          wire.params.name === "weknora_list_knowledge_bases"
            ? [library("current-library")]
            : answer(wire.params.arguments.knowledgeBaseIds),
      }),
    ...options,
  });
}
const successful = (result) => {
  assert.equal(result.isError, false, JSON.stringify(result));
  return JSON.parse(result.value);
};

test("Manage exposes actual knowledge schemas and a dynamic ASK catalog for the calling Agent", async (t) => {
  let revision = 1;
  const f = await fixture(t, {
    dealer: true,
    handler: (wire, _init, reply) =>
      reply({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              library(`${wire.params._meta.agentCode}-${revision}`),
              library("view-only", ["VIEW_SOURCE"]),
            ]),
          },
        ],
      }),
  });
  assert.deepEqual(
    f.ctx.tools.schemas(f.agents.get("sales")).find((tool) => tool.name === ask).parameters,
    askSchema,
  );
  assert.deepEqual(
    successful(await invoke(f, catalog, {})).map((x) => x.id),
    ["sales_forecast-1"],
  );
  revision = 2;
  assert.deepEqual(
    successful(await invoke(f, catalog, {})).map((x) => x.id),
    ["sales_forecast-2"],
  );
  assert.deepEqual(
    successful(await invoke(f, catalog, {}, "dealer")).map((x) => x.id),
    ["dealer-inventory-replenishment-2"],
  );
  assert.equal(count(f, "weknora_list_knowledge_bases"), 3);
  for (const call of f.calls.filter(({ wire }) => wire.method === "tools/call")) {
    assert.equal(call.wire.params._meta.mcpCode, "mcp.weknora");
    assert.deepEqual(call.wire.params.arguments, {});
  }
});

test("knowledge works with no Cube source configured and cannot publish an unconfigured Cube", async (t) => {
  const f = await fixture(t, { cubeMcpCodes: {} });
  assert.equal(f.ctx.tools.get(queryTool), undefined);
  assert.deepEqual(successful(await invoke(f, catalog, {})), [library("current-library")]);
  assert.deepEqual(successful(await invoke(f, ask, args)), answer());
});

for (const mode of ["structured", "text", "wrapped", "nullable", "both"])
  test(`knowledge ${mode} answers retain citations and audit identifiers without Cube parsing or resource reads`, async (t) => {
    const payload =
      mode === "wrapped"
        ? {
            success: true,
            code: "SUCCESS",
            result: answer(),
            requestId: "answer-request",
            traceId: "answer-trace",
            auditId: "answer-audit",
          }
        : answer();
    const f = await fixture(t, {
      handler: (_wire, _init, reply) =>
        reply(
          mode === "structured" || mode === "wrapped"
            ? { structuredContent: payload }
            : mode === "both"
              ? {
                  structuredContent: payload,
                  content: [{ type: "text", text: JSON.stringify({ bad: true }) }],
                }
              : {
                  ...(mode === "nullable" ? { structuredContent: null } : {}),
                  content: [
                    { type: "text", text: "调用说明" },
                    { type: "text", text: JSON.stringify(payload) },
                  ],
                },
        ),
    });
    assert.deepEqual(successful(await invoke(f, ask, args)), payload);
    assert.equal(count(f, "weknora_ask"), 1);
    assert.equal(
      f.calls.some(({ wire }) => wire.method === "resources/read"),
      false,
    );
    assert.deepEqual(
      f.calls.find(({ wire }) => wire.params?.name === "weknora_ask").wire.params.arguments,
      args,
    );
  });

test("multi-library complete questions keep all selected IDs and references", async (t) => {
  const f = await fixture(t);
  const multiple = {
    query: "请比较授权库甲和乙中的完整规则。",
    knowledgeBaseIds: ["library-a", "library-b"],
  };
  assert.deepEqual(successful(await invoke(f, ask, multiple)), answer(multiple.knowledgeBaseIds));
});

test("empty authorized catalog is an explicit empty result", async (t) => {
  const f = await fixture(t, {
    handler: (_wire, _init, reply) => reply({ content: [{ type: "text", text: "[]" }] }),
  });
  assert.deepEqual(successful(await invoke(f, catalog, {})), []);
});

for (const [label, input] of [
  ["empty question", { ...args, query: " " }],
  ["long question", { ...args, query: "问".repeat(4001) }],
  ["no libraries", { ...args, knowledgeBaseIds: [] }],
  ["duplicate libraries", { ...args, knowledgeBaseIds: ["a", "a"] }],
  [
    "too many libraries",
    {
      ...args,
      knowledgeBaseIds: Array.from({ length: 21 }, (_, i) => `library-${i}`),
    },
  ],
  ["empty library", { ...args, knowledgeBaseIds: [""] }],
  ["login token", { ...args, token: "forged" }],
  ["identity", { ...args, userId: "forged" }],
  ["Consumer", { ...args, consumerCode: "forged" }],
])
  test(`invalid knowledge ${label} is rejected before downstream execution`, async (t) => {
    const f = await fixture(t, {
      extraTools: tools.map((tool) => ({
        ...tool,
        inputSchema: { type: "object", additionalProperties: true },
      })),
    });
    const result = await invoke(f, ask, input);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /ARGUMENT/);
    assert.equal(count(f, "weknora_ask"), 0);
  });

for (const failure of [
  { code: "AI_PERMISSION_DENIED", message: "Consumer未获得知识库动作授权" },
  {
    code: "AI_GATEWAY_CAPABILITY_NOT_ALLOWED",
    message: "调用方未授权知识工具",
  },
  {
    code: "AI_GATEWAY_RATE_LIMITED",
    message: "请求限流",
    retryable: true,
    retryAfterMs: 1000,
  },
])
  test(`knowledge preserves ${failure.code} and audit IDs without a replay`, async (t) => {
    const f = await fixture(t, {
      handler: (_wire, _init, reply) =>
        reply({
          isError: true,
          structuredContent: {
            success: false,
            ...failure,
            requestId: "failure-request",
            traceId: "failure-trace",
            auditId: "failure-audit",
          },
        }),
    });
    const result = await invoke(f, ask, args);
    assert.equal(result.isError, true);
    for (const text of [failure.code, "failure-request", "failure-trace", "failure-audit"])
      assert.ok(JSON.stringify(result).includes(text));
    assert.equal(count(f, "weknora_ask"), 1);
  });

for (const [label, payload] of [
  [
    "wrong library citation",
    { ...answer(), references: [{ knowledgeBaseId: "unauthorized-library" }] },
  ],
  ["missing reference ownership", { ...answer(), references: [{}] }],
  ["incomplete answer", { ...answer(), status: "PARTIAL" }],
  ["missing citations", { status: "COMPLETED", answer: "incomplete" }],
])
  test(`knowledge rejects ${label} with a traceable response-contract error`, async (t) => {
    const f = await fixture(t, {
      handler: (_wire, _init, reply) =>
        reply({
          structuredContent: {
            success: true,
            code: "SUCCESS",
            requestId: "contract-request",
            result: payload,
          },
        }),
    });
    const result = await invoke(f, ask, args);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /GEA_KNOWLEDGE_RESULT_INVALID/);
    assert.match(JSON.stringify(result), /contract-request/);
    assert.equal(count(f, "weknora_ask"), 1);
    f.setHandler(undefined);
    assert.equal((await f.execute(queryTool, query)).isError, false);
    f.setHandler((_wire, _init, reply) => reply({ structuredContent: answer() }));
    assert.deepEqual(successful(await invoke(f, ask, args)), answer());
  });

test("ambiguous business text does not merge answers or fabricate citations", async (t) => {
  const f = await fixture(t, {
    handler: (_wire, _init, reply) =>
      reply({
        content: [1, 2].map(() => ({
          type: "text",
          text: JSON.stringify(answer()),
        })),
      }),
  });
  assert.equal((await invoke(f, ask, args)).isError, true);
  assert.equal(count(f, "weknora_ask"), 1);
});

for (const status of [404, 429, 503])
  test(`HTTP ${status} never replays a knowledge ask even with a transport Session`, async (t) => {
    const f = await fixture(t, {
      transportSession: "transport-session",
      handler: () => new Response(null, { status, headers: { "Retry-After": "1" } }),
    });
    assert.equal((await invoke(f, ask, args)).isError, true);
    assert.equal(count(f, "weknora_ask"), 1);
    assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 1);
  });

test("knowledge timeout is not retried and does not clear login", async (t) => {
  const f = await fixture(t, {
    timeoutMs: 30,
    handler: (_wire, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  // Node's timeout signal is unref'ed; keep the fixture alive until it reports the timeout.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal((await invoke(f, ask, args)).isError, true);
    assert.equal(count(f, "weknora_ask"), 1);
    assert.equal(f.business.status().authenticated, true);
  } finally {
    clearInterval(keepAlive);
  }
});

for (const transition of ["preset", "resource", "identity", "cancel"])
  test(`late knowledge answers cannot publish after ${transition} changes`, async (t) => {
    let release, entered;
    const started = new Promise((done) => {
      entered = done;
    });
    const f = await fixture(t, {
      handler: async (_wire, _init, reply) => {
        entered();
        await new Promise((done) => {
          release = done;
        });
        return reply({ structuredContent: answer() });
      },
    });
    const controller = new AbortController();
    const pending = invoke(f, ask, args, "sales", controller.signal);
    await started;
    if (transition === "preset") f.agents.get("sales").preset = "standard";
    if (transition === "resource") f.setEnabled(false);
    if (transition === "identity") f.business.logout({});
    if (transition === "cancel") controller.abort(Error("fixture-user-cancel"));
    release();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /有依据的完整答案|依据片段/);
    assert.equal(count(f, "weknora_ask"), 1);
  });

test("forged knowledge source and retired LightRAG tools cannot register", async (t) => {
  const f = await currentMcp(t, {
    extraTools: [
      ...tools.map((tool) => ({
        ...tool,
        _meta: { sourceType: "MCP", sourceCode: "forged-knowledge" },
      })),
      {
        name: "lightrag_query",
        description: "retired",
        inputSchema: askSchema,
        _meta: { sourceType: "MCP", sourceCode: "retired" },
      },
    ],
  });
  assert.equal(f.ctx.tools.get(ask), undefined);
  assert.equal(f.ctx.tools.get(catalog), undefined);
  assert.equal(f.ctx.tools.get("mcp__gea-gateway__lightrag_query"), undefined);
  assert.equal((await f.execute(queryTool, query)).isError, false);
});

test("production prompt guards allow knowledge calls, preserve long citations without a business call budget", async (t) => {
  const payload = { ...answer(), answer: "完整知识答案。".repeat(1600) };
  const f = await fixture(t, {
    prompts: true,
    handler: (_wire, _init, reply) => reply({ structuredContent: payload }),
  });
  assert.ok(f.ctx.tools.schemas(f.agents.get("sales")).some((tool) => tool.name === ask));
  assert.deepEqual(successful(await invoke(f, ask, args)), payload);
  // Knowledge is governed by the same budget as all other business methods.
  for (let i = 1; i < 64; i++) await invoke(f, ask, args);
  const exhausted = await invoke(f, ask, args);
  assert.equal(exhausted.isError, false);
  assert.ok(count(f, "weknora_ask") === 65);
});

for (const [label, body] of [
  ["duplicate IDs", [library("same"), library("same")]],
  ["missing actions", [{ id: "missing-actions", name: "库" }]],
  ["not a catalog", { rows: [] }],
])
  test(`invalid catalog ${label} fails without guessing an authorized library`, async (t) => {
    const f = await fixture(t, {
      handler: (_wire, _init, reply) => reply({ structuredContent: body }),
    });
    const result = await invoke(f, catalog, {});
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /GEA_KNOWLEDGE_RESULT_INVALID/);
    assert.equal(count(f, "weknora_ask"), 0);
  });

test("switching to another enabled business Agent rejects the previous Consumer's late answer", async (t) => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = await fixture(t, {
    dealer: true,
    handler: async (_wire, _init, reply) => {
      entered();
      await new Promise((done) => {
        release = done;
      });
      return reply({ structuredContent: answer() });
    },
  });
  const pending = invoke(f, ask, args);
  await started;
  f.agents.get("sales").preset = "gea-html-inventory-dealer";
  release();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /GEA_MCP_EXECUTION_OWNER_CHANGED/);
  assert.doesNotMatch(JSON.stringify(result), /有依据的完整答案|依据片段/);
  assert.equal(count(f, "weknora_ask"), 1);
});

test("current personal Agent exposes knowledge tools under its retained Consumer and source lifetime", async (t) => {
  const f = await fixture(t, { personal: true, prompts: true });
  const names = f.ctx.tools.schemas(f.agents.get("personal")).map((tool) => tool.name);
  assert.ok(names.includes(catalog));
  assert.ok(names.includes(ask));
  const assembled = await f.ctx.systemPrompt.assemble({
    scope: f.agents.get("personal"),
    agent: f.agents.get("personal"),
    signal: new AbortController().signal,
  });
  assert.ok(!assembled.sections.some((section) => section.name.startsWith("gea:")));
  assert.deepEqual(successful(await invoke(f, catalog, {}, "personal")), [
    library("current-library"),
  ]);
  assert.deepEqual(successful(await invoke(f, ask, args, "personal")), answer());
  const calls = f.calls.filter(({ wire }) => wire.method === "tools/call");
  assert.ok(calls.every(({ wire }) => wire.params._meta.agentCode === "sales_forecast"));
  assert.ok(!names.includes("gea_plugin_page_apply"));
  f.setEnabled(false);
  const refused = await invoke(f, ask, args, "personal");
  assert.equal(refused.isError, true);
  assert.equal(count(f, "weknora_ask"), 1);
});

test("personal Agent diagnostics report retained Consumer and revoked source without business grants", async (t) => {
  const f = await fixture(t, { personal: true, prompts: true });
  const diagnose = async () => successful(await invoke(f, "gea_runtime_diagnose", {}, "personal"));
  const active = await diagnose();
  assert.equal(active.consumerCode, "sales_forecast");
  assert.deepEqual(active.mcpAccess, {
    sourceRef: "gea-readonly",
    consumerCode: "sales_forecast",
  });
  assert.equal(active.businessProfileDeclared, false);
  assert.equal(active.businessAuthorization, "not-checked");
  f.setEnabled(false);
  const revoked = await diagnose();
  assert.equal(revoked.consumerCode, null);
  assert.deepEqual(revoked.mcpAccess, { error: "GEA_CUBE_SOURCE_UNAVAILABLE" });
  assert.equal(revoked.businessAuthorization, "not-checked");
});

test("knowledge answer exposes HTTP trace separately from business identifiers and credentials", async (t) => {
  const payload = {
    ...answer(),
    requestId: "business-request",
    usage: { total: 9007199254740994 },
  };
  const f = await fixture(t, {
    handler: (_wire, _init, reply) =>
      reply(
        { structuredContent: payload },
        {
          "x-request-id": "gateway-request",
          "x-trace-id": "gateway-trace",
          "x-audit-id": "gateway-audit",
          "mcp-session-id": "private-mcp-session",
          "x-access-token": "private-access-token",
          "set-cookie": "private-cookie",
          authorization: "Bearer private-authorization",
        },
      ),
  });
  const result = successful(await invoke(f, ask, args));
  assert.deepEqual(result, {
    ...payload,
    gatewayTrace: {
      requestId: "gateway-request",
      traceId: "gateway-trace",
      auditId: "gateway-audit",
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /private-|authorization|cookie/i);
  assert.equal(count(f, "weknora_ask"), 1);
});

for (const failure of [
  "incomplete",
  "tool-error",
  "http-error",
  "protocol-error",
  "mismatched-reply",
  "malformed-json",
])
  test(`knowledge ${failure} retains gateway trace and never retries`, async (t) => {
    const f = await fixture(t, {
      handler: (_wire, _init, reply) => {
        const headers = { "x-request-id": "failed-request", "x-audit-id": "failed-audit" };
        if (failure === "http-error") return new Response(null, { status: 503, headers });
        if (failure === "protocol-error")
          return Response.json(
            {
              jsonrpc: "2.0",
              id: _wire.id,
              error: { code: -32603, message: "upstream protocol failure" },
            },
            { headers },
          );
        if (failure === "mismatched-reply")
          return Response.json({ jsonrpc: "2.0", id: "wrong-id", result: {} }, { headers });
        if (failure === "malformed-json") return new Response("invalid json", { headers });
        return reply(
          failure === "tool-error"
            ? {
                isError: true,
                structuredContent: { code: "KNOWLEDGE_FAILED", message: "upstream failed" },
              }
            : { structuredContent: { ...answer(), status: "PARTIAL" } },
          headers,
        );
      },
    });
    const result = await invoke(f, ask, args);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /gateway.requestId=failed-request/);
    assert.match(JSON.stringify(result), /gateway.auditId=failed-audit/);
    assert.equal(count(f, "weknora_ask"), 1);
  });

test("personal knowledge calls remain available beyond former turn limits", async (t) => {
  const f = await fixture(t, {
    personal: true,
    prompts: true,
    handler: (_wire, _init, reply) => reply({ structuredContent: answer() }),
  });
  for (let i = 0; i < 64; i++)
    assert.equal((await invoke(f, ask, args, "personal")).isError, false);
  const refused = await invoke(f, ask, args, "personal");
  assert.equal(refused.isError, false);
  assert.equal(count(f, "weknora_ask"), 65);
  f.ctx.emit("session/event", { id: "personal" }, { type: "turn/start" });
  assert.equal((await invoke(f, ask, args, "personal")).isError, false);
  assert.equal(count(f, "weknora_ask"), 66);
});

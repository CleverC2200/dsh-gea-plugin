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
const delivered = (payload = answer()) => {
  const body = payload.result ?? payload;
  const result = {
    ...body,
    geaCompletion: {
      status: "UNKNOWN",
      reason: "SERVER_COMPLETION_UNVERIFIED",
      message: "尚未取得可验证的生成结束依据，正文和引用的完成度未知，不能报告完整成功。",
    },
  };
  return payload.result ? { ...payload, result } : result;
};
const invoke = (f, tool, input, id = "sales", signal) => f.execute(tool, input, id, signal);
const count = (f, name) =>
  f.calls.filter(({ wire }) => wire.method === "tools/call" && wire.params.name === name).length;
async function fixture(t, options = {}) {
  const { handler, catalogHandler, ...settings } = options;
  return currentMcp(t, {
    extraTools: tools,
    readyTool: ask,
    ...settings,
    handler: (wire, init, reply) => {
      if (wire.params?.name === "weknora_list_knowledge_bases")
        return catalogHandler
          ? catalogHandler(wire, init, reply)
          : reply({ structuredContent: [library("current-library")] });
      return handler
        ? handler(wire, init, reply)
        : reply({
            structuredContent: answer(wire.params.arguments.knowledgeBaseIds),
          });
    },
  });
}
const successful = (result) => {
  assert.equal(result.isError, false, JSON.stringify(result));
  return JSON.parse(result.value);
};

test("managed orchestration discovers knowledge without a page and preserves Workbench authorization", async (t) => {
  const f = await fixture(t, { orchestration: true, prompts: true });
  const state = successful(await invoke(f, "gea_runtime_diagnose", {}, "orchestration"));
  assert.equal(state.preset, "auto-negotiation");
  assert.equal(state.businessProfileDeclared, false);
  assert.equal(state.pageBound, false);
  assert.equal(state.consumerCode, "workbench");
  assert.equal(state.businessAuthorization, "not-checked");
  assert.deepEqual(state.independentQuery, { available: true, pageRequired: false });
  assert.deepEqual(successful(await invoke(f, catalog, {}, "orchestration")), [
    library("current-library"),
  ]);
  assert.deepEqual(successful(await invoke(f, ask, args, "orchestration")), delivered());
  const refused = await invoke(f, ask, args, "ordinary");
  assert.equal(refused.isError, true);
  const sent = f.calls.filter(({ wire }) => wire.method === "tools/call");
  assert.equal(sent.length, 3);
  assert.ok(sent.every(({ wire }) => wire.params._meta.agentCode === "workbench"));
  f.setHandler((wire, _init, reply) =>
    wire.params.name === "weknora_list_knowledge_bases"
      ? reply({ structuredContent: [library("current-library")] })
      : Response.json({
          jsonrpc: "2.0",
          id: wire.id,
          error: { code: -32000, message: "AGENT_ACCESS_DENIED" },
        }),
  );
  const denied = await invoke(f, ask, args, "orchestration");
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /AGENT_ACCESS_DENIED/);
  assert.equal(count(f, "weknora_ask"), 2);
  f.setEnabled(false);
  const beforeRevokedCall = f.calls.length;
  assert.equal((await invoke(f, catalog, {}, "orchestration")).isError, true);
  assert.equal(f.calls.length, beforeRevokedCall);
});

test("Manage exposes actual knowledge schemas and a dynamic ASK catalog for the calling Agent", async (t) => {
  let revision = 1;
  const f = await fixture(t, {
    dealer: true,
    catalogHandler: (wire, _init, reply) =>
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
  assert.deepEqual(successful(await invoke(f, ask, args)), delivered());
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
    assert.deepEqual(successful(await invoke(f, ask, args)), delivered(payload));
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
  const f = await fixture(t, {
    catalogHandler: (_wire, _init, reply) =>
      reply({
        structuredContent: [library("library-a"), library("library-b")],
      }),
  });
  const multiple = {
    query: "请比较授权库甲和乙中的完整规则。",
    knowledgeBaseIds: ["library-a", "library-b"],
  };
  assert.deepEqual(
    successful(await invoke(f, ask, multiple)),
    delivered(answer(multiple.knowledgeBaseIds)),
  );
  assert.equal(count(f, "weknora_list_knowledge_bases"), 1);
});

test("empty authorized catalog is an explicit empty result", async (t) => {
  const f = await fixture(t, {
    catalogHandler: (_wire, _init, reply) => reply({ content: [{ type: "text", text: "[]" }] }),
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
    f.setHandler((wire, _init, reply) =>
      reply({
        structuredContent:
          wire.params.name === "weknora_list_knowledge_bases"
            ? [library("current-library")]
            : answer(),
      }),
    );
    assert.deepEqual(successful(await invoke(f, ask, args)), delivered());
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
  assert.deepEqual(successful(await invoke(f, ask, args)), delivered(payload));
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
      catalogHandler: (_wire, _init, reply) => reply({ structuredContent: body }),
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

test("current personal Agent exposes knowledge tools under shared workbench and its own source lifetime", async (t) => {
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
  assert.deepEqual(successful(await invoke(f, ask, args, "personal")), delivered());
  const calls = f.calls.filter(({ wire }) => wire.method === "tools/call");
  assert.ok(calls.every(({ wire }) => wire.params._meta.agentCode === "workbench"));
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
  assert.equal(active.consumerCode, "workbench");
  assert.deepEqual(active.mcpAccess, {
    sourceRef: "gea-readonly",
    consumerCode: "workbench",
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
    ...delivered(payload),
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
        const headers = {
          "x-request-id": "failed-request",
          "x-audit-id": "failed-audit",
        };
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
                structuredContent: {
                  code: "KNOWLEDGE_FAILED",
                  message: "upstream failed",
                },
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

test("each ask checks the current ASK catalog without replacing stale IDs or reconnecting a healthy transport", async (t) => {
  let libraries = [library("current-library")];
  const f = await fixture(t, {
    catalogHandler: (_wire, _init, reply) => reply({ structuredContent: libraries }),
  });
  successful(await invoke(f, ask, args));
  libraries = [
    {
      ...library("replacement-library"),
      name: library("current-library").name,
    },
  ];
  const stale = await invoke(f, ask, args);
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /GEA_KNOWLEDGE_SELECTION_REQUIRED/);
  assert.match(JSON.stringify(stale), /replacement-library/);
  assert.equal(count(f, "weknora_ask"), 1);
  assert.equal(count(f, "weknora_list_knowledge_bases"), 2);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 1);
  successful(
    await invoke(f, ask, {
      ...args,
      knowledgeBaseIds: ["replacement-library"],
    }),
  );
  assert.equal(count(f, "weknora_ask"), 2);
  assert.deepEqual(
    f.calls.filter(({ wire }) => wire.params?.name === "weknora_ask").at(-1).wire.params.arguments
      .knowledgeBaseIds,
    ["replacement-library"],
  );
});

test("a failed knowledge connection is discarded without replay and a late failure preserves the replacement", async (t) => {
  let release, entered;
  let requests = 0;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = await fixture(t, {
    transportSession: "transport-session",
    handler: async (_wire, _init, reply) => {
      requests++;
      if (requests === 1) {
        entered();
        await new Promise((done) => {
          release = done;
        });
        return new Response(null, { status: 404 });
      }
      if (requests === 2) return new Response(null, { status: 404 });
      return reply({ structuredContent: answer() });
    },
  });
  const late = invoke(f, ask, args);
  await started;
  assert.equal((await invoke(f, ask, args)).isError, true);
  successful(await invoke(f, ask, args));
  assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 2);
  release();
  assert.equal((await late).isError, true);
  successful(await invoke(f, ask, args));
  assert.equal(count(f, "weknora_ask"), 4);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 2);
  assert.equal(f.business.status().authenticated, true);
});

test("non-2xx knowledge errors retain bounded business diagnostics separately from gateway trace", async (t) => {
  const f = await fixture(t, {
    handler: () =>
      Response.json(
        {
          success: false,
          code: "AI_KNOWLEDGE_BASE_NOT_FOUND",
          message: "知识库当前不可用，请重新选择。",
          retryable: false,
          requestId: "business-request",
          traceId: "business-trace",
          auditId: "business-audit",
          details: { delegationToken: "private-delegation" },
        },
        { status: 404, headers: { "x-request-id": "gateway-request" } },
      ),
  });
  const result = await invoke(f, ask, args);
  assert.equal(result.isError, true);
  const text = JSON.stringify(result);
  for (const value of [
    "HTTP 404",
    "AI_KNOWLEDGE_BASE_NOT_FOUND",
    "知识库当前不可用",
    "business-request",
    "business-trace",
    "business-audit",
    "gateway.requestId=gateway-request",
  ])
    assert.ok(text.includes(value), text);
  assert.doesNotMatch(text, /private-delegation|重新登录/);
  assert.equal(count(f, "weknora_ask"), 1);
});

test("legacy COMPLETED content keeps its answer and citations with GEA completion explicitly unknown", async (t) => {
  const f = await fixture(t);
  const value = successful(await invoke(f, ask, args));
  assert.deepEqual(value.geaCompletion, {
    status: "UNKNOWN",
    reason: "SERVER_COMPLETION_UNVERIFIED",
    message: "尚未取得可验证的生成结束依据，正文和引用的完成度未知，不能报告完整成功。",
  });
  assert.equal(value.status, "COMPLETED");
  assert.equal(value.answer, answer().answer);
  assert.deepEqual(value.references, answer().references);
});

for (const catalogState of [
  "empty",
  "unavailable",
  "revoked",
  "identity",
  "preset",
  "cancel",
  "invalid-target",
])
  test(`ask stops before send when the current catalog is ${catalogState}`, async (t) => {
    const controller = new AbortController();
    const f = await fixture(t, {
      catalogHandler: (_wire, _init, reply) => {
        if (catalogState === "unavailable") return new Response(null, { status: 503 });
        if (catalogState === "revoked") f.setEnabled(false);
        if (catalogState === "identity") f.business.logout({});
        if (catalogState === "preset") f.agents.get("sales").preset = "standard";
        if (catalogState === "cancel") controller.abort(Error("user-cancel-before-ask"));
        return reply({
          structuredContent: catalogState === "empty" ? [] : [library("current-library")],
        });
      },
    });
    const result = await invoke(
      f,
      ask,
      catalogState === "invalid-target"
        ? { ...args, knowledgeBaseIds: ["current-library", "retired-library"] }
        : args,
      "sales",
      controller.signal,
    );
    assert.equal(result.isError, true);
    assert.equal(count(f, "weknora_ask"), 0);
    assert.equal(count(f, "weknora_list_knowledge_bases"), 1);
  });

for (const body of [
  "<html>private-token</html>",
  JSON.stringify({
    success: false,
    code: "UPSTREAM_FAILED",
    message: "Bearer private-token",
  }),
  JSON.stringify({
    success: false,
    code: "UPSTREAM_FAILED",
    message: "private".repeat(12000),
  }),
])
  test("unsafe or oversized HTTP failure bodies use the bounded HTTP fallback", async (t) => {
    const f = await fixture(t, {
      handler: () =>
        new Response(body, {
          status: 503,
          headers: { "x-trace-id": "fallback-trace" },
        }),
    });
    const result = await invoke(f, ask, args);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /GEA_MCP_HTTP_503/);
    assert.match(JSON.stringify(result), /fallback-trace/);
    assert.doesNotMatch(JSON.stringify(result), /private|UPSTREAM_FAILED|重新登录/);
    assert.equal(count(f, "weknora_ask"), 1);
  });

test("explicit resource rejection preserves the business failure and a healthy connection", async (t) => {
  let rejected = true;
  const f = await fixture(t, {
    handler: (_wire, _init, reply) =>
      rejected
        ? Response.json(
            {
              success: false,
              code: "AI_KNOWLEDGE_BASE_NOT_FOUND",
              message: "知识库不存在",
            },
            { status: 404 },
          )
        : reply({ structuredContent: answer() }),
  });
  const result = await invoke(f, ask, args);
  assert.match(JSON.stringify(result), /AI_KNOWLEDGE_BASE_NOT_FOUND/);
  rejected = false;
  successful(await invoke(f, ask, args));
  assert.equal(count(f, "weknora_ask"), 2);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 1);
});

test("expired knowledge connections retain HTTP and business trace and recover on the next explicit turn", async (t) => {
  const f = await fixture(t, {
    prompts: true,
    handler: () =>
      Response.json(
        {
          success: false,
          code: "AI_GATEWAY_SESSION_EXPIRED",
          message: "会话失效",
          requestId: "business-expired-request",
        },
        { status: 410, headers: { "x-trace-id": "gateway-expired-trace" } },
      ),
  });
  const result = await invoke(f, ask, args);
  assert.equal(result.isError, true);
  for (const text of [
    "HTTP 410",
    "business-expired-request",
    "gateway.traceId=gateway-expired-trace",
  ])
    assert.ok(JSON.stringify(result).includes(text), JSON.stringify(result));
  f.setHandler((wire, _init, reply) =>
    reply({
      structuredContent:
        wire.params.name === "weknora_list_knowledge_bases"
          ? [library("current-library")]
          : answer(),
    }),
  );
  f.business.clearTurnStops("sales");
  successful(await invoke(f, ask, args));
  assert.equal(count(f, "weknora_ask"), 2);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 2);
});

for (const [label, retry, expected, absent] of [
  ["HTTP 429 default with header wait", {}, ["允许明确重试", "等待60秒"], []],
  [
    "body wait takes precedence",
    { retryable: true, retryAfterMs: 2500 },
    ["允许明确重试", "等待3秒"],
    ["等待60秒"],
  ],
  [
    "explicit business retry denial",
    { retryable: false },
    ["服务端明确标记不可重试", "等待60秒"],
    ["允许明确重试"],
  ],
])
  test(`structured knowledge rate limits expose ${label} through Core Tools`, async (t) => {
    const f = await fixture(t, {
      handler: () =>
        Response.json(
          {
            success: false,
            code: "AI_GATEWAY_RATE_LIMITED",
            message: "请求过多，请降低并发",
            requestId: "business-rate-request",
            ...retry,
          },
          { status: 429, headers: { "Retry-After": "60", "x-trace-id": "gateway-rate-trace" } },
        ),
    });
    const result = await invoke(f, ask, args);
    assert.equal(result.isError, true);
    const message = result.error.message;
    for (const text of [
      "HTTP 429",
      "限流",
      "AI_GATEWAY_RATE_LIMITED",
      "请求过多，请降低并发",
      "business-rate-request",
      "gateway.traceId=gateway-rate-trace",
      "不自动重试",
      ...expected,
    ])
      assert.ok(message.includes(text), message);
    for (const text of absent) assert.ok(!message.includes(text), message);
    assert.equal(count(f, "weknora_ask"), 1);
    assert.equal(f.business.status().authenticated, true);
    f.setHandler((wire, _init, reply) =>
      reply({
        structuredContent:
          wire.params.name === "weknora_list_knowledge_bases"
            ? [library("current-library")]
            : answer(),
      }),
    );
    successful(await invoke(f, ask, args));
    assert.equal(count(f, "weknora_ask"), 2);
    assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, 1);
  });

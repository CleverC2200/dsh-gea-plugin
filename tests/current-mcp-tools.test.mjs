import test from "node:test";
import assert from "node:assert/strict";
import {
  currentMcp,
  queryTool,
  inspectTool,
  query,
  rawResult,
  serverSchema,
} from "./fixtures/current-mcp.mjs";

test("current registered MCP tools retain server schemas and exact direct results", async (t) => {
  const f = await currentMcp(t);
  assert.deepEqual(
    f.ctx.tools.schemas(f.agents.get("sales")).find((tool) => tool.name === queryTool).parameters,
    serverSchema,
  );
  const result = await f.execute();
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value, rawResult);
  assert.deepEqual(
    f.calls.find(({ wire }) => wire.method === "tools/call").wire.params.arguments,
    query,
  );
  assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 1);
  assert.equal(
    f.calls.some(({ wire }) => wire.method === "resources/read"),
    false,
  );
  for (const old of ["gea_gateway_catalog", "gea_cube_query", "gea_module_mcp"])
    assert.equal(f.ctx.tools.get(old), undefined);
  assert.ok(f.ctx.tools.get(inspectTool));
});

test("registered direct pages preserve partial, unknown and zero facts and read the next page with unchanged filters", async (t) => {
  const f = await currentMcp(t);
  const first = await f.execute();
  assert.equal(first.isError, false);
  assert.match(first.value, /9007199254740993\.1234/);
  const page = JSON.parse(first.value).datasets[0];
  assert.equal(page.dataStatus, "partial");
  assert.equal(page.rows[0]["inventory.unknown"], null);
  assert.equal(page.rows[0]["inventory.zero"], 0);
  assert.equal(page.rows[0]["inventory.code"], "001");
  assert.equal(page.hasMorePages, true);
  const next = structuredClone(query);
  next.queries[0].query.offset = 1;
  f.setHandler((wire, _init, reply) =>
    reply({
      structuredContent: {
        action: "query",
        status: "completed",
        executedQueryCount: 1,
        datasets: [
          {
            name: "inventory",
            rowCount: 1,
            dataStatus: "ok",
            totalRowCount: 2,
            offset: 1,
            hasMorePages: false,
            fields: [{ name: "inventory.qty" }],
            rows: [{ "inventory.qty": "0.0000" }],
          },
        ],
      },
    }),
  );
  const second = await f.execute(queryTool, next);
  assert.equal(second.isError, false, JSON.stringify(second));
  assert.equal(JSON.parse(second.value).datasets[0].hasMorePages, false);
  assert.equal(JSON.parse(second.value).datasets[0].rows[0]["inventory.qty"], "0.0000");
  const sent = f.calls.filter(({ wire }) => wire.method === "tools/call");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].wire.params.arguments, query);
  assert.deepEqual(sent[1].wire.params.arguments, next);
  assert.equal(
    f.calls.some(({ wire }) => wire.method === "resources/read"),
    false,
  );
});

test("registered inspect refreshes the current authorized server schema without a legacy resource catalog", async (t) => {
  const f = await currentMcp(t);
  const before = f.calls.filter(({ wire }) => wire.method === "initialize").length;
  const result = await f.execute(inspectTool, { keyword: "inventory" });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.value), {
    semanticModel: [{ name: "inventory", measures: [{ name: "inventory.qty" }] }],
  });
  assert.equal(f.calls.filter(({ wire }) => wire.method === "initialize").length, before + 1);
  assert.deepEqual(f.calls.find(({ wire }) => wire.method === "tools/call").wire.params.arguments, {
    keyword: "inventory",
  });
});

test("registered tools reject ordinary or missing callers and disabled business resources before external execution", async (t) => {
  const f = await currentMcp(t);
  const before = f.calls.length;
  for (const id of ["ordinary", "missing"]) {
    const result = await f.execute(queryTool, query, id);
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result),
      /business Agent|业务 Agent|BUSINESS_PROFILE_REQUIRED|TOOL_NOT_FOUND/,
    );
  }
  f.setEnabled(false);
  const disabled = await f.execute();
  assert.equal(disabled.isError, true);
  assert.match(JSON.stringify(disabled), /RESOURCE_DISABLED/);
  assert.equal(f.calls.length, before);
  f.setEnabled(true);
  assert.equal((await f.execute()).isError, false);
});

test("registered tools reject caller supplied Consumer and routing without dispatch", async (t) => {
  const f = await currentMcp(t, { schema: { ...serverSchema, additionalProperties: true } });
  const before = f.calls.length;
  for (const field of ["consumerCode", "agentCode", "sessionId", "mcpCode", "tenantId", "_meta"]) {
    const result = await f.execute(queryTool, { ...query, [field]: "forged" });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /PLATFORM_ARGUMENT_REJECTED/);
  }
  assert.equal(f.calls.length, before);
});

for (const failure of [
  {
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    category: "AUTHORIZATION",
    suggestedAction: "CONFIGURE_DATA_GRANTS",
    details: {
      reasonCode: "RESOURCE_ALLOW_MISSING",
      resourceCode: "inventory-cube",
      decisionId: "fixture-decision",
    },
    message: "授权资源未允许",
  },
  { code: "AI_GATEWAY_AUDIT_UNAVAILABLE", category: "AUDIT", message: "审计服务不可用" },
  {
    code: "AI_GATEWAY_RATE_LIMITED",
    category: "RATE_LIMIT",
    retryAfterMs: 2000,
    retryable: true,
    message: "请稍后再试",
  },
  { code: "AI_GATEWAY_MCP_RESULT_TOO_LARGE", retryable: true, message: "结果过大" },
]) {
  test(`registered query preserves ${failure.code} without returning data or retrying`, async (t) => {
    const f = await currentMcp(t, {
      handler: (_wire, _init, reply) =>
        reply({
          isError: true,
          structuredContent: {
            success: false,
            businessCode: failure.code,
            requestId: "fixture-request",
            traceId: "fixture-trace",
            ...failure,
          },
        }),
    });
    const result = await f.execute();
    assert.equal(result.isError, true);
    const text = JSON.stringify(result);
    assert.match(text, new RegExp(failure.code));
    assert.match(text, /fixture-request/);
    assert.match(text, /fixture-trace/);
    assert.doesNotMatch(text, /fixture-private|9007199254740993/);
    if (failure.code === "AI_GATEWAY_MCP_RESULT_TOO_LARGE")
      assert.match(text, /缩小查询.*分页|减少返回列/);
    assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 1);
  });
}

test("member publication failure stops the calling turn and a new turn can query again", async (t) => {
  const f = await currentMcp(t, {
    handler: (_wire, _init, reply) =>
      reply({
        isError: true,
        structuredContent: {
          success: false,
          code: "DATA_QUERY_MEMBER_NOT_PUBLISHED",
          message: "成员尚未发布",
        },
      }),
  });
  const failed = await f.execute();
  assert.equal(failed.isError, true);
  assert.match(JSON.stringify(failed), /DATA_QUERY_MEMBER_NOT_PUBLISHED/);
  assert.match(JSON.stringify(await f.execute()), /TURN_STOPPED/);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 1);
  f.business.clearTurnStops("sales");
  f.setHandler(undefined);
  assert.equal((await f.execute()).isError, false);
});

for (const transition of ["preset", "resource", "identity"]) {
  test(`registered late query cannot publish after ${transition} changes`, async (t) => {
    let release, entered;
    const started = new Promise((done) => {
      entered = done;
    });
    const f = await currentMcp(t, {
      handler: async (_wire, _init, reply) => {
        entered();
        await new Promise((done) => {
          release = done;
        });
        return reply({ structuredContent: JSON.parse(rawResult) });
      },
    });
    const pending = f.execute();
    await started;
    if (transition === "preset") f.agents.get("sales").preset = "standard";
    if (transition === "resource") f.setEnabled(false);
    if (transition === "identity") f.business.logout({});
    release();
    const result = await pending;
    assert.equal(result.isError, true);
    assert.doesNotMatch(JSON.stringify(result), /9007199254740993|inventory\.unknown/);
    assert.match(
      JSON.stringify(result),
      {
        preset: /GEA_BUSINESS_PROFILE_REQUIRED/,
        resource: /GEA_AGENT_RESOURCE_DISABLED/,
        identity: /operation was aborted/,
      }[transition],
    );
  });
}

test("registered cancellation preserves the current identity and allows the next query without spending a failure budget", async (t) => {
  let entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = await currentMcp(t, {
    handler: async (_wire, init) => {
      entered();
      await new Promise((_resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    },
  });
  const controller = new AbortController();
  const pending = f.execute(queryTool, query, "sales", controller.signal);
  await started;
  controller.abort(Error("fixture-user-cancel"));
  const result = await pending;
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /9007199254740993/);
  assert.equal(f.business.status().authenticated, true);
  assert.equal(f.business.turnStopped("sales"), undefined);
  f.setHandler(undefined);
  assert.equal((await f.execute()).isError, false);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 2);
});

test("registered expired gateway preserves the failure and stops the turn until a new session is negotiated", async (t) => {
  const f = await currentMcp(t, {
    handler: (_wire, _init, reply) =>
      reply({
        isError: true,
        structuredContent: {
          success: false,
          code: "AI_GATEWAY_SESSION_EXPIRED",
          requestId: "00000000-0000-4000-8000-000000000001",
          message: "会话已过期",
        },
      }),
  });
  const first = await f.execute();
  assert.equal(first.isError, true);
  assert.match(JSON.stringify(first), /GEA_GATEWAY_SESSION_EXPIRED/);
  assert.match(JSON.stringify(first), /00000000-0000-4000-8000-000000000001/);
  assert.match(JSON.stringify(await f.execute()), /TURN_STOPPED/);
  const sessions = f.calls.filter(({ url }) => url.endsWith("/session")).length;
  f.setHandler(undefined);
  f.business.clearTurnStops("sales");
  assert.equal((await f.execute()).isError, false);
  assert.equal(f.calls.filter(({ url }) => url.endsWith("/session")).length, sessions + 1);
});

test("registered malformed data stops subsequent queries without a retry or a fabricated empty result", async (t) => {
  const f = await currentMcp(t, {
    handler: (_wire, _init, reply) =>
      reply({
        structuredContent: {
          action: "query",
          executedQueryCount: 1,
          datasets: [{ name: "inventory", rows: [] }],
        },
      }),
  });
  const result = await f.execute();
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /GEA_CUBE_NEW_/);
  assert.match(JSON.stringify(await f.execute()), /TURN_STOPPED/);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 1);
});

test("registered no_data retains an explicit empty dataset without converting missing values into zero", async (t) => {
  const empty = {
    action: "query",
    status: "completed",
    executedQueryCount: 1,
    datasets: [
      {
        name: "inventory",
        rowCount: 0,
        dataStatus: "no_data",
        totalRowCount: 0,
        offset: 0,
        hasMorePages: false,
        fields: [{ name: "inventory.qty" }],
        rows: [],
      },
    ],
  };
  const f = await currentMcp(t, {
    handler: (_wire, _init, reply) => reply({ structuredContent: empty }),
  });
  const result = await f.execute();
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.value), empty);
  assert.equal(f.calls.filter(({ wire }) => wire.method === "tools/call").length, 1);
});

test("registered qualified-member guard rejects bare members and forwards valid month and ordering unchanged", async (t) => {
  const f = await currentMcp(t);
  const before = f.calls.length;
  const invalid = structuredClone(query);
  invalid.queries[0].query.measures = ["qty"];
  const rejected = await f.execute(queryTool, invalid);
  assert.equal(rejected.isError, true);
  assert.match(JSON.stringify(rejected), /MEMBER_REQUIRED/);
  assert.equal(f.calls.length, before);
  const args = structuredClone(query);
  args.queries[0].query.filters = [
    { member: "inventory.month", operator: "equals", values: ["2026-08"] },
  ];
  const result = await f.execute(queryTool, args);
  assert.equal(result.isError, false);
  assert.deepEqual(
    f.calls.find(({ wire }) => wire.method === "tools/call").wire.params.arguments,
    args,
  );
  assert.deepEqual(args.queries[0].query.order, { "inventory.qty": "desc" });
});

test("one Host derives independent sales and dealer Consumers from their current business Sessions", async (t) => {
  const f = await currentMcp(t, { dealer: true });
  const sales = await f.execute();
  const dealer = await f.execute(queryTool, query, "dealer");
  assert.equal(sales.isError, false, JSON.stringify(sales));
  assert.equal(dealer.isError, false, JSON.stringify(dealer));
  const calls = f.calls.filter(({ wire }) => wire.method === "tools/call");
  assert.deepEqual(
    calls.map(({ wire }) => wire.params._meta.agentCode),
    ["sales_forecast", "dealer-inventory-replenishment"],
  );
  assert.ok(calls.every(({ wire }) => !Object.hasOwn(wire.params.arguments, "consumerCode")));
});

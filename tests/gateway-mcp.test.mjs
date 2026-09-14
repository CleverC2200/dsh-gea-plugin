import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["src/gateway-mcp.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { prepareGatewayMcp } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);
const consumer = { consumerType: "AGENT", consumerCode: "test-agent" };
const auth = { token: "login-secret", tenantId: "0" };
const session = () => ({
  success: true,
  result: {
    accessDecision: { allowed: true },
    gatewayContext: {
      ...consumer,
      sessionId: "business-session",
      conversationId: "conversation",
    },
    delegationToken: "delegation-secret",
  },
});

test("creates authorized session and isolates trusted meta from business arguments", async () => {
  const controller = new AbortController();
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (
      !url.endsWith("/session") &&
      JSON.parse(init.body).method === "tools/list"
    )
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [
            {
              name: "read",
              _meta: { sourceType: "MCP", sourceCode: "read-service" },
            },
          ],
        },
      });
    return url.endsWith("/session")
      ? Response.json(session())
      : Response.json({ ok: true });
  };
  const connection = await prepareGatewayMcp(
    "https://gea.test",
    auth,
    consumer,
    controller.signal,
    1000,
    fake,
  );
  assert.equal(calls[0].init.headers["X-Access-Token"], "login-secret");
  const create = JSON.parse(calls[0].init.body);
  assert.equal(create.consumerCode, "test-agent");
  assert.equal(create.tenantId, undefined);
  assert.ok(!JSON.stringify(connection).includes("secret"));
  await connection.fetch(connection.url, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await connection.fetch(connection.url, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "read",
        arguments: { query: "x" },
        _meta: { sessionId: "forged", delegationToken: "forged" },
      },
    }),
  });
  const wire = JSON.parse(calls[2].init.body);
  assert.deepEqual(wire.params.arguments, { query: "x" });
  assert.deepEqual(wire.params._meta, {
    sessionId: "business-session",
    conversationId: "conversation",
    delegationToken: "delegation-secret",
    agentCode: "test-agent",
    mcpCode: "read-service",
  });
  assert.ok(!JSON.stringify(calls[2]).includes("login-secret"));
  assert.equal(calls[2].init.redirect, "error");
  await assert.rejects(
    () => connection.fetch("https://foreign.test", {}),
    /ENDPOINT_REJECTED/,
  );
  controller.abort();
  await assert.rejects(() => connection.fetch(connection.url, {}));
  assert.equal(calls.length, 3);
});

test("rejects denied, incomplete and wrong-consumer sessions despite HTTP success", async () => {
  for (const mutate of [
    (p) => (p.result.accessDecision.allowed = false),
    (p) => (p.result.delegationToken = ""),
    (p) => (p.result.gatewayContext.conversationId = ""),
    (p) => (p.result.gatewayContext.consumerCode = "other"),
    (p) => (p.success = false),
  ]) {
    const payload = session();
    mutate(payload);
    await assert.rejects(
      () =>
        prepareGatewayMcp(
          "https://gea.test",
          auth,
          consumer,
          new AbortController().signal,
          1000,
          async () => Response.json(payload),
        ),
      /SESSION_REJECTED/,
    );
  }
});

test("discovery gets the complete authorization context; init remains protocol-only", async () => {
  const messages = [];
  const connection = await prepareGatewayMcp(
    "https://gea.test",
    auth,
    { consumerType: "CLIENT_APP", consumerCode: "client" },
    new AbortController().signal,
    1000,
    async (url, init) => {
      if (url.endsWith("/session")) {
        const p = session();
        Object.assign(p.result.gatewayContext, {
          consumerType: "CLIENT_APP",
          consumerCode: "client",
        });
        return Response.json(p);
      }
      messages.push(JSON.parse(init.body));
      return Response.json({});
    },
  );
  for (const method of [
    "initialize",
    "tools/list",
    "resources/list",
    "resources/read",
  ])
    await connection.fetch(connection.url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
    });
  assert.equal(messages[0].params._meta, undefined);
  for (const message of messages.slice(1)) {
    assert.equal(message.params._meta.delegationToken, "delegation-secret");
    assert.equal(message.params._meta.agentCode, undefined);
  }
});

test("late session responses cannot survive identity invalidation", async () => {
  const controller = new AbortController();
  await assert.rejects(() =>
    prepareGatewayMcp(
      "https://gea.test",
      auth,
      consumer,
      controller.signal,
      1000,
      async () => {
        controller.abort();
        return Response.json(session());
      },
    ),
  );
});

test("Business login notifications and transport capabilities follow logout and environment changes", async () => {
  const { createRequire } = await import("node:module");
  const compiled = await build({
    entryPoints: ["src/business.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
  });
  const module = { exports: {} };
  new Function(
    "require",
    "module",
    "exports",
    Buffer.from(compiled.outputFiles[0].contents).toString(),
  )(createRequire(import.meta.url), module, module.exports);
  const { Business } = module.exports;
  const business = new Business({
    geaEnvironments: {
      production: "https://gea.test",
      test: "https://test.gea.test",
    },
    requestTimeoutMs: 1000,
    analysisAgentCode: "test-agent",
  });
  const original = globalThis.fetch;
  let notifications = 0;
  const unwatch = business.watchIdentity(() => notifications++);
  globalThis.fetch = async (url) => {
    if (url.includes("/getLoginQrcode"))
      return Response.json({ success: true, result: { qrcodeId: "qr" } });
    if (url.includes("/getQrcodeToken"))
      return Response.json({
        success: true,
        result: { success: true, token: "login-secret" },
      });
    if (url.includes("/getUserInfo"))
      return Response.json({
        success: true,
        result: { userInfo: { id: "user", username: "user", tenantId: "0", avatar: "https://avatar.test/user.png" } },
      });
    if (url.endsWith("/session")) return Response.json(session());
    return Response.json({});
  };
  try {
    await assert.rejects(
      () => business.openMcpConnection(consumer, new AbortController().signal),
      /LOGIN_REQUIRED/,
    );
    const qr = await business.loginStart(new AbortController().signal);
    await business.loginPoll(
      { loginId: qr.loginId },
      new AbortController().signal,
    );
    assert.equal(business.status().authenticated, true);
    assert.equal(business.status().user.avatar, "https://avatar.test/user.png");
    assert.equal(notifications, 2);
    const connection = await business.openMcpConnection(
      consumer,
      new AbortController().signal,
    );
    business.logout({});
    assert.equal(notifications, 3);
    await assert.rejects(() => connection.fetch(connection.url, {}));
    business.selectEnvironment({ environment: "test" });
    assert.equal(notifications, 4);
    unwatch();
    business.logout({});
    assert.equal(notifications, 4);
  } finally {
    business.dispose();
    globalThis.fetch = original;
  }
});

test("routes discovered gateway and remote tools without trusting caller metadata", async () => {
  const wires = [];
  const fake = async (url, init) => {
    if (url.endsWith("/session")) return Response.json(session());
    const wire = JSON.parse(init.body);
    wires.push(wire);
    if (wire.method === "tools/list")
      return Response.json({
        jsonrpc: "2.0",
        id: wire.id,
        result: {
          tools: [
            {
              name: "gateway.session.currentUser.resolve",
              _meta: { sourceType: "MCP", sourceCode: "mcp.gateway.session" },
            },
            {
              name: "lightrag_list_docs",
              _meta: { sourceType: "MCP", sourceCode: "knowledge" },
            },
          ],
        },
      });
    const expected =
      wire.params.name === "lightrag_list_docs"
        ? "knowledge"
        : "mcp.gateway.session";
    assert.equal(wire.params._meta.mcpCode, expected);
    assert.equal(wire.params._meta.delegationToken, "delegation-secret");
    assert.deepEqual(wire.params.arguments, {});
    return Response.json({
      jsonrpc: "2.0",
      id: wire.id,
      result: { content: [] },
    });
  };
  const connection = await prepareGatewayMcp(
    "https://gea.test",
    auth,
    consumer,
    new AbortController().signal,
    1000,
    fake,
  );
  const send = (method, params) =>
    connection.fetch(connection.url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  await send("tools/list", {});
  for (const name of [
    "gateway.session.currentUser.resolve",
    "lightrag_list_docs",
  ])
    await send("tools/call", {
      name,
      arguments: {},
      _meta: { mcpCode: "forged", delegationToken: "forged" },
    });
});

test("SSE discovery preserves response, pagination accumulates routes and refresh removes stale tools", async () => {
  let tools = [{ name: "first", _meta: { sourceCode: "one" } }];
  const sent = [];
  let body;
  const connection = await prepareGatewayMcp(
    "https://gea.test",
    auth,
    consumer,
    new AbortController().signal,
    1000,
    async (url, init) => {
      if (url.endsWith("/session")) return Response.json(session());
      const wire = JSON.parse(init.body);
      sent.push(wire);
      if (wire.method !== "tools/list")
        return Response.json({
          jsonrpc: "2.0",
          id: wire.id,
          result: { content: [] },
        });
      body =
        ": heartbeat\n\nevent: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: { tools } }) +
        "\n\n";
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  );
  const send = (method, params = {}) =>
    connection.fetch(connection.url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
    });
  assert.equal(await (await send("tools/list")).text(), body);
  tools = [{ name: "second", _meta: { sourceCode: "two" } }];
  await send("tools/list", { cursor: "next" });
  for (const name of ["first", "second"])
    await send("tools/call", { name, arguments: {} });
  assert.deepEqual(
    sent.slice(-2).map((x) => x.params._meta.mcpCode),
    ["one", "two"],
  );
  await send("tools/list");
  await assert.rejects(
    () => send("tools/call", { name: "first", _meta: { mcpCode: "one" } }),
    /ROUTE_REQUIRED/,
  );
  tools = [
    { name: "second", _meta: { sourceCode: "two" } },
    { name: "second", _meta: { sourceCode: "other" } },
  ];
  await assert.rejects(() => send("tools/list"), /ROUTE_AMBIGUOUS/);
  tools = [{ name: "invalid" }];
  await assert.rejects(() => send("tools/list"), /ROUTE_INVALID/);
});

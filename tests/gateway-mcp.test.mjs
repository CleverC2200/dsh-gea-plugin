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
  const wire = JSON.parse(calls[1].init.body);
  assert.deepEqual(wire.params.arguments, { query: "x" });
  assert.deepEqual(wire.params._meta, {
    sessionId: "business-session",
    conversationId: "conversation",
    delegationToken: "delegation-secret",
    agentCode: "test-agent",
  });
  assert.ok(!JSON.stringify(calls[1]).includes("login-secret"));
  assert.equal(calls[1].init.redirect, "error");
  await assert.rejects(
    () => connection.fetch("https://foreign.test", {}),
    /ENDPOINT_REJECTED/,
  );
  controller.abort();
  await assert.rejects(() => connection.fetch(connection.url, {}));
  assert.equal(calls.length, 2);
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
        result: { userInfo: { id: "user", username: "user", tenantId: "0" } },
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

test("local Skill file URI is rejected before gateway IO with the correct reader guidance", async () => {
  const messages = [];
  const connection = await prepareGatewayMcp(
    "https://gea.test",
    auth,
    consumer,
    new AbortController().signal,
    1000,
    async (url, init) => {
      if (url.endsWith("/session")) return Response.json(session());
      messages.push(JSON.parse(init.body));
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32002, message: "Resource URI 不合法" },
      });
    },
  );
  await assert.rejects(
    () =>
      connection.fetch(connection.url, {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "file:///suite/references/rules-and-conflicts.md" },
        }),
      }),
    /gea_skill_reference_read/,
  );
  assert.equal(messages.length, 0);
  const uri = "data-artifact://gateway/returned-artifact";
  await connection.fetch(connection.url, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/read",
      params: { uri },
    }),
  });
  assert.equal(messages[0].params.uri, uri);
  assert.equal(messages[0].params._meta.sessionId, "business-session");
});

test("SDK calls recover an expired transport session once, including concurrent calls", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  let generation = 0, expired = false, initialized = false;
  const calls = [];
  const connection = await prepareGatewayMcp("https://gea.test", auth, consumer,
    new AbortController().signal, 1000, async (url, init) => {
      if (url.endsWith("/session")) return Response.json(session());
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const message = JSON.parse(init.body);
      if (message.method === "initialize") {
        generation++; expired = false; initialized = false;
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: message.params.protocolVersion, capabilities: { tools: {} },
          serverInfo: { name: "test", version: "1" },
        } }, { headers: { "MCP-Session-Id": "transport-" + generation } });
      }
      if (expired || new Headers(init.headers).get("MCP-Session-Id") !== "transport-" + generation)
        return new Response(null, { status: 404 });
      if (message.method === "notifications/initialized") {
        initialized = true;
        return new Response(null, { status: 202 });
      }
      assert.equal(initialized, true);
      assert.equal(message.params._meta.delegationToken, "delegation-secret");
      calls.push(message.params.name);
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } });
    });
  const client = new Client({ name: "regression", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(connection.url), { fetch: connection.fetch });
  await client.connect(transport);
  try {
    expired = true;
    const results = await Promise.all(["first", "second"].map(name => client.callTool({ name, arguments: {} })));
    assert.equal(results.length, 2);
    await client.callTool({ name: "third", arguments: {} });
    assert.equal(generation, 2, "concurrent failures share one initialization");
    assert.deepEqual(calls.sort(), ["first", "second", "third"]);
  } finally { await client.close(); }
});

test("HTTP failures preserve their status, do not leak bodies and have bounded retries", async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    let attempts = 0, initializations = 0;
    const connection = await prepareGatewayMcp("https://gea.test", auth, consumer,
      new AbortController().signal, 1000, async (url, init) => {
        if (url.endsWith("/session")) return Response.json(session());
        const message = JSON.parse(init.body);
        if (message.method === "initialize") {
          initializations++;
          return Response.json({ result: { protocolVersion: "2025-11-25" } },
            { headers: { "MCP-Session-Id": "session-" + initializations } });
        }
        if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
        attempts++;
        return new Response("upstream-secret", { status });
      });
    const headers = { "MCP-Protocol-Version": "2025-11-25" };
    await connection.fetch(connection.url, { method: "POST", headers,
      body: JSON.stringify({ method: "initialize" }) });
    await assert.rejects(() => connection.fetch(connection.url, { method: "POST", headers,
      body: JSON.stringify({ method: "tools/call", params: { name: "read" } }) }),
    error => error.message.includes(`GEA_MCP_HTTP_${status}`) && !error.message.includes("upstream-secret"));
    assert.equal(attempts, status === 404 ? 2 : 1);
    assert.equal(initializations, status === 404 ? 2 : 1);
  }
});

test("logout during transport recovery prevents replay", async () => {
  const controller = new AbortController();
  let initializations = 0, calls = 0;
  const connection = await prepareGatewayMcp("https://gea.test", auth, consumer,
    controller.signal, 1000, async (url, init) => {
      if (url.endsWith("/session")) return Response.json(session());
      if (JSON.parse(init.body).method === "initialize") {
        if (++initializations === 2) controller.abort();
        return Response.json({ result: { protocolVersion: "2025-11-25" } },
          { headers: { "MCP-Session-Id": "transport" } });
      }
      calls++;
      return new Response(null, { status: 404 });
    });
  const headers = { "MCP-Protocol-Version": "2025-11-25" };
  await connection.fetch(connection.url, { method: "POST", headers, body: JSON.stringify({ method: "initialize" }) });
  await assert.rejects(() => connection.fetch(connection.url, { method: "POST", headers,
    body: JSON.stringify({ method: "tools/call", params: { name: "read" } }) }), { name: "AbortError" });
  assert.equal(calls, 1);
});

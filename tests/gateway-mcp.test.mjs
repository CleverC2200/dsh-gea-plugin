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

import test from "node:test";
import assert from "node:assert/strict";
import { prepareGatewayLaunch } from "../src/host/html-gateway.ts";
import { prepareGatewayMcp } from "../src/host/gateway-mcp.ts";
const consumer = { consumerType: "AGENT", consumerCode: "test-agent" };
const auth = { token: "login-secret", tenantId: "0" };
const payload = () => ({
  success: true,
  result: {
    accessDecision: { allowed: true },
    gatewayContext: {
      ...consumer,
      sessionId: "session",
      conversationId: "conversation",
    },
    delegationToken: "delegation-secret",
  },
});
const entries = [prepareGatewayLaunch, prepareGatewayMcp];
const run = (entry, response, signal = new AbortController().signal) =>
  entry("https://gateway.invalid", auth, consumer, signal, 1000, async () =>
    Response.json(response),
  );

test("both gateway entries preserve other denial code and message as a non-retryable permission result", async () => {
  for (const entry of entries) {
    const denied = payload();
    denied.result.accessDecision = {
      allowed: false,
      code: "TENANT_ACCESS_DENIED",
      message: "租户未授权",
    };
    await assert.rejects(run(entry, denied), {
      code: "AGENT_ACCESS_DENIED",
      accessDecisionCode: "TENANT_ACCESS_DENIED",
      retryable: false,
      message: "AGENT_ACCESS_DENIED: 租户未授权",
    });
  }
});

test("both entries accept the same Consumer and keep login credentials in the Host handshake", async () => {
  for (const entry of entries) {
    const calls = [];
    const result = await entry(
      "https://gateway.invalid",
      auth,
      consumer,
      new AbortController().signal,
      1000,
      async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(
          String(url).endsWith("/session")
            ? payload()
            : { jsonrpc: "2.0", id: 1, result: { tools: [] } },
        );
      },
    );
    const created = JSON.parse(calls[0].init.body);
    assert.equal(created.consumerCode, "test-agent");
    assert.equal(calls[0].init.headers["X-Access-Token"], "login-secret");
    assert.ok(!JSON.stringify(created).includes("secret"));
    if (entry === prepareGatewayLaunch)
      assert.deepEqual(result, {
        sessionId: "session",
        conversationId: "conversation",
        delegationToken: "delegation-secret",
        agentCode: "test-agent",
      });
    else {
      assert.ok(!JSON.stringify(result).includes("secret"));
      await result.fetch(result.url, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.ok(!JSON.stringify(calls[1]).includes("login-secret"));
      assert.equal(JSON.parse(calls[1].init.body).params._meta.sessionId, "session");
    }
  }
});

test("both entries preserve explicit denial codes and reject mismatched or incomplete sessions", async () => {
  for (const entry of entries) {
    const denied = payload();
    denied.result.accessDecision = {
      allowed: false,
      code: "AGENT_ACCESS_DENIED",
      message: "Agent权限不足",
    };
    await assert.rejects(run(entry, denied), {
      code: "AGENT_ACCESS_DENIED",
      accessDecisionCode: "AGENT_ACCESS_DENIED",
      retryable: false,
      message: "AGENT_ACCESS_DENIED: Agent权限不足",
    });
    for (const mutate of [
      (p) => (p.result.gatewayContext.consumerCode = "wrong"),
      (p) => (p.result.gatewayContext.consumerType = "CLIENT_APP"),
      (p) => (p.result.delegationToken = ""),
      (p) => (p.success = false),
    ]) {
      const rejected = payload();
      mutate(rejected);
      await assert.rejects(run(entry, rejected), /GEA_MCP_SESSION_REJECTED/);
    }
  }
});

test("both entries discard an allowed late response after identity revocation", async () => {
  for (const entry of entries) {
    const identity = new AbortController();
    await assert.rejects(
      entry("https://gateway.invalid", auth, consumer, identity.signal, 1000, async () => {
        identity.abort(new Error("identity revoked"));
        return Response.json(payload());
      }),
      /identity revoked/,
    );
  }
});

test("both entries preserve HTTP and invalid JSON failure facts", async () => {
  for (const entry of entries) {
    await assert.rejects(
      entry(
        "https://gateway.invalid",
        auth,
        consumer,
        new AbortController().signal,
        1000,
        async () => new Response("denied", { status: 403 }),
      ),
      /GEA_MCP_SESSION_HTTP_403/,
    );
    await assert.rejects(
      entry(
        "https://gateway.invalid",
        auth,
        consumer,
        new AbortController().signal,
        1000,
        async () => new Response("{broken"),
      ),
      SyntaxError,
    );
  }
});

test("order handshake retries a reset once with the original request identity", async () => {
  const { prepareGatewaySession } = await import("../src/host/gateway-session.ts");
  const calls = [];
  const response = payload();
  response.result.gatewayContext.consumerCode = "order";
  await prepareGatewaySession(
    "https://gateway.invalid",
    auth,
    { consumerType: "AGENT", consumerCode: "order" },
    new AbortController().signal,
    1000,
    async (url, init) => {
      calls.push(init.body);
      if (calls.length === 1)
        throw new Error("captured", {
          cause: new TypeError("fetch failed", {
            cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
          }),
        });
      return Response.json(response);
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
});
test("order handshake never retries cancellation, other Consumers or a second reset", async () => {
  const { prepareGatewaySession } = await import("../src/host/gateway-session.ts");
  for (const mode of ["cancel", "other", "twice"]) {
    const controller = new AbortController();
    let calls = 0;
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    await assert.rejects(
      prepareGatewaySession(
        "https://gateway.invalid",
        auth,
        { consumerType: "AGENT", consumerCode: mode === "other" ? "test-agent" : "order" },
        controller.signal,
        1000,
        async () => {
          calls++;
          if (mode === "cancel") controller.abort();
          throw reset;
        },
      ),
    );
    assert.equal(calls, mode === "twice" ? 2 : 1);
  }
});

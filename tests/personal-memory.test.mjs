import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { PersonalMemoryGateway } from "../src/host/memory-service.ts";
const scope = { environment: "production", tenantId: "10", userId: "alice" };
const state = {
  scope,
  generationEnabled: false,
  revision: 0,
  bankGeneration: 0,
  count: 0,
  updatedAt: null,
};
async function fixture(t, handler) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const result = await handler(req, JSON.parse(raw));
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body ?? { success: true, result: state }));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const epoch = new AbortController();
  let expired = 0;
  const gateway = new PersonalMemoryGateway("http://127.0.0.1:" + server.address().port, {
    allowPrivateHttp: true,
    timeoutMs: 2000,
    identity: () => ({ token: "host-secret", scope, signal: epoch.signal }),
    expire: () => {
      expired++;
    },
    fetch,
  });
  return { gateway, epoch, expired: () => expired };
}
test("Host forwards only owned credentials to fixed gateway and accepts scoped state", async (t) => {
  const { gateway } = await fixture(t, (req, body) => {
    assert.equal(req.url, "/v1/memory/state");
    assert.deepEqual(body, {});
    assert.equal(req.headers["x-access-token"], "host-secret");
    assert.equal(req.headers["x-gea-environment"], "production");
    return {
      body: {
        success: true,
        result: {
          ...state,
          backendKey: "never-client",
          scope: { ...scope, token: "never-client" },
        },
      },
    };
  });
  assert.deepEqual(await gateway.state(new AbortController().signal), state);
});

test("Host rejects cross-scope result and backend failures never expire GEA", async (t) => {
  const { gateway, expired } = await fixture(t, () => ({
    body: {
      success: true,
      result: { ...state, scope: { ...scope, userId: "bob" } },
    },
  }));
  await assert.rejects(gateway.state(new AbortController().signal), /MEMORY_SCOPE_MISMATCH/);
  assert.equal(expired(), 0);
  const backend = await fixture(t, () => ({
    status: 503,
    body: { success: false, errorCode: "MEMORY_BACKEND_UNAVAILABLE" },
  }));
  await assert.rejects(
    backend.gateway.state(new AbortController().signal),
    /MEMORY_BACKEND_UNAVAILABLE/,
  );
  assert.equal(backend.expired(), 0);
});
test("late invalid-login response cannot expire a replacement identity", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { gateway, epoch, expired } = await fixture(t, async () => {
    await gate;
    return {
      status: 401,
      body: { success: false, errorCode: "MEMORY_UNAUTHENTICATED" },
    };
  });
  const pending = gateway.state(new AbortController().signal);
  epoch.abort();
  release();
  await assert.rejects(pending, /STALE_SELECTION/);
  assert.equal(expired(), 0);
});

test("only a current, verified GEA invalid-login response expires identity", async (t) => {
  const current = await fixture(t, () => ({
    status: 401,
    body: { success: false, errorCode: "MEMORY_UNAUTHENTICATED" },
  }));
  await assert.rejects(
    current.gateway.state(new AbortController().signal),
    /MEMORY_UNAUTHENTICATED/,
  );
  assert.equal(current.expired(), 1);
  const backend = await fixture(t, () => ({
    status: 401,
    body: { success: false, errorCode: "MEMORY_BACKEND_UNAVAILABLE" },
  }));
  await assert.rejects(
    backend.gateway.state(new AbortController().signal),
    /MEMORY_BACKEND_UNAVAILABLE/,
  );
  assert.equal(backend.expired(), 0);
});

test("private HTTP deployment input requires boolean authorization and a fixed origin", async () => {
  const { resolveMemoryGatewayUrl } = await import("../src/shared/memory-gateway.js");
  assert.equal(
    resolveMemoryGatewayUrl("http://100.100.1.228:1934", true),
    "http://100.100.1.228:1934",
  );
  for (const value of [
    "http://100.100.1.228:1934",
    "http://public.example:1934",
    "http://127.0.0.1:1934?",
    "https://memory.example/#",
    "https://memory.example/path",
  ]) {
    assert.throws(() => resolveMemoryGatewayUrl(value, false), /INVALID_MEMORY_GATEWAY_URL/);
  }
  assert.throws(
    () => resolveMemoryGatewayUrl("http://100.100.1.228:1934", "true"),
    /INVALID_MEMORY_GATEWAY_ALLOW_PRIVATE_HTTP/,
  );
});

test("Host authorizes a current memory source using a durable trusted session binding", async (t) => {
  const { createGeaMemoryService } = await import("../src/host/memory-service.ts");
  const { MemorySessionLedger } = await import("../src/host/memory-session-ledger.ts");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = await mkdtemp(join(tmpdir(), "memory-scope-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  let current = scope;
  const epoch = new AbortController();
  const item = {
    id: "memory-1",
    source: { sessionId: "session-1", messageId: "message-1", time: "now" },
  };
  const business = {
    memory: {
      state: async () => ({ ...state, scope: current }),
      get: async () => ({ scope: current, item }),
    },
    identitySignal: () => epoch.signal,
    status: () => ({ authenticated: true }),
    watchIdentity: () => () => {},
  };
  let inspections = 0;
  let messages = [{ type: "user/message", data: { id: "message-1", source: { kind: "user" } } }];
  const sessions = {
    inspect: async () => {
      inspections++;
      return {
        meta: { id: "session-1" },
        events: messages,
      };
    },
  };
  const service = () =>
    createGeaMemoryService(business, {
      ledger: new MemorySessionLedger(path),
      sessions,
    });
  const signal = new AbortController().signal;
  await assert.rejects(service().source("memory-1", signal), /MEMORY_SOURCE_UNAVAILABLE/);
  assert.equal(inspections, 0);
  await service().bindSession("session-1", signal);
  assert.deepEqual(await service().source("memory-1", signal), {
    scope,
    sessionId: "session-1",
  });
  messages = [];
  await assert.rejects(service().source("memory-1", signal), /MEMORY_SOURCE_UNAVAILABLE/);
  current = { ...scope, userId: "bob" };
  const before = inspections;
  await assert.rejects(service().source("memory-1", signal), /MEMORY_SOURCE_UNAVAILABLE/);
  await assert.rejects(service().bindSession("session-1", signal), /MEMORY_SESSION_SCOPE_MISMATCH/);
  assert.equal(inspections, before);
  await writeFile(join(path, "personal-memory-sessions.json"), "broken-json");
  current = scope;
  await assert.rejects(service().source("memory-1", signal), /MEMORY_SESSION_LEDGER_UNAVAILABLE/);
});

test("Host deletion and clear preserve versioned requests and scoped pending cleanup receipts", async (t) => {
  const calls = [];
  const { gateway } = await fixture(t, (req, body) => {
    calls.push({ endpoint: req.url, body });
    return {
      body: {
        success: true,
        result: {
          scope,
          operationId: body.operationId,
          status: "unknown",
          state: {
            ...state,
            revision: 2,
            pendingCleanup: {
              operationId: body.operationId,
              kind: req.url.endsWith("/delete") ? "delete" : "clear",
            },
          },
        },
      },
    };
  });
  const signal = new AbortController().signal;
  const deletion = {
    operationId: "delete-host-memory",
    id: "logical-memory",
    expectedVersion: 2,
    expectedRevision: 1,
    bankGeneration: 0,
  };
  const clear = {
    operationId: "clear-host-memory",
    expectedRevision: 2,
    bankGeneration: 0,
    confirmation: "清空",
  };
  assert.equal((await gateway.delete(deletion, signal)).state.pendingCleanup.kind, "delete");
  assert.equal((await gateway.clear(clear, signal)).state.pendingCleanup.kind, "clear");
  assert.deepEqual(calls, [
    { endpoint: "/v1/memory/delete", body: deletion },
    { endpoint: "/v1/memory/clear", body: clear },
  ]);
});

test("a transport that ignores abort cannot use an old 401 to expire the replacement account", async () => {
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const epoch = new AbortController();
  let expired = 0;
  const gateway = new PersonalMemoryGateway("https://memory.invalid", {
    timeoutMs: 2000,
    identity: () => ({ token: "old-token", scope, signal: epoch.signal }),
    expire: () => {
      expired++;
    },
    fetch: async () => {
      started();
      await gate;
      return Response.json(
        { success: false, errorCode: "MEMORY_UNAUTHENTICATED" },
        { status: 401 },
      );
    },
  });
  const pending = gateway.state(new AbortController().signal);
  await ready;
  epoch.abort();
  release();
  await assert.rejects(pending, /STALE_SELECTION/);
  assert.equal(expired, 0);
});

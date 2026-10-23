import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, Config } from "../lib/host.js";

async function host(t, readonlyValidation) {
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-catalog-rpc-"));
  const base = "https://catalog.fixture.invalid/gea";
  await writeFile(
    join(runtimeDir, "web-login.json"),
    JSON.stringify({
      schema: 1,
      environment: "production",
      base,
      auth: {
        token: "rpc-fixture-token",
        tenantId: "7",
        id: "user-1",
        name: "User",
        username: "user",
      },
    }),
  );
  const routes = new Map(),
    disposers = [];
  const dispose = () => {};
  t.after(async () => {
    for (const stop of disposers.reverse()) await stop();
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const ctx = {
    get: () => undefined,
    effect(fn) {
      const stop = fn();
      if (typeof stop === "function") disposers.push(stop);
    },
    on: () => dispose,
    inject: () => dispose,
    provide: () => {},
    workbenchPages: { packages: () => [], registerBusinessPage: () => dispose },
    agentResources: { register: async () => dispose, watch: () => dispose },
    tools: { register: () => dispose, guard: () => dispose },
    agents: { list: () => [] },
    llm: { registerAdapter: () => Object.assign(() => {}, { replace: () => {} }) },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return dispose;
        },
      },
    },
  };
  await apply(
    ctx,
    Config({
      geaBaseUrl: base,
      runtimeDir,
      workbenchCapability: { enabled: false, readonlyValidation },
    }),
  );
  return async (endpoint, body = "{}") => {
    const route = routes.get("/api/gea-proof/" + endpoint);
    assert.ok(route, endpoint + " must be registered by the public Host entry");
    assert.deepEqual(route.methods, ["POST"]);
    const response = await route.fetch(
      new Request("https://host.fixture.invalid/api/gea-proof/" + endpoint, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      }),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    return response.json();
  };
}

test("public Host catalog RPC exposes the market projection and persists 401 identity invalidation", async (t) => {
  let expired = false;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, init });
    if (expired) return Response.json({ message: "登录已过期" }, { status: 401 });
    return Response.json({
      success: true,
      code: 200,
      result: url.endsWith("/market") ? [{ id: "agent", agentCode: "base-safety-stock" }] : [],
    });
  });
  const rpc = await host(t);
  const result = await rpc("navigation/catalog");
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    agents: [
      { id: "agent", agentCode: "base-safety-stock", agentName: null, businessDomain: null },
    ],
    domains: { kind: "available", items: [] },
  });
  assert.equal(
    (await rpc("navigation/catalog", '{"username":"another"}')).error.code,
    "INVALID_PAYLOAD",
  );
  assert.equal(requests.length, 2);
  expired = true;
  assert.equal((await rpc("navigation/catalog")).error.code, "GEA_HTTP_401");
  const status = await rpc("status");
  assert.equal(status.value.authenticated, false);
  assert.equal(status.value.loginState, "expired");
});

test("restricted Host denies catalog before parsing an invalid body or making external requests", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("unexpected external request");
  });
  const rpc = await host(t, {
    maxRequests: 0,
    periods: 0,
    list: 0,
    detail: 0,
    versionSkus: 0,
    workflowSql: 0,
    maxWorkflowRows: 1,
    metadata: 0,
  });
  assert.equal(
    (await rpc("navigation/catalog", "{invalid")).error.code,
    "GEA_SALES_READONLY_OPERATION",
  );
});

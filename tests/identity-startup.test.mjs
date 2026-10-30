import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { compiledSource } from "./fixtures/compiled-source.mjs";
import { fixtureEnvironment } from "./fixtures/business-session.mjs";
import { createBusinessIdentityReader } from "../src/business-identity-client.ts";

test("restored identity and account routes are ready while cold business resources are still initializing", async (t) => {
  fixtureEnvironment(t, {
    GEA_DESKTOP_CONTROL_URL: "http://127.0.0.1:19876",
    GEA_DESKTOP_CONTROL_TOKEN: "fixture-desktop-storage",
    GEA_WEB_LOGIN_PERSIST: "0",
    GEA_HTML_LOCAL_QUERY_CONFIG: "",
  });
  await mkdir(".runtime", { recursive: true });
  const runtime = await mkdtemp(resolve(".runtime/identity-startup-"));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  const { apply } = await compiledSource(t, {
    contents: "export {apply} from './src/host.ts';",
    source: process.cwd(),
    dependencies: resolve("node_modules"),
    url: resolve("src/host.ts"),
    parent: runtime,
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const routes = new Map(),
    cleanups = [];
  const restored = Promise.withResolvers(),
    resources = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const boundary = Error("fixture-resource-initialization-boundary");
  let effects = 0,
    storageWrites = 0;
  const ctx = {
    effect(setup) {
      if (effects++ === 0) return;
      const cleanup = setup();
      if (typeof cleanup === "function") cleanups.push(cleanup);
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    workbenchPages: { packages: () => [] },
    agentResources: {
      register: () => {
        entered.resolve();
        return resources.promise;
      },
    },
  };
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "http://127.0.0.1:19876/login") {
      if (options.method === "GET") return Response.json(await restored.promise);
      storageWrites++;
      return Response.json({});
    }
    if (String(url).endsWith("/aiportal/agent/market"))
      return Response.json({
        success: true,
        code: 200,
        result: [{ id: "allowed-agent", agentCode: "base-safety-stock" }],
      });
    if (String(url).endsWith("/sys/dict/getDictItems/business_domain"))
      return Response.json({ success: true, code: 200, result: [] });
    assert.equal(url, "/api/gea-html/identity");
    const route = routes.get(url);
    return route
      ? route.fetch(new Request("http://fixture.invalid" + url, options))
      : new Response(null, { status: 404 });
  };
  const starting = apply(ctx, {
    geaBaseUrl: "https://fixture.invalid/gea",
    environment: "production",
    runtimeDir: join(runtime, "gea"),
    requestTimeoutMs: 1000,
    pageSize: 10,
    periodPageSize: 10,
    maxSnapshotBytes: 10000,
    analysisMode: "receipt",
    analysisSource: "gea",
    analysisAgentCode: "sales_forecast",
    analysisModel: "receipt",
    inputByteBudget: 10000,
  });
  const settled = assert.rejects(starting, (error) => error === boundary);
  t.after(async () => {
    resources.reject(boundary);
    await settled;
    for (const cleanup of cleanups.reverse()) await cleanup();
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  await new Promise(setImmediate);
  assert.equal(
    routes.has("/api/gea-html/identity"),
    false,
    "do not publish signed-out before stored credentials finish restoring",
  );
  restored.resolve({
    schema: 1,
    environment: "production",
    base: "https://fixture.invalid/gea",
    auth: {
      token: "fixture-persisted-token",
      tenantId: "0",
      id: "fixture-user",
      username: "fixture-user",
      avatar: "",
      name: "Restored user",
    },
  });
  await entered.promise;
  const reader = createBusinessIdentityReader();
  const stop = reader.start();
  t.after(stop);
  await new Promise(setImmediate);
  t.mock.timers.tick(15000);
  await new Promise(setImmediate);
  assert.equal(
    reader.getSnapshot().state,
    "confirmed",
    "cold resource setup must not make the restored identity look unavailable",
  );
  assert.equal(reader.getSnapshot().error, undefined);
  assert.equal(reader.getSnapshot().status?.authenticated, true);
  assert.equal(reader.getSnapshot().status?.user?.name, "Restored user");
  for (const endpoint of [
    "navigation/catalog",
    "environment/select",
    "login/start",
    "login/poll",
    "logout",
  ])
    assert.ok(routes.has("/api/gea-proof/" + endpoint), endpoint);
  const catalog = await routes.get("/api/gea-proof/navigation/catalog").fetch(
    new Request("http://fixture.invalid/api/gea-proof/navigation/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  const catalogResult = await catalog.json();
  assert.equal(catalogResult.ok, true, JSON.stringify(catalogResult));
  assert.equal(
    catalogResult.value.agents[0].id,
    "allowed-agent",
    "the current account menu is readable before business resources finish",
  );
  assert.equal(JSON.stringify(catalogResult).includes("fixture-persisted-token"), false);
  assert.equal(storageWrites, 0, "startup observation must not change stored credentials");
});

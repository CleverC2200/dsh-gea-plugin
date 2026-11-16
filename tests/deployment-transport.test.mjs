import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolveEnvironments } from "../src/shared/environments.js";

const built = await build({
  stdin: {
    contents:
      "export { Business } from './src/host/business.ts'; export { DeploymentTransport } from './src/host/deployment-transport.ts'; export { createCapabilityRegistry } from './src/capability/registry.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { Business, DeploymentTransport, createCapabilityRegistry } = mod.exports;
const environments = {
  production: "https://production.fixture/gea",
  test: "https://test.fixture/gea",
};
function fixture(t, extra = {}) {
  const business = new Business({
    runtimeDir: tmpdir(),
    geaEnvironments: environments,
    requestTimeoutMs: 1000,
    ...extra,
  });
  const login = (environment) =>
    business.restoreDesktopLogin({
      schema: 1,
      environment,
      base: environments[environment],
      auth: {
        token: environment + "-token",
        tenantId: "0",
        id: "user",
        name: "User",
        username: "user",
      },
    });
  login("production");
  t.after(() => business.dispose());
  return { business, login };
}

test("Host blocks a known wrong-environment gateway before sending credentials", async (t) => {
  const { business } = fixture(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    business.fetchExternal(environments.test + "/sys/user/getUserInfo", {
      headers: { "X-Access-Token": "production-token" },
    }),
    /GEA_TARGET_ENVIRONMENT_MISMATCH/,
  );
  await assert.rejects(
    business.fetchExternal("https://unknown.fixture/leak", {
      headers: { "X-Access-Token": "production-token" },
    }),
    /GEA_TARGET_NOT_REGISTERED/,
  );
  assert.equal(calls, 0);
});

test("one shared memory deployment retains each login environment and identity", async (t) => {
  const { business, login } = fixture(t, { memoryGatewayUrl: "https://shared-memory.fixture" });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const headers = new Headers(init.headers),
      environment = headers.get("X-GEA-Environment");
    calls.push(String(url));
    assert.equal(headers.get("X-Access-Token"), environment + "-token");
    return Response.json({
      success: true,
      result: {
        scope: { environment, tenantId: "0", userId: "user" },
        generationEnabled: false,
        revision: 0,
        bankGeneration: 0,
        count: 0,
        updatedAt: null,
      },
    });
  });
  const signal = new AbortController().signal;
  assert.equal((await business.memory.state(signal)).scope.environment, "production");
  login("test");
  assert.equal((await business.memory.state(signal)).scope.environment, "test");
  assert.deepEqual(calls, [
    "https://shared-memory.fixture/v1/memory/state",
    "https://shared-memory.fixture/v1/memory/state",
  ]);
});

test("warning scheduler uses the registered deployment and original login environment", async (t) => {
  const target = "https://scheduler.fixture/client";
  const { business } = fixture(t, { warningSchedulerEnvironments: { production: target } });
  business.setCapabilities(
    createCapabilityRegistry([
      {
        id: "aps",
        label: "APS",
        enabled: true,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "APS" },
        data: { consumerCode: "aps", tables: [], rules: [] },
      },
    ]),
  );
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), target);
    assert.equal(new Headers(init.headers).get("X-GEA-Environment"), "production");
    assert.equal(new Headers(init.headers).get("X-Access-Token"), "production-token");
    return Response.json({ ok: true, value: { job: null } });
  });
  assert.deepEqual(
    await business.warningScheduler({ operation: "poll" }, new AbortController().signal),
    { job: null },
  );
});

test("changing login cancels an adapter that ignores abort and cannot publish its response", async (t) => {
  const { business, login } = fixture(t);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async () => {
    entered.resolve();
    await release.promise;
    return Response.json({ success: true });
  });
  const pending = business.fetchExternal(environments.production + "/sys/user/getUserInfo");
  await entered.promise;
  login("test");
  release.resolve();
  await assert.rejects(pending);
});

test("external model grants are credential-bound and expire with the identity epoch", async () => {
  const epoch = new AbortController();
  const transport = new DeploymentTransport(
    { environments },
    () => ({
      environment: "production",
      base: environments.production,
      signal: epoch.signal,
      identity: { id: "u", token: "gea", tenantId: "0" },
    }),
    async () => Response.json({ data: [] }),
  );
  transport.allowModel("https://model.fixture/v1", "model-secret");
  await assert.rejects(
    transport.fetch("https://model.fixture/v1/models", {
      headers: { Authorization: "Bearer gea" },
    }),
    /GEA_TARGET_IDENTITY_MISMATCH/,
  );
  const response = await transport.fetch("https://model.fixture/v1/models", {
    headers: { Authorization: "Bearer model-secret" },
  });
  await response.body.cancel();
  epoch.abort();
  await assert.rejects(
    transport.fetch("https://model.fixture/v1/models", {
      headers: { Authorization: "Bearer model-secret" },
    }),
  );
});

test("business environment mappings reject identical and known inverted authorities", () => {
  assert.throws(
    () =>
      resolveEnvironments({
        geaEnvironments: { production: "https://same.fixture", test: "https://same.fixture/" },
      }),
    /GEA_ENVIRONMENTS_NOT_DISTINCT/,
  );
  assert.throws(
    () =>
      resolveEnvironments({
        geaEnvironments: {
          production: "https://gea.synear.cn:4443/gea-boot",
          test: "https://gea.synear.cn/gea-boot",
        },
      }),
    /GEA_ENVIRONMENT_TARGET_MISMATCH/,
  );
});

test("custom DMS environment collisions are rejected before any signed or bearer request is sent", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({});
  });
  for (const testTarget of ["https://dms.fixture/base/", "https://dms.fixture/base/test"]) {
    const deployment = (gatewayUrl) => ({ gatewayUrl, secretEnv: "DMS_FIXTURE", users: [] });
    const { business, login } = fixture(t, {
      dms: { production: deployment("https://dms.fixture/base"), test: deployment(testTarget) },
    });
    login("test");
    await assert.rejects(
      business.fetchExternal(testTarget.replace(/\/$/, "") + "/dms/order/submit", {
        method: "POST",
        headers: { Authorization: "Bearer dms-fixture" },
      }),
      /DMS_ENVIRONMENTS_NOT_DISTINCT/,
    );
  }
  assert.equal(calls, 0);
});

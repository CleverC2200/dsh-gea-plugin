import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolveEnvironments } from "../src/shared/environments.js";
const built = await build({
  entryPoints: ["src/host/deployment-transport.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { DeploymentTransport } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64")
);
const environments = {
  production: "https://production.fixture/gea",
  test: "https://test.fixture/gea",
};
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

test("wrong-environment and unregistered destinations send no request on each platform", async () => {
  let calls = 0;
  const transport = new DeploymentTransport(
    { environments },
    () => ({
      environment: "production",
      base: environments.production,
      signal: new AbortController().signal,
      identity: { id: "u", token: "secret", tenantId: "0" },
    }),
    async () => {
      calls++;
      return Response.json({});
    },
  );
  for (const target of [environments.test + "/sales-plan/plans", "https://unknown.fixture/leak"])
    await assert.rejects(
      transport.fetch(target, { headers: { "X-Access-Token": "secret" } }),
      /GEA_TARGET_/,
    );
  assert.equal(calls, 0);
});

test("shared memory validates environment and credentials before forwarding", async () => {
  let environment = "production",
    calls = 0;
  const transport = new DeploymentTransport(
    { environments, memoryGatewayUrl: "https://memory.fixture" },
    () => ({
      environment,
      base: environments[environment],
      signal: new AbortController().signal,
      identity: { id: "u", token: environment + "-secret", tenantId: "0" },
    }),
    async (_url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).get("X-GEA-Environment"), environment);
      assert.equal(init.redirect, "error");
      return Response.json({});
    },
  );
  for (environment of ["production", "test"]) {
    const headers = {
      "X-GEA-Environment": environment,
      "X-Access-Token": environment + "-secret",
      "X-Tenant-Id": "0",
    };
    await (
      await transport.fetch("https://memory.fixture/v1/memory/state", { headers })
    ).body.cancel();
    await assert.rejects(
      transport.fetch("https://memory.fixture/v1/memory/state", {
        headers: {
          ...headers,
          "X-GEA-Environment": environment === "test" ? "production" : "test",
        },
      }),
      /GEA_TARGET_ENVIRONMENT_MISMATCH/,
    );
  }
  assert.equal(calls, 2);
});

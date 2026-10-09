import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployment, businessDeploymentPatch } from "../scripts/deployment.mjs";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {createCapabilityRegistry} from './src/capability/registry.ts'; export {workbenchContract} from './src/capability/contract.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  packages: "external",
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const { Business, createCapabilityRegistry, workbenchContract } = module.exports;
function fixture(t, config = {}) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    requests.push(String(input));
    throw Error("OFFLINE_CAPTURE: external request forbidden");
  });
  const business = new Business({
    geaBaseUrl: "https://fixture.invalid",
    analysisAgentCode: "sales_forecast",
    requestTimeoutMs: 1000,
    ...config,
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://fixture.invalid",
    auth: {
      token: "fixture-only",
      tenantId: "1",
      id: "fixture-user",
      name: "Fixture",
      username: "fixture",
    },
  });
  t.after(() => business.dispose());
  return { business, requests };
}

test("an explicitly empty installed consumer set never restores historical SQL access", async (t) => {
  const { business, requests } = fixture(t);
  business.setCapabilities(createCapabilityRegistry([]));
  await assert.rejects(
    business.pluginSql(
      { consumerCode: "base-safety-stock", sql: "SELECT 1" },
      new AbortController().signal,
    ),
    /GEA_PLUGIN_CONSUMER_NOT_ALLOWED/,
  );
  assert.deepEqual(requests, []);
});

test("disabled native capability refuses sales reads before credentials or external transport", async (t) => {
  const { business, requests } = fixture(t, {
    workbenchCapability: { enabled: false },
  });
  await assert.rejects(business.plans({}, new AbortController().signal), /GEA_CAPABILITY_DISABLED/);
  assert.deepEqual(requests, []);
});

test("disabled native contracts refuse direct sales, workflow, notification, model and MCP execution even without login", async (t) => {
  const { business, requests } = fixture(t, {
    workbenchCapability: { enabled: false },
  });
  business.logout({});
  const signal = new AbortController().signal;
  const attempts = [
    () => business.workbenchQuery({}, signal),
    () => business.agentQuery({}, signal),
    () => business.periods(signal),
    () => business.detail({}, signal),
    () => business.versions({}, signal),
    () => business.skus({}, signal),
    () => business.salesPlanDraft({}, signal),
    () => business.salesPlanSubmit({}, signal),
    () => business.salesPlanAction({}, signal),
    () => business.workflowConfig({}, signal),
    () => business.notifications({}, signal),
    () => business.resolveClientNavigation({}, signal),
    () => business.acknowledgeClientNavigation("old", "old", signal),
    () => business.prepareWorkbench({}, signal),
    () => business.modelRoute(signal, "sales_forecast"),
    () =>
      business.openMcpConnection({ consumerType: "AGENT", consumerCode: "sales_forecast" }, signal),
    () => business.pluginSql({ consumerCode: "sales_forecast", sql: "SELECT 1" }, signal),
    () => business.apiLogReplay({ id: "old", confirmed: true }, signal),
  ];
  for (const attempt of attempts)
    await assert.rejects(async () => attempt(), /GEA_CAPABILITY_DISABLED/);
  assert.deepEqual(requests, []);
});

test("mock and disabled installed capabilities cannot resolve delegated SQL, schema, MCP, launch or model credentials", async (t) => {
  const { business, requests } = fixture(t, {
    workbenchCapability: { enabled: false },
  });
  business.setCapabilities(
    createCapabilityRegistry([
      workbenchContract({
        surface: "gea-workbench",
        pageIds: ["gea-workbench"],
        enabled: false,
      }),
      {
        id: "stock",
        label: "Stock",
        enabled: false,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "Stock" },
        data: { consumerCode: "base-safety-stock", tables: [], rules: [] },
      },
      {
        id: "aps",
        label: "APS mock",
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "Mock" },
        view: {
          surface: "gea-html-aps",
          protocol: "self-report",
          pageIds: ["aps"],
        },
        data: { consumerCode: "aps", tables: [], rules: [], mock: true },
      },
    ]),
  );
  business.logout({});
  const signal = new AbortController().signal;
  for (const [consumerCode, code] of [
    ["base-safety-stock", "GEA_CAPABILITY_DISABLED"],
    ["aps", "GEA_CAPABILITY_MOCK_ONLY"],
    ["unknown", "GEA_PLUGIN_CONSUMER_NOT_ALLOWED"],
  ]) {
    for (const attempt of [
      () => business.pluginSql({ consumerCode, sql: "SELECT 1" }, signal),
      () => business.pluginSchema({ consumerCode, tables: ["agents_example"] }, signal),
      () => business.moduleMcp(consumerCode, signal),
      () => business.openMcpConnection({ consumerType: "AGENT", consumerCode }, signal),
      () => business.htmlLaunch(consumerCode, signal),
      () => business.modelRoute(signal, consumerCode),
    ])
      await assert.rejects(async () => attempt(), new RegExp(code));
  }
  assert.deepEqual(requests, []);
});

test("disabled native startup does not resolve a business gateway role Session and diagnostics cannot probe it", async (t) => {
  const { business, requests } = fixture(t, {
    workbenchCapability: { enabled: false },
  });
  await business.refreshApprovalRoles(new AbortController().signal);
  await assert.rejects(
    business.debugProbeModuleMcp("sales_forecast", new AbortController().signal),
    /GEA_CAPABILITY_DISABLED/,
  );
  assert.deepEqual(requests, []);
});

test("an enabled real declaration keeps the ordinary delegated SQL behavior", async (t) => {
  const { business, requests } = fixture(t);
  business.setCapabilities(
    createCapabilityRegistry([
      {
        id: "stock",
        label: "Stock",
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "Stock" },
        data: { consumerCode: "base-safety-stock", tables: [], rules: [] },
      },
    ]),
  );
  t.mock.method(globalThis, "fetch", async (input) => {
    requests.push(String(input));
    return Response.json(
      String(input).endsWith("/session")
        ? {
            success: true,
            result: {
              accessDecision: { allowed: true },
              delegationToken: "fixture-delegation",
            },
          }
        : { success: true, result: { rows: [{ sku: "A" }], total: 1 } },
    );
  });
  const result = await business.pluginSql(
    {
      consumerCode: "base-safety-stock",
      sql: "SELECT sku FROM agents_inventory",
      pageNo: 1,
      pageSize: 1,
    },
    new AbortController().signal,
  );
  assert.deepEqual(result.rows, [{ sku: "A" }]);
  assert.deepEqual(requests, [
    "https://fixture.invalid/ai/gateway/agent/session",
    "https://fixture.invalid/ai/gateway/sql/execute",
  ]);
});

test("temporary native disablement reaches the ordinary deployment patch and rejects malformed declarations", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gea-mock-capability-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "deployment.json");
  const config = {
    geaBaseUrl: "https://fixture.invalid",
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 1000,
    maxSnapshotBytes: 100000,
    analysis: { mode: "receipt" },
    workbenchCapability: { enabled: false },
  };
  await writeFile(file, JSON.stringify(config));
  const deployment = await readDeployment(file);
  const patch = businessDeploymentPatch(deployment, directory, join(directory, "runtime"));
  assert.deepEqual(
    patch.flatMap((row) => row.insert ?? []).find((item) => item.id === "gea-proof").config
      .workbenchCapability,
    { enabled: false },
  );
  for (const workbenchCapability of [
    false,
    { enabled: "false" },
    { enabled: false, consumers: [] },
  ]) {
    await writeFile(file, JSON.stringify({ ...config, workbenchCapability }));
    await assert.rejects(readDeployment(file), /INVALID_WORKBENCH_CAPABILITY/);
  }
});

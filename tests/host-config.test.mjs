import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "../lib/host.js";

const input = {
  geaBaseUrl: "https://fixture.invalid",
  pageSize: 10,
  periodPageSize: 100,
  requestTimeoutMs: 2000,
  maxSnapshotBytes: 10000,
  runtimeDir: "/tmp/host-config-fixture",
  analysisMode: "receipt",
  analysisModel: "receipt",
  inputByteBudget: 10000,
};
const limits = {
  maxRequests: 24,
  periods: 8,
  list: 12,
  detail: 2,
  versionSkus: 2,
  workflowSql: 2,
  maxWorkflowRows: 200,
  metadata: 8,
};

test("actual exported Host schema keeps absent optional budgets absent", () => {
  for (const workbenchCapability of [undefined, {}, { enabled: true }, { enabled: false }]) {
    const value = Config({ ...input, workbenchCapability });
    assert.equal(value.sqlReadLimit, undefined);
    assert.equal(value.workbenchCapability.readonlyValidation, undefined);
  }
});

test("actual exported Host schema preserves explicit zero limits and rejects incomplete budget objects", () => {
  const value = Config({
    ...input,
    workbenchCapability: { readonlyValidation: { ...limits, maxRequests: 0 } },
    sqlReadLimit: {
      consumerCode: "full-chain-inventory",
      maxRequests: 0,
      maxPagesPerQuery: 1,
      maxRowsPerQuery: 200,
    },
  });
  assert.equal(value.workbenchCapability.readonlyValidation.maxRequests, 0);
  assert.equal(value.sqlReadLimit.maxRequests, 0);
  for (const invalid of [
    {},
    { ...limits, list: undefined },
    { ...limits, list: -1 },
    { ...limits, list: 0.5 },
  ])
    assert.throws(() => Config({ ...input, workbenchCapability: { readonlyValidation: invalid } }));
  assert.throws(() => Config({ ...input, sqlReadLimit: {} }));
});

test("ordinary GEA bundle accepts empty public settings without downgrading to receipt mode", () => {
  const value = Config({});
  assert.equal(value.geaBaseUrl, "https://gea.synear.cn/gea-boot");
  assert.equal(value.analysisMode, "model");
  assert.equal(value.analysisSource, "gea");
  assert.equal(value.analysisAgentCode, "sales_forecast");
  assert.equal(value.runtimeDir, undefined);
  assert.equal(value.agentSqlRead, false);
  assert.equal(value.sqlReadLimit, undefined);
});

test("MCP inline delivery has configurable wire budget and query timeout without changing explicit settings", () => {
  const defaults = Config({});
  assert.equal(defaults.mcpRequestTimeoutMs, 300000);
  assert.equal(defaults.mcpMaxResponseBytes, 320 * 1024 * 1024);
  const explicit = Config({ mcpRequestTimeoutMs: 60000, mcpMaxResponseBytes: 8 * 1024 * 1024 });
  assert.equal(explicit.mcpRequestTimeoutMs, 60000);
  assert.equal(explicit.mcpMaxResponseBytes, 8 * 1024 * 1024);
  for (const invalid of [0, -1, 1.5, 1024 * 1024 * 1024 + 1])
    assert.throws(() => Config({ mcpMaxResponseBytes: invalid }));
});

test("ordinary Host never probes unconfigured credentials and rejects inline secrets before credential access", async (t) => {
  const { apply } = await import("../lib/host.js");
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-host-service-absent-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  let reads = 0;
  t.mock.method(childProcess, "execFileSync", () => {
    reads++;
    throw Error("unexpected credential access");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const initialized = Error("fixture-initialization-boundary");
  const ctx = {
    effect() {
      throw initialized;
    },
  };
  await assert.rejects(
    apply(ctx, Config({ ...input, runtimeDir })),
    (error) => error === initialized,
  );
  const account = {
    clientIdEnv: "GEA_HOST_ABSENT_CLIENT",
    clientSecretEnv: "GEA_HOST_ABSENT_SECRET",
    keychainService: "gea-host-absent-fixture",
    tenantId: "0",
    allowedUserIds: ["user-1"],
  };
  await assert.rejects(
    apply(
      ctx,
      Config({
        ...input,
        runtimeDir,
        serviceAccounts: {
          production: account,
          test: { ...account, secret: "not-permitted-in-config" },
        },
      }),
    ),
    /INVALID_SERVICE_ACCOUNTS/,
  );
  assert.equal(reads, 0);
});

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
test("ordinary Host preserves configured service references and loads credentials before initializing business", async (t) => {
  const { apply } = await import("../lib/host.js");
  const childProcess = (await import("node:child_process")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const runtimeDir = await mkdtemp(join(tmpdir(), "gea-host-service-fixture-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const clientIdEnv = "GEA_HOST_SERVICE_FIXTURE_CLIENT";
  const clientSecretEnv = "GEA_HOST_SERVICE_FIXTURE_SECRET";
  const before = [process.env[clientIdEnv], process.env[clientSecretEnv]];
  t.after(() => {
    for (const [key, value] of [
      [clientIdEnv, before[0]],
      [clientSecretEnv, before[1]],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    syncBuiltinESMExports();
  });
  let reads = 0;
  t.mock.method(childProcess, "execFileSync", (file, args) => {
    reads++;
    assert.equal(file, "/usr/bin/security");
    assert.deepEqual(args, [
      "find-generic-password",
      "-a",
      "service-account",
      "-s",
      "gea-host-service-fixture",
      "-w",
    ]);
    return JSON.stringify({ clientId: "fixture-client", secret: "fixture-secret" });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const serviceAccounts = {
    production: {
      clientIdEnv,
      clientSecretEnv,
      keychainService: "gea-host-service-fixture",
      tenantId: "0",
      allowedUserIds: ["user-1"],
    },
  };
  const value = Config({ ...input, runtimeDir, serviceAccounts });
  assert.deepEqual(value.serviceAccounts, serviceAccounts);
  const initialized = Error("fixture-initialization-boundary");
  await assert.rejects(
    apply(
      {
        effect() {
          throw initialized;
        },
      },
      value,
    ),
    (error) => error === initialized,
  );
  assert.equal(reads, 1);
  assert.equal(process.env[clientIdEnv], "fixture-client");
  assert.equal(process.env[clientSecretEnv], "fixture-secret");
  assert.equal(JSON.stringify(value).includes("fixture-secret"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { businessDeploymentPatch, readDeployment } from "../scripts/deployment.mjs";

const account = {
  clientIdEnv: "GEA_RESUBMIT_TEST_CLIENT",
  clientSecretEnv: "GEA_RESUBMIT_TEST_SECRET",
  keychainService: "gea-resubmit-fixture",
  tenantId: "0",
  allowedUserIds: ["user-1"],
};

const deployment = {
  geaBaseUrl: "https://gea.example.test/gea-boot",
  pageSize: 10,
  periodPageSize: 100,
  requestTimeoutMs: 15000,
  maxSnapshotBytes: 100000,
  analysis: { mode: "receipt" },
  serviceAccounts: { production: account },
};

test("pure direct-model preflight reads only the supplied credential environment", async (t) => {
  const key = "GEA_ISOLATED_PREFLIGHT_KEY";
  const path = await configFile(t, {
    ...deployment,
    serviceAccounts: { production: account },
    analysis: {
      mode: "model",
      source: "direct",
      baseUrl: "https://127.0.0.1/v1",
      apiKeyEnv: key,
      model: "fixture",
      contextWindow: 32768,
      maxTokens: 2048,
    },
  });
  const environment = { [key]: "fixture-key" };
  const before = process.env[key];
  let keychainReads = 0;
  const config = await readDeployment(path, {
    resolveCredentials: false,
    credentialEnv: environment,
    readKeychain: () => {
      keychainReads++;
      throw Error("unexpected keychain read");
    },
  });
  assert.equal(config.analysis.apiKeyEnv, key);
  assert.deepEqual(environment, { [key]: "fixture-key" });
  assert.equal(process.env[key], before);
  assert.equal(keychainReads, 0);
  const pure = await readDeployment(path, {
    resolveCredentials: false,
    checkDirectCredential: false,
    credentialEnv: new Proxy(
      {},
      {
        get() {
          throw Error("unexpected credential access");
        },
      },
    ),
    readKeychain: () => {
      throw Error("unexpected keychain read");
    },
  });
  assert.deepEqual(pure, config);
  process.env[key] = "global-fixture-key";
  try {
    for (const isolated of [{}, { GEA_DIFFERENT_PREFLIGHT_KEY: "other-fixture-key" }])
      await assert.rejects(
        readDeployment(path, { resolveCredentials: false, credentialEnv: isolated }),
        /ANALYSIS_CREDENTIAL_MISSING/,
      );
    assert.equal(
      (
        await readDeployment(path, {
          resolveCredentials: false,
        })
      ).analysis.apiKeyEnv,
      key,
    );
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});

test("readonly validation is explicit and validates all limits before reading credentials", async (t) => {
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
  for (const readonlyValidation of [
    null,
    {},
    { ...limits, list: -1 },
    { ...limits, metadata: 0.5 },
    { ...limits, maxWorkflowRows: 0 },
    { ...limits, extra: 1 },
  ]) {
    let reads = 0;
    const path = await configFile(t, {
      ...deployment,
      workbenchCapability: { readonlyValidation },
    });
    await assert.rejects(
      readDeployment(path, {
        credentialEnv: {},
        readKeychain: () => {
          reads++;
          return { clientId: "fixture", secret: "fixture" };
        },
      }),
      /INVALID_SALES_READONLY_VALIDATION/,
    );
    assert.equal(reads, 0);
  }
  const path = await configFile(t, {
    ...deployment,
    serviceAccounts: undefined,
    workbenchCapability: { enabled: true, readonlyValidation: limits },
  });
  const config = await readDeployment(path, { credentialEnv: {} });
  assert.deepEqual(config.workbenchCapability, { enabled: true, readonlyValidation: limits });
  const ordinary = await readDeployment(
    await configFile(t, { ...deployment, serviceAccounts: undefined }),
    { credentialEnv: {} },
  );
  assert.equal(ordinary.workbenchCapability?.readonlyValidation, undefined);
});

async function configFile(t, value = deployment) {
  const directory = await mkdtemp(resolve(tmpdir(), "gea-credential-deployment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, "gea.config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("DMS environment bindings reach Host in source and bundle deployments", async (t) => {
  const dms = {
    test: {
      gatewayUrl: "http://gateway.test/synear_test/DMS",
      manageUrl: "https://manage.example.test",
      secretEnv: "GEA_DMS_TEST_SECRET",
      users: [{ tenantId: "tenant-1", userId: "user-1", workcode: "employee-1" }],
    },
  };
  const config = await readDeployment(
    await configFile(t, { ...deployment, serviceAccounts: undefined, dms }),
    { credentialEnv: {} },
  );
  for (const bundle of [false, true]) {
    const rows = businessDeploymentPatch(config, "/fixture/plugin", "/fixture/runtime", {
      bundle,
    });
    const host = rows.flatMap((row) => row.insert ?? [row]).find((row) => row.id === "gea-proof");
    assert.deepEqual(host.config.dms, dms);
  }
});

for (const platform of ["win32", "darwin"]) {
  test(`upgraded ${platform} deployment preserves old references without requiring service credentials`, async (t) => {
    const path = await configFile(t);
    const credentialEnv = {};
    const config = await readDeployment(path, {
      credentialEnv,
      platform,
      readKeychain: async () => {
        throw Error("retired service credential source must not be read");
      },
    });
    assert.equal(config.serviceAccounts.production.keychainService, account.keychainService);
    assert.deepEqual(credentialEnv, {});
    assert.deepEqual(
      businessDeploymentPatch(config, "/fixture/plugin", "/fixture/runtime")
        .find((row) => row.insert)
        ?.insert.find((row) => row.id === "gea-proof")?.config.serviceAccounts,
      config.serviceAccounts,
    );
  });
}

test("deployment rejects inline secrets before reading Keychain", async (t) => {
  const path = await configFile(t, {
    ...deployment,
    serviceAccounts: { production: { ...account, secret: "must-not-be-in-configuration" } },
  });
  await assert.rejects(
    readDeployment(path, {
      credentialEnv: {},
      platform: "darwin",
      readKeychain: async () => {
        throw new Error("should not read Keychain");
      },
    }),
    /INVALID_SERVICE_ACCOUNTS/,
  );
});

test("deployment without service accounts does not read Keychain", async (t) => {
  const { serviceAccounts: _unused, ...plain } = deployment;
  const path = await configFile(t, plain);
  await readDeployment(path, {
    credentialEnv: {},
    platform: "darwin",
    readKeychain: async () => {
      throw new Error("unexpected Keychain access");
    },
  });
});

test("deployment normalizes legacy employee lists and accepts service references without them", async (t) => {
  for (const allowedUserIds of [["someone-else"], undefined, "obsolete"]) {
    const config = await readDeployment(
      await configFile(t, {
        ...deployment,
        serviceAccounts: { production: { ...account, allowedUserIds } },
      }),
      { resolveCredentials: false },
    );
    assert.equal("allowedUserIds" in config.serviceAccounts.production, false);
    assert.equal(config.serviceAccounts.production.tenantId, "0");
  }
});

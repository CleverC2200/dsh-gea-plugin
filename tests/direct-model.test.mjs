import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readDeployment, deploymentPatch } from "../scripts/deployment.mjs";

test("direct model deployment does not require an AionUi backend", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gea-direct-model-"));
  const path = resolve(dir, "deployment.json");
  await writeFile(
    path,
    JSON.stringify({
      geaBaseUrl: "https://gea.example.test/gea-boot",
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 15000,
      maxSnapshotBytes: 100000,
      analysis: {
        mode: "model",
        source: "direct",
        baseUrl: "https://llm.example.test/v1",
        apiKeyEnv: "GEA_DIRECT_TEST_KEY",
        model: "test-model",
        contextWindow: 32768,
        maxTokens: 2048,
      },
    }),
  );
  process.env.GEA_DIRECT_TEST_KEY = "test-secret";
  const config = await readDeployment(path);
  const patch = deploymentPatch(config, dir, resolve(dir, "runtime"));
  assert.equal(config.analysis.source, "direct");
  assert.equal(
    patch.at(-1).config.providers["gea-analysis"].baseURL,
    "https://llm.example.test/v1",
  );
  assert.equal(JSON.stringify(patch).includes("AionUi"), false);
  delete process.env.GEA_DIRECT_TEST_KEY;
});

test("GEA model deployment uses the logged-in GEA route", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gea-route-model-"));
  const path = resolve(dir, "deployment.json");
  await writeFile(
    path,
    JSON.stringify({
      geaBaseUrl: "https://gea.example.test/gea-boot",
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 15000,
      maxSnapshotBytes: 100000,
      analysis: {
        mode: "model",
        source: "gea",
        agentCode: "sales_forecast",
        model: "2085162185715609601",
        contextWindow: 32768,
        maxTokens: 2048,
      },
    }),
  );
  const config = await readDeployment(path);
  const patch = deploymentPatch(config, dir, resolve(dir, "runtime"));
  assert.equal(config.analysis.source, "gea");
  assert.equal(config.modelRequestTimeoutMs, 120000);
  assert.equal(config.requestTimeoutMs, 15000);
  assert.equal(patch.flatMap(row => row.insert ?? []).find(entry => entry.id === "gea-proof").config.modelRequestTimeoutMs, 120000);
  assert.equal(patch.flatMap(row => row.insert ?? []).find(entry => entry.id === "gea-proof").config.requestTimeoutMs, 15000);
  assert.equal(
    patch.find((row) => row.id === "llm-pi-ai"),
    undefined,
  );
  assert.equal(
    patch.flatMap(row => row.insert ?? []).find(entry => entry.id === "gea-proof").config.analysisAgentCode,
    "sales_forecast",
  );
});

test("direct model deployment fails closed for malformed endpoints and missing credentials", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gea-direct-invalid-"));
  const path = resolve(dir, "deployment.json");
  const base = {
    geaBaseUrl: "https://gea.example.test/gea-boot",
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 15000,
    maxSnapshotBytes: 100000,
    analysis: {
      mode: "model",
      source: "direct",
      baseUrl: "https://llm.example.test/v1",
      apiKeyEnv: "GEA_DIRECT_INVALID_KEY",
      model: "test-model",
      contextWindow: 32768,
      maxTokens: 2048,
    },
  };
  delete process.env.GEA_DIRECT_INVALID_KEY;
  await writeFile(path, JSON.stringify(base));
  await assert.rejects(readDeployment(path), /ANALYSIS_CREDENTIAL_MISSING/);
  await writeFile(
    path,
    JSON.stringify({
      ...base,
      analysis: {
        ...base.analysis,
        baseUrl: "not a URL",
      },
    }),
  );
  process.env.GEA_DIRECT_INVALID_KEY = "fixture-key";
  await assert.rejects(readDeployment(path), /INVALID_ANALYSIS_BASE_URL/);
  delete process.env.GEA_DIRECT_INVALID_KEY;
});

test("GEA stream timeout resolves independently from read timeouts and rejects invalid deployment values", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "gea-model-timeout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = resolve(dir, "deployment.json");
  const base = {
    geaBaseUrl: "https://gea.example.test/gea-boot",
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 15000,
    maxSnapshotBytes: 100000,
    analysis: {
      mode: "model",
      source: "gea",
      agentCode: "sales_forecast",
      model: "test-model",
      contextWindow: 32768,
      maxTokens: 2048,
    },
  };
  for (const modelRequestTimeoutMs of [1000, 300000, 600000]) {
    await writeFile(path, JSON.stringify({ ...base, modelRequestTimeoutMs }));
    const config = await readDeployment(path);
    assert.equal(config.modelRequestTimeoutMs, modelRequestTimeoutMs);
    assert.equal(config.requestTimeoutMs, 15000);
    const host = deploymentPatch(config, dir, resolve(dir, "runtime")).flatMap(row => row.insert ?? []).find(entry => entry.id === "gea-proof").config;
    assert.equal(host.modelRequestTimeoutMs, modelRequestTimeoutMs);
    assert.equal(host.requestTimeoutMs, 15000);
  }
  for (const modelRequestTimeoutMs of [
    999,
    600001,
    0,
    null,
    "120000",
    1000.5,
  ]) {
    await writeFile(path, JSON.stringify({ ...base, modelRequestTimeoutMs }));
    await assert.rejects(readDeployment(path), /INVALID_modelRequestTimeoutMs/);
  }
});

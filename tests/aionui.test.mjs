import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readDeployment, deploymentPatch } from "../scripts/deployment.mjs";

test("AionUi model selection resolves only the enabled local proxy and keeps credentials out of the patch", async (t) => {
  let provider;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/providers")
      res.end(JSON.stringify({ data: [provider] }));
    else {
      assert.equal(req.headers.authorization, "Bearer fixture-proxy-key");
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  provider = {
    id: "gea-personal-test",
    name: "fixture",
    enabled: true,
    platform: "openai",
    api_key: "fixture-proxy-key",
    base_url: base + "/personal/gea-personal-test",
    models: ["fixture-model"],
    model_enabled: { "fixture-model": true },
  };
  const dir = await mkdtemp(resolve(tmpdir(), "gea-aionui-"));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(dir, { recursive: true, force: true });
  });
  const path = resolve(dir, "deployment.json");
  const config = {
    geaBaseUrl: "https://gea.example.test/gea",
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 2000,
    maxSnapshotBytes: 100000,
    analysis: {
      mode: "model",
      source: "aionui",
      backendUrl: base,
      providerId: provider.id,
      model: "fixture-model",
      contextWindow: 32768,
      maxTokens: 2048,
    },
  };
  await writeFile(path, JSON.stringify(config));
  const resolved = await readDeployment(path);
  assert.equal(resolved.analysis.baseUrl, provider.base_url);
  assert.equal(resolved.analysis.credential, "fixture-proxy-key");
  assert.equal(
    JSON.stringify(deploymentPatch(resolved, dir, dir)).includes(
      "fixture-proxy-key",
    ),
    false,
  );
  provider = { ...provider, enabled: false };
  await assert.rejects(readDeployment(path), /AIONUI_PROVIDER_UNAVAILABLE/);
  provider = {
    ...provider,
    enabled: true,
    base_url: "http://remote.example.test/personal/gea-personal-test",
  };
  await assert.rejects(readDeployment(path), /AIONUI_PROXY_MUST_BE_LOOPBACK/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import z from "@deepseek-ai/schemastery";
import { readDeployment, businessDeploymentPatch } from "../scripts/deployment.mjs";

async function deployment(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "gea-memory-deployment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "gea.json");
  const bytes = JSON.stringify({
    geaBaseUrl: "https://gea.fixture.invalid",
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 15000,
    maxSnapshotBytes: 100000,
    analysis: { mode: "receipt" },
    ...settings,
  });
  await writeFile(file, bytes);
  const result = await readDeployment(file, { resolveCredentials: false });
  assert.equal(await readFile(file, "utf8"), bytes);
  return result;
}

const hostConfig = (config, bundle) =>
  businessDeploymentPatch(config, "/fixture/gea", "/fixture/runtime", { bundle })
    .flatMap((row) => row.insert ?? [row])
    .find((row) => row.id === "gea-proof").config;

test("existing deployment without memory fields receives company HTTPS defaults without changing its file", async (t) => {
  const config = await deployment(t);
  assert.equal(config.memoryGatewayUrl, "https://gea.synear.cn");
  assert.equal(config.memoryGatewayAllowPrivateHttp, false);
  for (const bundle of [false, true]) {
    assert.equal(hostConfig(config, bundle).memoryGatewayUrl, "https://gea.synear.cn");
    assert.equal(hostConfig(config, bundle).memoryGatewayAllowPrivateHttp, false);
  }
});

test("explicit custom and private HTTP gateways survive both profile modes", async (t) => {
  for (const settings of [
    { memoryGatewayUrl: "https://memory.fixture.invalid/" },
    { memoryGatewayUrl: "http://10.12.1.2:1934", memoryGatewayAllowPrivateHttp: true },
    { memoryGatewayUrl: "http://127.0.0.1:1934" },
  ]) {
    const config = await deployment(t, settings);
    for (const bundle of [false, true]) {
      assert.equal(
        hostConfig(config, bundle).memoryGatewayUrl,
        settings.memoryGatewayUrl.replace(/\/$/, ""),
      );
      assert.equal(
        hostConfig(config, bundle).memoryGatewayAllowPrivateHttp,
        settings.memoryGatewayAllowPrivateHttp ?? false,
      );
    }
  }
});

test("invalid memory transport is rejected during deployment admission", async (t) => {
  for (const settings of [
    { memoryGatewayUrl: "http://10.12.1.2:1934" },
    { memoryGatewayUrl: "https://memory.fixture.invalid/v1/memory" },
    { memoryGatewayUrl: "https://user:secret@memory.fixture.invalid" },
    { memoryGatewayUrl: "https://memory.fixture.invalid?scope=other" },
    { memoryGatewayUrl: "https://memory.fixture.invalid#other" },
    { memoryGatewayUrl: null },
    { memoryGatewayAllowPrivateHttp: "true" },
    { memoryGatewayAllowPrivateHttp: null },
  ])
    await assert.rejects(deployment(t, settings), /INVALID_MEMORY_GATEWAY/);
});

test("explicit empty gateway remains disabled instead of falling through to the Host default", async (t) => {
  const config = await deployment(t, { memoryGatewayUrl: "" });
  for (const bundle of [false, true]) assert.equal(hostConfig(config, bundle).memoryGatewayUrl, "");
});

test("direct Host schema defaults to company HTTPS and preserves explicit gateway choices", async (t) => {
  await mkdir(".runtime", { recursive: true });
  const directory = await mkdtemp(resolve(".runtime/memory-host-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await build({
    entryPoints: ["src/host.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    packages: "external",
  });
  const output = join(directory, "host.mjs");
  await writeFile(output, result.outputFiles[0].text);
  const { Config } = await import(pathToFileURL(output).href);
  const defaults = z.resolve({}, Config, {})[0];
  assert.equal(defaults.memoryGatewayUrl, "https://gea.synear.cn");
  assert.equal(defaults.memoryGatewayAllowPrivateHttp, false);
  assert.equal(defaults.modelRequestTimeoutMs, 600000);
  for (const memoryGatewayUrl of ["https://memory.fixture.invalid", ""])
    assert.equal(z.resolve({ memoryGatewayUrl }, Config, {})[0].memoryGatewayUrl, memoryGatewayUrl);
});

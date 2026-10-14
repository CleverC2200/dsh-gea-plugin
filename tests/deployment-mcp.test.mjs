import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeployment, businessDeploymentPatch } from "../scripts/deployment.mjs";

async function deployment(t, settings = {}) {
  const root = await mkdtemp(join(tmpdir(), "gea-mcp-deployment-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "gea.json");
  await writeFile(
    file,
    JSON.stringify({
      geaBaseUrl: "https://mcp.fixture.invalid",
      pageSize: 10,
      periodPageSize: 100,
      requestTimeoutMs: 15000,
      maxSnapshotBytes: 100000,
      analysis: { mode: "receipt" },
      ...settings,
    }),
  );
  return readDeployment(file, { resolveCredentials: false });
}
const hostConfig = (config, bundle) =>
  businessDeploymentPatch(config, "/fixture/gea", "/fixture/runtime", { bundle })
    .flatMap((row) => row.insert ?? [row])
    .find((row) => row.id === "gea-proof").config;

test("explicit MCP source and wire budget survive deployment into ordinary and bundled Host profiles", async (t) => {
  const config = await deployment(t, {
    cubeMcpCodes: { production: "fixture-production", test: "fixture-test" },
    mcpMaxResponseBytes: 8 * 1024 * 1024,
    mcpRequestTimeoutMs: 60000,
  });
  for (const bundle of [false, true]) {
    const host = hostConfig(config, bundle);
    assert.deepEqual(host.cubeMcpCodes, { production: "fixture-production", test: "fixture-test" });
    assert.equal(host.mcpMaxResponseBytes, 8 * 1024 * 1024);
    assert.equal(host.mcpRequestTimeoutMs, 60000);
  }
});

test("deployment keeps the current MCP timeout and byte defaults while accepting explicit Host-supported limits", async (t) => {
  const config = await deployment(t);
  assert.equal(config.mcpRequestTimeoutMs, 300000);
  assert.equal(config.mcpMaxResponseBytes, 320 * 1024 * 1024);
  assert.equal(
    config.cubeMcpCodes,
    undefined,
    "undeclared production never borrows another Cube source",
  );
  const explicit = await deployment(t, { mcpRequestTimeoutMs: 600000, mcpMaxResponseBytes: 1024 });
  assert.equal(explicit.mcpRequestTimeoutMs, 600000);
  assert.equal(explicit.mcpMaxResponseBytes, 1024);
  for (const settings of [
    { mcpRequestTimeoutMs: 600001 },
    { mcpMaxResponseBytes: 1023 },
    { mcpMaxResponseBytes: 1024 * 1024 * 1024 + 1 },
    { mcpMaxResponseBytes: 1.5 },
  ])
    await assert.rejects(deployment(t, settings), /INVALID_mcp/);
});

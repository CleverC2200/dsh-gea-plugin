import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourcePlugins } from "../scripts/source-composition.mjs";

test("the registered source composition contains the five current owners and the fixed private security candidate", async () => {
  assert.deepEqual(
    sourcePlugins.map((plugin) => plugin.repo),
    [
      "dsh-agent-workbench",
      "dsh-agent-manage",
      "dsh-gea-plugin",
      "dsh-genui",
      "dsh-better-sidebar",
    ],
  );
  assert.ok(sourcePlugins.every((plugin) => plugin.bundleOrder !== undefined));
  assert.ok(sourcePlugins.every((plugin) => plugin.example === undefined));
  const input = JSON.parse(
    await readFile(new URL("../scripts/current-core.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(input, {
    version: "0.2.1-alpha.1",
    upstream: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    adaptation: "8ff14441ac932b55cf1f14b1715128eaa162b1ec",
  });
});

test("an explicit isolated Workspace configures the existing workbench without changing business deployment fields", async () => {
  const { businessDeploymentPatch } = await import("../scripts/deployment.mjs");
  const config = {
    geaBaseUrl: "https://deployment.example.test/gea-boot",
    environment: "test",
    pageSize: 20,
    periodPageSize: 200,
    requestTimeoutMs: 15000,
    mcpRequestTimeoutMs: 60000,
    modelRequestTimeoutMs: 120000,
    maxSnapshotBytes: 100000,
    analysis: {
      mode: "model",
      source: "direct",
      model: "deployment-model",
      baseUrl: "https://model.example.test/v1",
      apiKeyEnv: "FIXTURE_MODEL_KEY",
      contextWindow: 32768,
      maxTokens: 2048,
    },
    agentSqlRead: true,
    visibleContextSubagent: false,
  };
  for (const bundle of [false, true]) {
    const baseline = businessDeploymentPatch(config, "/fixture/gea", "/fixture/runtime", {
      bundle,
    });
    const rows = businessDeploymentPatch(config, "/fixture/gea", "/fixture/runtime", {
      bundle,
      workspace: "/fixture/runtime/workspace",
    });
    assert.deepEqual(
      rows.find((row) => row.id === "agent-workbench"),
      {
        id: "agent-workbench",
        config: { cwd: "/fixture/runtime/workspace" },
      },
    );
    assert.deepEqual(
      rows.filter((row) => row.id !== "agent-workbench"),
      baseline,
    );
  }
});

test("an explicit Workspace rejects relative or invalid paths instead of borrowing the process cwd", async () => {
  const { businessDeploymentPatch } = await import("../scripts/deployment.mjs");
  for (const workspace of ["workspace", "", null, 1])
    assert.throws(
      () =>
        businessDeploymentPatch(
          { analysis: { mode: "receipt" } },
          "/fixture/gea",
          "/fixture/runtime",
          { bundle: true, workspace },
        ),
      /WORKBENCH_WORKSPACE_ABSOLUTE_REQUIRED/,
    );
});

test("the isolated Workspace preserves the configured public HTML roots", async () => {
  const { businessDeploymentPatch } = await import("../scripts/deployment.mjs");
  const workbenchConfig = { cwd: "/old/workspace", htmlRoots: ["/fixture/only-fc"] };
  const rows = businessDeploymentPatch(
    { analysis: { mode: "receipt" } },
    "/fixture/gea",
    "/fixture/runtime",
    { bundle: true, workspace: "/fixture/runtime/workspace", workbenchConfig },
  );
  assert.deepEqual(rows.find((row) => row.id === "agent-workbench").config, {
    cwd: "/fixture/runtime/workspace",
    htmlRoots: ["/fixture/only-fc"],
  });
  assert.equal(workbenchConfig.cwd, "/old/workspace");
});

test("current source configuration uses actual business declarations without resolving historical UI or preset paths", async () => {
  const { businessDeploymentPatch } = await import("../scripts/deployment.mjs");
  const rows = businessDeploymentPatch(
    { geaBaseUrl: "https://127.0.0.1:1", analysis: { mode: "receipt" } },
    process.cwd(),
    "/fixture/runtime",
    { bundle: true },
  );
  assert.equal(rows.find((row) => row.id === "agent-default-model").config.provider, "gea-proof");
  const business = rows.find((row) => row.id === "gea-proof");
  assert.equal(business.config.analysisAgentCode, "sales_forecast");
  assert.equal(business.config.analysisMode, "receipt");
  assert.ok(
    !rows.some(
      (row) =>
        row.id === "agent-presets" ||
        ["agent-workbench", "genui", "better-sidebar"].includes(row.id),
    ),
  );
  assert.ok(!rows.some((row) => row.insert));
});

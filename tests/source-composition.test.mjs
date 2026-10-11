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
    await readFile(
      new URL("../scripts/current-core.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(input, {
    version: "0.2.1-alpha.1",
    upstream: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    adaptation: "8ff14441ac932b55cf1f14b1715128eaa162b1ec",
  });
});

test("current source configuration uses actual business declarations without resolving historical UI or preset paths", async () => {
  const { businessDeploymentPatch } = await import("../scripts/deployment.mjs");
  const rows = businessDeploymentPatch(
    { geaBaseUrl: "https://127.0.0.1:1", analysis: { mode: "receipt" } },
    process.cwd(),
    "/fixture/runtime",
    { bundle: true },
  );
  assert.equal(
    rows.find((row) => row.id === "agent-default-model").config.provider,
    "gea-proof",
  );
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeHtmlDeclarations } from "./fixtures/html-resource.mjs";
import { contractFromPlugin } from "../src/capability/contract.ts";
import { readPluginContract } from "../src/capability/declarations.ts";
import { assertHtmlMcp } from "../src/capability/html-mcp.mjs";
import { verifyHtmlCapabilities } from "../scripts/package-source-integrity.mjs";

test("packaging and Host share the exact governed HTML MCP admission", () => {
  const mcp = {
    provider: "gea",
    transport: "host-provided",
    contract: "gea-html-v2",
    consumer: { consumerCode: "mps", consumerType: "AGENT" },
    capabilities: ["governed-sql-read"],
  };
  assert.doesNotThrow(() => assertHtmlMcp(mcp, "mps", false));
  assert.doesNotThrow(() =>
    assertHtmlMcp(
      { ...mcp, capabilities: ["governed-sql-read", "governed-cube-read"] },
      "mps",
      false,
    ),
  );
  assert.doesNotThrow(() => assertHtmlMcp({ ...mcp, capabilities: [] }, "mps", true));
  for (const invalid of [
    null,
    {},
    { ...mcp, capabilities: [] },
    { ...mcp, capabilities: ["governed-sql-read", "cube-read"] },
    { ...mcp, consumer: { consumerCode: "other", consumerType: "AGENT" } },
  ])
    assert.throws(() => assertHtmlMcp(invalid, "mps", false), /INVALID_GEA_CAPABILITY/);
});

test("order report-store admission keeps its empty external capability declaration", () => {
  const mcp = {
    provider: "gea",
    transport: "host-provided",
    contract: "gea-html-v2",
    consumer: { consumerCode: "order", consumerType: "AGENT" },
    capabilities: [],
  };
  assert.doesNotThrow(() => assertHtmlMcp(mcp, "order", false, true));
  assert.throws(() => assertHtmlMcp(mcp, "order", false), /INVALID_GEA_CAPABILITY/);
  assert.doesNotThrow(() =>
    assertHtmlMcp({ ...mcp, capabilities: ["governed-sql-read"] }, "order", false, true),
  );
  assert.throws(
    () => assertHtmlMcp({ ...mcp, capabilities: ["sql-write"] }, "order", false, true),
    /INVALID_GEA_CAPABILITY/,
  );
  assert.throws(
    () =>
      assertHtmlMcp(
        { ...mcp, consumer: { ...mcp.consumer, consumerCode: "mps" } },
        "mps",
        false,
        true,
      ),
    /INVALID_GEA_CAPABILITY/,
  );
});

test("packaging accepts only the explicit order report-store without external read capabilities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-report-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "html"));
  const manifest = {
    id: "inventory-orderworkbench",
    reportStore: "order",
    mcp: "mcp.json",
    gea: { consumerCode: "order", readonly: false },
  };
  const mcp = {
    provider: "gea",
    transport: "host-provided",
    contract: "gea-html-v2",
    consumer: { consumerCode: "order", consumerType: "AGENT" },
    capabilities: [],
  };
  await writeFile(join(root, "html/plugin.json"), JSON.stringify(manifest));
  await writeFile(join(root, "html/mcp.json"), JSON.stringify(mcp));
  const outputs = [{ path: "html/plugin.json" }, { path: "html/mcp.json" }];
  await verifyHtmlCapabilities(root, outputs);
  await writeFile(
    join(root, "html/plugin.json"),
    JSON.stringify({ ...manifest, reportStore: undefined }),
  );
  await assert.rejects(verifyHtmlCapabilities(root, outputs), /DELIVERY_HTML_CAPABILITY_INVALID/);
});

test("explicit HTML fixture retains invalid input for the current declaration reader to reject", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gea-explicit-declaration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    id: "inventory-explicit",
    name: "Explicit fixture",
    mode: "mock",
    mcp: "mcp.json",
    gea: { consumerCode: "expected-consumer", contract: "gea-html-v1" },
    declarations: { page: "page.json", capability: "capability.json" },
  };
  const mcp = { contract: "gea-html-v1" };
  await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(root, "mcp.json"), JSON.stringify(mcp));
  await writeHtmlDeclarations(root, {
    page: {
      surface: "gea-html-inventory-explicit",
      protocol: "self-report",
      pageIds: [manifest.id],
      consumerCode: "wrong-consumer",
      maxEffect: "view",
    },
    capability: {
      id: manifest.id,
      label: manifest.name,
      data: { consumerCode: "expected-consumer", tables: [], rules: [], mock: true },
      maxEffect: "view",
      layers: ["read"],
      skills: [],
      routing: { keywords: [], summary: manifest.name },
    },
    prompt: { consumerCode: "expected-consumer", persona: "fixture", skills: [] },
  });
  const installed = contractFromPlugin({
    id: manifest.id,
    label: manifest.name,
    pageIds: [manifest.id],
    consumerCode: "expected-consumer",
    maxEffect: "view",
    mock: true,
  });
  await assert.rejects(
    readPluginContract(root, manifest.declarations, installed),
    /INCOMPATIBLE_SPLIT_DECLARATION/,
  );
  assert.deepEqual(JSON.parse(await readFile(join(root, "plugin.json"), "utf8")), manifest);
  assert.deepEqual(JSON.parse(await readFile(join(root, "mcp.json"), "utf8")), mcp);
});

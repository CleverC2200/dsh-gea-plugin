import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contractFromPlugin } from "../src/capability/contract.ts";
import { readPluginContract } from "../src/capability/declarations.ts";

test(
  "migrated inventory keeps its installed identity and capability contract",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1" },
  async () => {
    const root = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
    const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
    const legacy = contractFromPlugin({
      id: "inventory-fc",
      label: "分仓库存",
      consumerCode: "branch-inventory",
      pageIds: ["inventory-fc"],
      maxEffect: "view",
      skill: await readFile(resolve(root, "skills/fc/SKILL.md"), "utf8"),
      sources: [await readFile(resolve(root, "index.html"), "utf8")],
    });
    const joined = await readPluginContract(root, manifest.declarations, legacy);
    assert.equal(joined.id, legacy.id);
    assert.deepEqual(joined.view, legacy.view);
    assert.deepEqual(joined.data, legacy.data);
    assert.equal(joined.maxEffect, legacy.maxEffect);
    assert.deepEqual(joined.layers, legacy.layers);
    assert.deepEqual(joined.skills, legacy.skills);
    assert.deepEqual(joined.routing.keywords, legacy.routing.keywords);
    assert.ok(joined.routing.summary, "the current declaration must retain a route summary");
    assert.equal(manifest.gea.readonly, true);
    // FC 906b3b... blob 80ec24ef...: only the declared v1→v2 protocol migration is allowed.
    const originalMcp = await readFile(
      new URL("./fixtures/branch-stock-original-mcp.txt", import.meta.url),
    );
    assert.equal(
      createHash("sha256").update(originalMcp).digest("hex"),
      "56fee7836b133f8d3e0c3bc97b2b2e140b071b345c452682894f6dd47c684e5d",
    );
    assert.deepEqual(JSON.parse(await readFile(resolve(root, "mcp.json"), "utf8")), {
      ...JSON.parse(originalMcp),
      contract: "gea-html-v2",
    });
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, "mcp.json"), "utf8")),
      JSON.parse(
        await readFile(
          resolve("../dsh-agent-manage/business-resources/inventory-fc/mcp.json"),
          "utf8",
        ),
      ),
      "assembled MCP must match its independently frozen Manage owner",
    );
  },
);

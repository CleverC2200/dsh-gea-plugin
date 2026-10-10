import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { contractFromPlugin } from "../src/capability/contract.ts";
import { readPluginContract } from "../src/capability/declarations.ts";

test(
  "migrated inventory keeps its installed identity and capability contract",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1" },
  async () => {
    const old = resolve(import.meta.dirname, "fixtures/inventory-fc-migration");
    const root = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
    for (const [file, expected] of [
      ["index.html.raw", "abb0947ab89397d05b4e806270c771d8daa023e186a06c6d2eeda90702496e15"],
      ["mcp.json.raw", "56fee7836b133f8d3e0c3bc97b2b2e140b071b345c452682894f6dd47c684e5d"],
    ])
      assert.equal(
        createHash("sha256")
          .update(await readFile(resolve(old, file)))
          .digest("hex"),
        expected,
      );
    const manifest = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
    const legacy = contractFromPlugin({
      id: "inventory-fc",
      label: "分仓库存",
      consumerCode: "branch-inventory",
      pageIds: ["inventory-fc"],
      maxEffect: "view",
      skill: await readFile(resolve(root, "skills/fc/SKILL.md"), "utf8"),
      sources: [await readFile(resolve(old, "index.html.raw"), "utf8")],
    });
    const { source: _source, ...joined } = await readPluginContract(
      root,
      manifest.declarations,
      legacy,
    );
    const { routing: installedRouting, ...installedIdentity } = joined;
    const { routing: historicalRouting, ...historicalIdentity } = legacy;
    assert.deepEqual(installedIdentity, historicalIdentity);
    assert.deepEqual(installedRouting.keywords, historicalRouting.keywords);
    assert.equal(
      installedRouting.summary,
      "在 DSH 分仓库存业务页读取当前 GEA 证据、调整筛选、解释指标，并在右侧 DSH 会话中整理分析方案。",
    );
    assert.equal(manifest.gea.readonly, true);
    const { contract: historicalProtocol, ...historicalMcp } = JSON.parse(
      await readFile(resolve(old, "mcp.json.raw"), "utf8"),
    );
    const { contract: installedProtocol, ...installedMcp } = JSON.parse(
      await readFile(resolve(root, "mcp.json"), "utf8"),
    );
    assert.equal(historicalProtocol, "gea-html-v1");
    assert.equal(installedProtocol, "gea-html-v2");
    assert.deepEqual(installedMcp, historicalMcp);
  },
);

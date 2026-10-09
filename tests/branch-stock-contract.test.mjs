import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contractFromPlugin } from "../src/capability/contract.ts";
import { readPluginContract } from "../src/capability/declarations.ts";

test(
  "migrated inventory keeps its installed identity and capability contract",
  { skip: process.env.GEA_TEST_SOURCE_CORE !== "1" },
  async () => {
    const old = resolve("../dsh-agent-fc-plugin");
    const root = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
    const manifest = JSON.parse(
      await readFile(resolve(root, "plugin.json"), "utf8"),
    );
    const legacy = contractFromPlugin({
      id: "inventory-fc",
      label: "分仓库存",
      consumerCode: "branch-inventory",
      pageIds: ["inventory-fc"],
      maxEffect: "view",
      skill: await readFile(resolve(root, "skills/fc/SKILL.md"), "utf8"),
      sources: [await readFile(resolve(old, "index.html"), "utf8")],
    });
    const { source, ...joined } = await readPluginContract(
      root,
      manifest.declarations,
      legacy,
    );
    assert.deepEqual(joined, legacy);
    assert.equal(manifest.gea.readonly, true);
    assert.deepEqual(
      JSON.parse(await readFile(resolve(root, "mcp.json"), "utf8")),
      JSON.parse(await readFile(resolve(old, "mcp.json"), "utf8")),
    );
  },
);

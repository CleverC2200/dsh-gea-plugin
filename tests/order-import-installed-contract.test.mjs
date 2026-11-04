import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractFromPlugin } from "../src/capability/contract.ts";
import { readPluginContract } from "../src/capability/declarations.ts";
test("shipped order-workbench import Skill is admitted by installed Host declaration", async () => {
  const root = new URL(
    "../../dsh-agent-workbench/prototypes/inventory-orderworkbench/",
    import.meta.url,
  );
  const policy = JSON.parse(
    await readFile(new URL("../presets/execution-policy.json", import.meta.url)),
  );
  const profile = policy.profiles["gea-html-inventory-orderworkbench"];
  const manifest = JSON.parse(await readFile(new URL("plugin.json", root)));
  const capability = JSON.parse(
    await readFile(
      new URL(
        "../../dsh-agent-manage/business-resources/inventory-orderworkbench/capability.json",
        import.meta.url,
      ),
    ),
  );
  assert.ok(profile.skills.includes("operations-workbook-exception-import"));
  assert.ok(
    !policy.profiles["gea-html-inventory-orderfulfillment"].skills.includes(
      "operations-workbook-exception-import",
    ),
  );
  for (const name of capability.skills) assert.ok(profile.skills.includes(name), name);
  const { mkdtemp, cp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "order-import-contract-"));
  try {
    await cp(new URL("page.json", root), join(dir, "page.json"));
    await cp(
      new URL(
        "../../dsh-agent-manage/business-resources/inventory-orderworkbench/capability.json",
        import.meta.url,
      ),
      join(dir, "capability.json"),
    );
    const contract = await readPluginContract(dir, manifest.declarations, {
      ...contractFromPlugin({
        id: manifest.id,
        label: manifest.name,
        consumerCode: "order",
        pageIds: [manifest.id],
        maxEffect: "submit",
      }),
      skills: profile.skills,
    });
    assert.ok(contract.skills.includes("operations-workbook-exception-import"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

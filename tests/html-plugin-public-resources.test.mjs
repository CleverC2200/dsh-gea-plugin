import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { profile } from "./profile.mjs";

test("the real HTML plugin catalog preserves resource declarations without host loader objects", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 60000,
}, async t => {
  const root = resolve("../dsh-agent-workbench/lib/business/inventory-fc");
  const declared = JSON.parse(await readFile(resolve(root, "plugin.json"), "utf8"));
  const skillText = await readFile(resolve(root, declared.skills[0]), "utf8");
  const app = await profile(t, { env: { GEA_HTML_PLUGIN_ROOTS: JSON.stringify([root]) } });
  const response = await fetch(app.origin + "/api/gea-html/plugins", { headers: { Cookie: app.cookie } });
  assert.equal(response.status, 200);
  const plugins = await response.json();
  const plugin = plugins.find(item => item.id === declared.id);
  assert.ok(plugin);
  await mkdir(".runtime/public-resources-evidence", { recursive: true });
  await writeFile(".runtime/public-resources-evidence/catalog.json", JSON.stringify({
    id: plugin.id, agentResourceKeys: Object.keys(plugin.agentResources ?? {}),
    source: plugin.agentResources?.source, declared: declared.agentResources,
    hasSkillText: Object.hasOwn(plugin, "skillText"),
  }, null, 2));
  assert.equal(Object.hasOwn(plugin, "skillText"), false, "loaded Skill text is Host-only");
  assert.equal(plugin.agentResources?.provider, declared.agentResources.provider);
  assert.deepEqual(plugin.agentResources, declared.agentResources);
  assert.equal(plugin.gea.consumerCode, "branch-inventory");
  assert.ok(plugin.pages.length > 0);
  assert.equal(typeof plugin.skillName, "string");
  assert.deepEqual(plugin.skills, declared.skills);
  const publicBody = JSON.stringify(plugins);
  assert.doesNotMatch(publicBody, /"(?:skillPath|promptPath|loadedAgentResources|skillText)"/);
  assert.ok(!publicBody.includes(JSON.stringify(skillText).slice(1, -1)), "the full loaded Skill must not be serialized under another field");
  assert.ok(!publicBody.includes(root));
  assert.ok(!publicBody.includes(app.runtime));
});

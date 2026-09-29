import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import { composeSourcePresets } from "../scripts/source-presets.mjs";

const standard = { source: "core/standard.patch.yml", text: await readFile(new URL("../../deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml", import.meta.url), "utf8") };
const business = { source: "gea/agent.cordis.yml", text: await readFile(new URL("../presets/gea-readonly/agent.cordis.yml", import.meta.url), "utf8") };
const options = { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }] };

test("source presets relocate double-quoted modules and preserve JS tags", () => {
  const result = composeSourcePresets(standard, {
    ...business, text: business.text.replace("'../../lib/skill-reference.js'", '"../../lib/skill-reference.js"'),
  }, "/snapshot/gea/lib/skill-reference.js");
  const doc = parseDocument(result, options);
  assert.equal(doc.errors.length, 0);
  assert.equal(doc.getIn([0, "insert", 0, "id"]), "preset-auto-negotiation");
  assert.equal(doc.getIn([0, "insert", 0, "config", "id"]), "auto-negotiation");
  const plugins = doc.toJS().at(-1).insert[0].config.plugins;
  assert.equal(plugins.find(row => row.id === "gea-skill-reference").name, "/snapshot/gea/lib/skill-reference.js");
  assert.match(result, /!!js/);
  const js = doc.getIn([0, "insert", 0, "config", "plugins", 2, "disabled"], true);
  assert.equal(js.tag, "tag:yaml.org,2002:js");
  assert.equal(js.value, "process.platform === 'win32'");
  assert.equal(doc.getIn([1, "insert", 0, "config", "plugins", 1, "config", "customSkillDirs"], true).tag, "tag:yaml.org,2002:js");
});

test("flow formatting and comments do not change preset meaning", () => {
  const result = composeSourcePresets({ source: "flow.yml", text: '- insert: [{id: "preset-standard", name: "@deepseek-ai/dsh-agent-preset", config: {id: "standard", plugins: []}}] # standard\n' }, { source: "business-flow.yml", text: '[{name: ../../lib/skill-reference.js, id: gea-skill-reference}]' }, "/snapshot/skill.js");
  const rows = parseDocument(result, options).toJS();
  assert.equal(rows[0].insert[0].config.id, "auto-negotiation");
  assert.equal(rows[1].insert[0].config.plugins[0].name, "/snapshot/skill.js");
});

for (const [description, input, pattern] of [
  ["missing native preset", { ...standard, text: "[]" }, /core\/standard.patch.yml: expected one preset-standard, found 0/],
  ["duplicate native preset", { ...standard, text: standard.text + standard.text }, /found 2/],
  ["incompatible native config", { ...standard, text: standard.text.replace("id: standard", "id: other") }, /expected literal id: standard/],
  ["incompatible native plugins", { ...standard, text: '- insert: [{id: preset-standard, name: "@deepseek-ai/dsh-agent-preset", config: {id: standard, plugins: {}}}]' }, /expected preset plugins sequence/],
  ["duplicate YAML key", { ...standard, text: standard.text.replace("id: standard", "id: standard\n        id: duplicate") }, /Map keys must be unique/],
  ["unknown YAML tag", { ...standard, text: standard.text.replace("!!js", "!unknown") }, /Unresolved tag/],
]) test(`source presets reject ${description}`, () => {
  assert.throws(() => composeSourcePresets(input, business, "/skill.js"), pattern);
});
for (const [description, text, pattern] of [
  ["missing business module", "[]", /gea\/agent.cordis.yml: expected one gea-skill-reference, found 0/],
  ["duplicate business module", business.text + business.text, /found 2/],
  ["incompatible business module", business.text.replace("../../lib/skill-reference.js", "../different.js"), /expected literal name/],
]) test(`source presets reject ${description}`, () => {
  assert.throws(() => composeSourcePresets(standard, { ...business, text }, "/skill.js"), pattern);
});

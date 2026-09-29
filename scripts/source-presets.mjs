/** Rewrite the two source presets without evaluating or dropping Cordis !!js tags. */
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

function fail(source, message) {
  throw Error(`SOURCE_PRESET_INVALID: ${source}: ${message}`);
}

function parse(input) {
  const doc = parseDocument(input.text, {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }],
  });
  const diagnostics = [...doc.errors, ...doc.warnings];
  if (diagnostics.length) fail(input.source, diagnostics.map(error => error.message).join("; "));
  if (!isSeq(doc.contents)) fail(input.source, "expected a sequence");
  return doc;
}

function unique(rows, id, source) {
  const matches = rows.filter(row => isMap(row) && row.get("id") === id);
  if (matches.length !== 1) fail(source, `expected one ${id}, found ${matches.length}`);
  return matches[0];
}

function expectLiteral(map, key, value, source) {
  const node = map.get(key, true);
  if (!isScalar(node) || node.tag || node.value !== value)
    fail(source, `expected literal ${key}: ${value}`);
}

/** Compose native and business preset YAML. Diagnostics identify the input file. */
export function composeSourcePresets(standard, business, skillReferencePath) {
  const native = parse(standard);
  const rows = [];
  for (const operation of native.contents.items) {
    if (!isMap(operation)) fail(standard.source, "expected a patch mapping");
    if (!operation.has("insert")) continue;
    const inserted = operation.get("insert", true);
    if (!isSeq(inserted)) fail(standard.source, "expected insert sequence");
    rows.push(...inserted.items);
  }
  const preset = unique(rows, "preset-standard", standard.source);
  expectLiteral(preset, "id", "preset-standard", standard.source);
  expectLiteral(preset, "name", "@deepseek-ai/dsh-agent-preset", standard.source);
  if (rows.some(row => isMap(row) && ["preset-auto-negotiation", "preset-gea-readonly"].includes(row.get("id"))))
    fail(standard.source, "destination preset already exists");
  const config = preset.get("config", true);
  if (!isMap(config)) fail(standard.source, "expected preset config mapping");
  expectLiteral(config, "id", "standard", standard.source);
  if (!isSeq(config.get("plugins", true))) fail(standard.source, "expected preset plugins sequence");
  preset.set("id", "preset-auto-negotiation");
  config.set("id", "auto-negotiation");

  const gea = parse(business);
  const reference = unique(gea.contents.items, "gea-skill-reference", business.source);
  expectLiteral(reference, "id", "gea-skill-reference", business.source);
  expectLiteral(reference, "name", "../../lib/skill-reference.js", business.source);
  reference.set("name", skillReferencePath);
  const insertion = native.createNode({ insert: [{
    id: "preset-gea-readonly", name: "@deepseek-ai/dsh-agent-preset",
    config: { id: "gea-readonly" },
  }] });
  insertion.setIn(["insert", 0, "config", "plugins"], gea.contents);
  native.contents.add(insertion);
  return native.toString();
}

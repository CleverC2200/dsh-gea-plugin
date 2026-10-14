/** Compile package identity into source; runtime modules never reread the manifest. */
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (
  typeof manifest.name !== "string" ||
  !manifest.name.trim() ||
  typeof manifest.version !== "string" ||
  !manifest.version.trim()
)
  throw Error("PLUGIN_PACKAGE_VERSION_INVALID: package.json requires name and version");
const literal = (value) => JSON.stringify(value);
const source =
  "/** Package identity captured at build time; immutable after module loading. */\n" +
  `export const pluginPackageVersion = Object.freeze({\n  name: ${literal(manifest.name)},\n  version: ${literal(manifest.version)},\n} as const);\n`;
const target = "src/plugin-package-version.ts";
let existing;
try {
  existing = await readFile(target, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing !== source) {
  if (values.check) throw Error("PLUGIN_PACKAGE_VERSION_STALE: rebuild the package version stamp");
  await writeFile(target, source);
}

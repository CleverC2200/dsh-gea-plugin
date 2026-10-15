/** Type-check the Host, transport and real detail contributions against one unchanged public SDK. */
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
const sdk = process.env.GEA_PLUGIN_UPDATE_SDK;
if (!sdk || !isAbsolute(sdk)) throw Error("PLUGIN_UPDATES_TYPE_INPUTS_REQUIRED");
const root = process.cwd(),
  config = JSON.parse(await readFile("tsconfig.official.json", "utf8"));
config.compilerOptions.paths = Object.fromEntries(
  Object.entries(config.compilerOptions.paths)
    .filter(([name]) => name.startsWith("@deepseek-ai/"))
    .map(([name, paths]) => [
      name,
      paths.map((path) => path.replace("../../official-latest-standard", sdk)),
    ]),
);
config.compilerOptions.types = ["node"];
config.compilerOptions.typeRoots = [resolve("node_modules/@types")];
config.include = [
  "src/host/plugin-updates.ts",
  "src/plugin-updates-client.ts",
  "src/plugin-detail-updates.tsx",
  "src/assets.d.ts",
  "src/plugin-package-version.ts",
].map((path) => join(root, path));
await mkdir(".runtime", { recursive: true });
const directory = await mkdtemp(resolve(".runtime/plugin-update-types-"));
try {
  const file = join(directory, "tsconfig.json");
  await writeFile(file, JSON.stringify(config));
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", file], {
    stdio: "inherit",
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

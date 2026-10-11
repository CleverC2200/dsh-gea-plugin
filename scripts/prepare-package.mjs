/** Prepare an ordinary plugin artifact without installing SDK peers or touching source dependencies. */
import { parseArgs } from "node:util";
import { resolve, join, dirname } from "node:path";
import { readFile, writeFile, mkdir, cp, lstat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { productionManifest } from "./production-manifest.mjs";

const { values } = parseArgs({
  options: {
    versions: { type: "string" },
    destination: { type: "string" },
    pnpm: { type: "string" },
  },
});
if (!values.versions || !values.destination || !values.pnpm)
  throw Error("PACKAGE_INPUTS_REQUIRED: --versions --destination --pnpm");
const source = resolve(import.meta.dirname, ".."),
  target = resolve(values.destination);
if (target === source) throw Error("SOURCE_PACKAGE_INSTALL_FORBIDDEN");
await mkdir(target, { recursive: false });
const manifest = productionManifest(
  JSON.parse(await readFile(join(source, "package.json"), "utf8")),
  JSON.parse(await readFile(resolve(values.versions), "utf8")),
);
for (const file of [
  ...manifest.files.filter((file) => file !== "npm-shrinkwrap.json"),
  "LICENSE",
]) {
  const src = join(source, file),
    dest = join(target, file);
  if ((await lstat(src)).isSymbolicLink()) throw Error("PACKAGE_SOURCE_SYMLINK: " + file);
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).includes("node_modules"),
  });
}
await writeFile(join(target, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
// This is the official out-of-tree profile dependency protocol, not a peer override.
await writeFile(
  join(target, "pnpm-workspace.yaml"),
  "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
);
execFileSync(
  process.execPath,
  [resolve(values.pnpm), "install", "--ignore-scripts", "--registry=https://registry.npmjs.org"],
  { cwd: target, stdio: "inherit" },
);
execFileSync("npm", ["shrinkwrap", "--ignore-scripts"], { cwd: target, stdio: "inherit" });
console.log(
  JSON.stringify({
    input: target,
    version: manifest.version,
    sdkPeersProvidedByHost: true,
    sourceDependenciesUnchanged: true,
  }),
);

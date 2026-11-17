import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { sourceProvenance, writeProvenance } from "./desktop-dev-parity.mjs";

const root = resolve(import.meta.dirname, "..");
const payload =
  process.env.GEA_DESKTOP_PAYLOAD ?? "/Applications/Synear GEA.app/Contents/Resources/payload";
const electron =
  process.env.GEA_ELECTRON_EXECUTABLE ?? "/Applications/Synear GEA.app/Contents/MacOS/Synear GEA";
const graph = resolve(root, ".runtime/desktop-dev/graph");
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(graph, { recursive: true, force: true });
await mkdir(join(graph, "node_modules/@cleverc2200"), { recursive: true });
await cp(join(payload, "package.json"), join(graph, "package.json"));

const REMOVED_OPTIONAL_PLUGINS = ["@dsh-external/dsh-visualize"];
const graphManifestPath = join(graph, "package.json");
const graphManifest = JSON.parse(await readFile(graphManifestPath, "utf8"));
for (const name of REMOVED_OPTIONAL_PLUGINS) delete graphManifest.dependencies?.[name];
await writeFile(graphManifestPath, JSON.stringify(graphManifest, null, 2));
for (const name of await readdir(join(payload, "node_modules"))) {
  if (name === "@cleverc2200") continue;
  await symlink(join(payload, "node_modules", name), join(graph, "node_modules", name));
}
for (const name of await readdir(join(payload, "node_modules/@cleverc2200"))) {
  if (name === "gea-dsh-prototype") continue;
  await symlink(
    join(payload, "node_modules/@cleverc2200", name),
    join(graph, "node_modules/@cleverc2200", name),
  );
}
await symlink(root, join(graph, "node_modules/@cleverc2200/gea-dsh-prototype"));
if (!existsSync(join(root, "lib/client.js"))) throw new Error("请先运行 pnpm build:plugin");
await writeProvenance(
  resolve(root, ".runtime/desktop-dev/provenance.json"),
  await sourceProvenance(root, payload, sourcePackage),
);
const env = {
  ...process.env,
  GEA_DESKTOP_DEV: "1",
  GEA_DESKTOP_PAYLOAD: payload,
  DSH_PLUGIN_GRAPH: graph,
};
const child = spawn(electron, [], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

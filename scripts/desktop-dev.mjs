/** Launch the installed Electron shell against this checkout's built plugin. */
import { cp, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { sourceProvenance, writeProvenance } from "./desktop-dev-parity.mjs";

const root = resolve(import.meta.dirname, "..");
const payload = process.env.GEA_DESKTOP_PAYLOAD ?? "/Applications/GEA Desktop.app/Contents/Resources/payload";
const electron = process.env.GEA_ELECTRON_EXECUTABLE ?? "/Applications/GEA Desktop.app/Contents/MacOS/GEA Desktop";
const graph = resolve(root, ".runtime/desktop-dev/graph");
const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

await rm(graph, { recursive: true, force: true });
await mkdir(join(graph, "node_modules/@cleverc2200"), { recursive: true });
await cp(join(payload, "package.json"), join(graph, "package.json"));
for (const name of await readdir(join(payload, "node_modules"))) {
  if (name === "@cleverc2200") continue;
  await symlink(join(payload, "node_modules", name), join(graph, "node_modules", name));
}
for (const name of await readdir(join(payload, "node_modules/@cleverc2200"))) {
  if (name === "gea-dsh-prototype") continue;
  await symlink(join(payload, "node_modules/@cleverc2200", name), join(graph, "node_modules/@cleverc2200", name));
}
await symlink(root, join(graph, "node_modules/@cleverc2200/gea-dsh-prototype"));
if (!existsSync(join(root, "lib/client.js"))) throw new Error("请先运行 pnpm build:plugin");
await writeProvenance(resolve(root, ".runtime/desktop-dev/provenance.json"), await sourceProvenance(root, payload, sourcePackage));
const env = { ...process.env, GEA_DESKTOP_DEV: "1", GEA_DESKTOP_PAYLOAD: payload, DSH_PLUGIN_GRAPH: graph };
const child = spawn(electron, [], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

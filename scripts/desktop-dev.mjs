/** Launch the installed Electron shell against this checkout's built plugin. */
import { cp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
/**
 * dev 图以"已安装 payload 的 package.json"为底，而 payload 可能比源码旧：仓库里已经清掉的
 * 可选插件（例如与 dsh-genui 重叠的 @dsh-external/dsh-visualize），已装 payload 里还带着，
 * 运行时会照它的 optional 清单把它挂上。这里按"源码已移除"的清单从 dev 图里摘掉，
 * 让 dev 预览等于当前源码——不需要重装客户端，也不动安装目录。
 */
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
  await symlink(join(payload, "node_modules/@cleverc2200", name), join(graph, "node_modules/@cleverc2200", name));
}
await symlink(root, join(graph, "node_modules/@cleverc2200/gea-dsh-prototype"));
if (!existsSync(join(root, "lib/client.js"))) throw new Error("请先运行 pnpm build:plugin");
await writeProvenance(resolve(root, ".runtime/desktop-dev/provenance.json"), await sourceProvenance(root, payload, sourcePackage));
const env = { ...process.env, GEA_DESKTOP_DEV: "1", GEA_DESKTOP_PAYLOAD: payload, DSH_PLUGIN_GRAPH: graph };
const child = spawn(electron, [], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

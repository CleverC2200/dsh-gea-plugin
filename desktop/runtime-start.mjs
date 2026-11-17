import { readFile, mkdir, writeFile, lstat, symlink, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { configureWelcomeNotice } from "./onboarding.mjs";
import { companySources, provisionCompanyResources } from "./company-resources.mjs";
import { prepareHtmlPlugins } from "./html-plugins.mjs";
import { openCoreRuntime } from "./core-runtime.mjs";
const payload = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.DSH_PLUGIN_GRAPH || payload);
const core = process.env.GEA_LAYERED_CORE ? resolve(process.env.GEA_LAYERED_CORE) : root;
process.chdir(root);
const runtime = resolve(payload, process.env.DSH_FULL_DATA_DIR || "data");
const configPath = resolve(payload, process.env.GEA_CONFIG || "gea.config.json");
const coreContext = process.env.GEA_LAYERED_CORE
  ? await openCoreRuntime(core, root, join(runtime, "home"))
  : null;
if (!existsSync(configPath)) {
  console.error("公司运行配置缺失，请联系管理员重新安装桌面应用。");
  process.exit(1);
}
const port = Number(process.env.DSH_FULL_PORT || "3198");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("INVALID_PORT");
const gea = join(root, "node_modules/@cleverc2200/gea-dsh-prototype");
const { readDeployment, deploymentPatch, prepareNativePreset } = await import(
  pathToFileURL(join(gea, "scripts/deployment.mjs")).href
);
const config = await readDeployment(configPath);
await mkdir(runtime, { recursive: true });
await mkdir(join(runtime, "workspace"), { recursive: true });

console.log("[startup] 准备默认预设");

await prepareNativePreset(
  runtime,
  join(core, "node_modules/@deepseek-ai/dsh-agent-presets/presets/standard"),
);
const patchPath = join(runtime, "deployment.patch.json");
const patch = deploymentPatch(config, gea, runtime, { bundle: true });
patch.push({ id: "dsh-agent-manage", config: { sources: companySources } });
await writeFile(patchPath, JSON.stringify(patch, null, 2), { mode: 0o600 });
const home = join(runtime, "home");
await mkdir(home, { recursive: true });
console.log("[startup] 准备工作区与公司资源");
await provisionCompanyResources(process.env.DSH_DESKTOP_BASELINE || root, home);
await configureWelcomeNotice(join(home, "settings.yaml"));
const profileDir = join(home, "profiles/full");
await mkdir(profileDir, { recursive: true });

const modules = join(profileDir, "node_modules");
const target = join(root, "node_modules");
try {
  const entry = await lstat(modules);
  if (!entry.isSymbolicLink()) throw new Error("PROFILE_MODULES_NOT_OWNED_LINK");
  await unlink(modules);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!existsSync(modules))
  await symlink(target, modules, process.platform === "win32" ? "junction" : "dir");
const manifestPath = join(profileDir, "package.json");
const graphManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
let optionalState = {};
if (process.env.DSH_OPTIONAL_STATE_PATH) {
  try {
    optionalState = JSON.parse(await readFile(process.env.DSH_OPTIONAL_STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const optional = [
  "dsh-plugin",
  "dsh-agent-manage",
  "dsh-agent-plugins-market",
  "dsh-raw-html-v2",
  "dsh-worktable",
  "dsh-personal-memory",
];
const bundles = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@cleverc2200/gea-dsh-prototype",
  ...optional.filter((name) => graphManifest.dependencies?.[name] && (optionalState[name] ?? true)),
];

const existing = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
await writeFile(
  manifestPath,
  JSON.stringify(
    {
      ...existing,
      name: "dsh-profile-full",
      private: true,
      dependencies: graphManifest.dependencies,
      dsh: {
        ...existing.dsh,
        profile: {
          ...existing.dsh?.profile,
          bundles,
          patchReload: process.env.GEA_DESKTOP_DEV === "1" ? "live" : "startup",
        },
      },
    },
    null,
    2,
  ),
);

const htmlPlugins = await prepareHtmlPlugins({ runtime });
const htmlPluginEnv = Object.keys(htmlPlugins.roots).length
  ? { GEA_HTML_PLUGIN_ROOTS: JSON.stringify(htmlPlugins.roots) }
  : {};

console.log("[startup] 启动 DSH 核心");
const child = spawn(
  process.execPath,
  [
    ...(process.env.GEA_LAYERED_CORE ? ["--expose-internals"] : []),
    join(core, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
    "--profile",
    "full",
    "--patch",
    patchPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    ...(process.env.DSH_FULL_NO_OPEN ? ["--no-open"] : []),
  ],
  {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, GEA_COMPANY_CLIENT: "1", ...htmlPluginEnv },
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
process.on("message", (message) => {
  if (message?.type === "stop") child.kill("SIGTERM");
});
process.on("disconnect", () => child.kill("SIGTERM"));
child.on("exit", async (code) => {
  await coreContext?.fiber.dispose();
  process.exitCode = code ?? 1;
  if (process.connected) process.disconnect();
});

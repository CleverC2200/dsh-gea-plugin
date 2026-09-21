/** Start an isolated, configured GEA Web profile through the official dsh CLI. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, writeFile, symlink, lstat, realpath, unlink, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  deploymentPatch,
  readDeployment,
  prepareNativePreset,
} from "./deployment.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const root = fileURLToPath(new URL("../", import.meta.url));
const HTML_PLUGIN_RELEASE_PROJECT = "chenyonghao%2Fdsh-plugin-releases";
const HTML_PLUGIN_PACKAGES = [
  ["inventory-apsplan", "dsh-gea-inventory-apsplan-0.2.0-preview.1.tgz"],
  ["inventory-personal", "dsh-gea-inventory-personal-0.2.7-preview.2.tgz"],
  ["inventory-aqkc", "dsh-gea-inventory-aqkc-0.2.6-preview.2.tgz"],
  ["inventory-dealer", "dsh-gea-inventory-dealer-0.2.6-preview.2.tgz"],
  ["inventory-fc", "dsh-gea-inventory-fc-0.2.6-preview.2.tgz"],
  ["inventory-qll", "dsh-gea-inventory-qll-0.2.6-preview.2.tgz"],
];
async function prepareHtmlPlugins(runtime) {
  const roots = {};
  const base = resolve(runtime, "html-plugins");
  for (const [id, filename] of HTML_PLUGIN_PACKAGES) {
    const target = resolve(base, id);
    // 默认只在缺失时下载（保持本地副本不动）；把 GEA_HTML_PLUGIN_REFRESH 设为 1 时会按列表里的
    // 发行包重新拉一遍——插件发了新版、要确认新规则时用这个开关，避免每次启动都覆盖本地副本。
    if (!existsSync(resolve(target, "plugin.json")) || process.env.GEA_HTML_PLUGIN_REFRESH === "1") {
      const url = `http://100.100.6.191:20656/api/v4/projects/${HTML_PLUGIN_RELEASE_PROJECT}/repository/files/${encodeURIComponent(`packages/${filename}`)}?ref=main`;
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTML_PLUGIN_DOWNLOAD_${response.status}`);
      const record = await response.json();
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true, mode: 0o700 });
      const archive = resolve(base, `${id}.tgz`);
      await mkdir(base, { recursive: true, mode: 0o700 });
      await writeFile(archive, Buffer.from(record.content, "base64"), { mode: 0o600 });
      execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", target]);
      await rm(archive, { force: true });
    }
    // Older inventory-dealer previews shipped a placeholder fetch bridge that
    // always threw before delegating SQL requests to the host MessageChannel.
    // Repair that known preview in the isolated development copy so a fresh
    // runtime behaves like the merged HTML host contract.
    if (id === "inventory-dealer") {
      const entry = resolve(target, "index.html");
      const source = await readFile(entry, "utf8");
      const repaired = source.replace(
        /async function x_\(e,t,n\)\{let r=e\.searchParams,o=e\.pathname;throw Error\("\\u6682\\u4E0D\\u652F\\u6301\\u6B64\\u64CD\\u4F5C[^}]+\}/,
        'async function x_(e,t,n){if(t!=="GET"&&t!=="POST")throw Error("\\u4E0D\\u652F\\u6301\\u7684\\u6570\\u636E\\u8BF7\\u6C42\\u65B9\\u6CD5");if(n&&typeof n.sql==="string")return await Dl("sql",n);throw Error("\\u6682\\u4E0D\\u652F\\u6301\\u6B64\\u64CD\\u4F5C")}',
      );
      if (repaired !== source) await writeFile(entry, repaired);
    }
    roots[id] = target;
  }
  return roots;
}
let log;
let child;
let writes = Promise.resolve();
async function closeResources() {
  try {
    await writes;
  } finally {
    await log?.close();
    log = undefined;
  }
}
try {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      runtime: { type: "string" },
      port: { type: "string", default: "3198" },
      bundle: { type: "boolean" },
      dev: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm start -- --config <deployment.json> [--runtime <directory>] [--port <port or 0>] [--dev]",
    );
    process.exit(0);
  }
  const config = await readDeployment(
    resolve(values.config ?? "gea.config.json"),
  );
  // Source checkouts use the local package graph. Release installs keep the
  // normal installed-plugin path unless the caller explicitly opts in.
  const development = values.dev === true;
  const useBundle = values.bundle === true || development;
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("GEA_PORT_INVALID");
  const presetRoot = resolve(require.resolve("@deepseek-ai/dsh-agent-presets/package.json"), "../presets/standard");
  const runtime = resolve(values.runtime ?? ".runtime/workbench-development");
  await mkdir(resolve(runtime, "workspace"), { recursive: true, mode: 0o700 });
  if (development) process.env.GEA_HTML_PLUGIN_ROOTS = JSON.stringify(await prepareHtmlPlugins(runtime));
  await prepareNativePreset(runtime, presetRoot);
  const patchPath = resolve(runtime, "deployment.patch.json");
  await writeFile(
    patchPath,
    JSON.stringify(deploymentPatch(config, root, runtime, { bundle: useBundle }), null, 2) + "\n",
    { mode: 0o600 },
  );
  log = await open(resolve(runtime, "server.log"), "a", 0o600);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|DSH_/.test(key),
    ),
  );
  if (process.env.GEA_HTML_PLUGIN_ROOTS) env.GEA_HTML_PLUGIN_ROOTS = process.env.GEA_HTML_PLUGIN_ROOTS;
  if (development) env.GEA_WEB_LOGIN_PERSIST = "1";
  if (config.analysis.mode === "model" && config.analysis.source !== "gea")
    env[config.analysis.apiKeyEnv] = process.env[config.analysis.apiKeyEnv];
  for (const account of Object.values(config.serviceAccounts ?? {})) {
    if (
      ![account.clientIdEnv, account.clientSecretEnv].every((name) =>
        /^GEA_[A-Z0-9_]+$/.test(name ?? ""),
      )
    )
      throw new Error("INVALID_SERVICE_ACCOUNTS");
    if (account.keychainService) {
      if (
        process.platform !== "darwin" ||
        !/^[a-zA-Z0-9._-]+$/.test(account.keychainService)
      )
        throw new Error("GEA_KEYCHAIN_UNAVAILABLE");
      let credentials;
      try {
        credentials = JSON.parse(
          execFileSync(
            "/usr/bin/security",
            [
              "find-generic-password",
              "-a",
              "service-account",
              "-s",
              account.keychainService,
              "-w",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
          ),
        );
      } catch {
        throw new Error("GEA_KEYCHAIN_CREDENTIAL_MISSING");
      }
      if (!credentials.clientId || !credentials.secret)
        throw new Error("GEA_KEYCHAIN_CREDENTIAL_INVALID");
      env[account.clientIdEnv] = credentials.clientId;
      env[account.clientSecretEnv] = credentials.secret;
    }
    for (const name of [account.clientIdEnv, account.clientSecretEnv]) {
      if (!/^GEA_[A-Z0-9_]+$/.test(name ?? ""))
        throw new Error("INVALID_SERVICE_ACCOUNTS");
      if (!account.keychainService && process.env[name])
        env[name] = process.env[name];
    }
  }
  env.DSH_HOME = resolve(runtime, "home");
  if (useBundle) {
    const profileDir = resolve(env.DSH_HOME, "profiles/gea-workbench");
    const modules = resolve(profileDir, "node_modules/@cleverc2200");
    await mkdir(modules, { recursive: true });
    for (const [name, target] of [["gea-dsh-prototype", root], ["dsh-agent-workbench", resolve(require.resolve("@cleverc2200/dsh-agent-workbench/package.json"), "..")]]) {
      try { await symlink(target, resolve(modules, name), process.platform === "win32" ? "junction" : "dir"); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        const link = resolve(modules, name);
        if (!(await lstat(link)).isSymbolicLink()) throw new Error("PROFILE_MODULES_NOT_OWNED_LINK");
        if (await realpath(link).catch(() => null) !== await realpath(target)) {
          await unlink(link);
          await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
        }
      }
    }
    const manifestPath = resolve(profileDir, "package.json");
    const manifest = existsSync(manifestPath)
      ? JSON.parse(await readFile(manifestPath, "utf8"))
      : {
          name: "gea-profile",
          private: true,
          dsh: {
            profile: {
              bundles: [
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "@cleverc2200/gea-dsh-prototype",
              ],
              patchReload: "startup",
            },
          },
        };
    if (development) {
      manifest.dsh ??= {};
      manifest.dsh.profile ??= {};
      manifest.dsh.profile.patchReload = "live";
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  const initialize = existsSync(
    resolve(env.DSH_HOME, "profiles/gea-workbench/package.json"),
  )
    ? []
    : ["--from-default-profile", "web"];
  const dshArgs = [resolve(require.resolve("@deepseek-ai/dsh/package.json"), "../lib/bin.js")];
  child = spawn(
    process.execPath,
    [
      ...dshArgs,
      "--profile",
      "gea-workbench",
      ...initialize,
      "--patch",
      patchPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const pipe of [child.stdout, child.stderr])
    pipe.on("data", (data) => {
      writes = writes.then(() => log.write(data));
      process.stdout.write(
        data
          .toString()
          .replace(/(https?:\/\/[^\s]+)[?#][^\s]+/g, "$1?[redacted]"),
      );
    });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => child.kill(signal));
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  // Observe early spawn failures while the PID file is being written.
  void ended.catch(() => {});
  try {
    if (child.pid !== undefined)
      await writeFile(resolve(runtime, "pid"), String(child.pid) + "\n", {
        mode: 0o600,
      });
  } catch (error) {
    child.kill("SIGTERM");
    await ended;
    throw error;
  }
  process.exitCode = await ended;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeResources();
}

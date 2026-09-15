/** Start an isolated, configured GEA Web profile through the official dsh CLI. */
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, writeFile, symlink, lstat, realpath, unlink } from "node:fs/promises";
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
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm start -- --config <deployment.json> [--runtime <directory>] [--port <port or 0>]",
    );
    process.exit(0);
  }
  const config = await readDeployment(
    resolve(values.config ?? "gea.config.json"),
  );
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("GEA_PORT_INVALID");
  const presetRoot = resolve(require.resolve("@deepseek-ai/dsh-agent-presets/package.json"), "../presets/standard");
  const runtime = resolve(values.runtime ?? ".runtime/workbench-development");
  await mkdir(resolve(runtime, "workspace"), { recursive: true, mode: 0o700 });
  await prepareNativePreset(runtime, presetRoot);
  const patchPath = resolve(runtime, "deployment.patch.json");
  await writeFile(
    patchPath,
    JSON.stringify(deploymentPatch(config, root, runtime, { bundle: values.bundle }), null, 2) + "\n",
    { mode: 0o600 },
  );
  log = await open(resolve(runtime, "server.log"), "a", 0o600);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|DSH_/.test(key),
    ),
  );
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
  if (values.bundle) {
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
    if (!existsSync(manifestPath)) await writeFile(manifestPath, JSON.stringify({
      name: "gea-profile", private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@cleverc2200/gea-dsh-prototype"], patchReload: "startup" } },
    }, null, 2));
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

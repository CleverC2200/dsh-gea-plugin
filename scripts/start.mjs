/** Start an isolated, configured GEA Web profile through the official dsh CLI. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deploymentPatch, readDeployment } from "./deployment.mjs";
import { startAionUiWire } from "./aionui-wire.mjs";
import { prepareDshSource } from "./dsh-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let wire;
let log;
let child;
let writes = Promise.resolve();
async function closeResources() {
  await wire?.close();
  wire = undefined;
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
  const { source: dshSource } = await prepareDshSource(root);
  const runtime = resolve(values.runtime ?? ".runtime/fork-development");
  await mkdir(resolve(runtime, "workspace"), { recursive: true, mode: 0o700 });
  wire =
    config.analysis.source === "aionui"
      ? await startAionUiWire(config.analysis)
      : undefined;
  if (wire)
    config.analysis = {
      ...config.analysis,
      baseUrl: wire.baseUrl,
      credential: wire.credential,
    };
  const patchPath = resolve(runtime, "deployment.patch.json");
  await writeFile(
    patchPath,
    JSON.stringify(deploymentPatch(config, root, runtime), null, 2) + "\n",
    { mode: 0o600 },
  );
  log = await open(resolve(runtime, "server.log"), "a", 0o600);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|DSH_/.test(key),
    ),
  );
  if (config.analysis.mode === "model")
    env[config.analysis.apiKeyEnv] =
      config.analysis.credential ?? process.env[config.analysis.apiKeyEnv];
  env.DSH_HOME = resolve(runtime, "home");
  const initialize = existsSync(
    resolve(env.DSH_HOME, "profiles/gea-readonly-fork/package.json"),
  )
    ? []
    : ["--from-default-profile", "web"];
  const dshArgs = [resolve(dshSource, "apps/cli/lib/bin.js")];
  child = spawn(
    process.execPath,
    [
      ...dshArgs,
      "--profile",
      "gea-readonly-fork",
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

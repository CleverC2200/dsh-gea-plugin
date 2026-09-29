/** Offline validation of a pinned DSH source build; installed payloads are optional controls. */
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  glob,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "..");
const required = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-agent-presets",
  "@cleverc2200/gea-dsh-prototype",
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "dsh-plugin",
];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

// Executed only by the launcher inside sandbox-exec; no network-backed provisioning.
export async function runProfile(payload, runtime) {
  const gea = join(payload, "node_modules/@cleverc2200/gea-dsh-prototype");
  const { deploymentPatch, prepareNativePreset } = await import(
    pathToFileURL(join(gea, "scripts/deployment.mjs"))
  );
  await prepareNativePreset(
    runtime,
    join(
      payload,
      "node_modules/@deepseek-ai/dsh-agent-presets/presets/standard",
    ),
  );
  const endpoint = "https://127.0.0.1:1";
  const config = {
    geaBaseUrl: endpoint,
    environment: "test",
    geaEnvironments: { test: endpoint, production: endpoint },
    pageSize: 10,
    periodPageSize: 100,
    requestTimeoutMs: 1000,
    mcpRequestTimeoutMs: 1000,
    modelRequestTimeoutMs: 1000,
    maxSnapshotBytes: 100000,
    analysis: { mode: "receipt" },
  };
  const patch = deploymentPatch(config, gea, runtime, { bundle: true });
  patch.push({ id: "dsh-agent-manage", config: { sources: [] } });
  await save(join(runtime, "deployment.patch.json"), patch);
  const profile = join(runtime, "home/profiles/plugin-split-validation");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await symlink(join(payload, "node_modules"), join(profile, "node_modules"));
  const manifest = await json(join(payload, "package.json"));
  await save(join(profile, "package.json"), {
    name: "plugin-split-validation",
    private: true,
    dependencies: manifest.dependencies,
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@cleverc2200/gea-dsh-prototype",
          "dsh-plugin",
          "dsh-agent-manage",
        ],
        patchReload: "startup",
      },
    },
  });
  const child = spawn(
    process.execPath,
    [
      join(payload, "node_modules/@deepseek-ai/dsh/lib/bin.js"),
      "--profile",
      "plugin-split-validation",
      "--patch",
      join(runtime, "deployment.patch.json"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    { cwd: runtime, env: process.env, stdio: "inherit" },
  );
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.exitCode = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => done(code ?? 1));
  });
}

/** Boot the official profile from artifacts built in the pinned source checkout. */
export async function runSourceProfile(core, runtime) {
  const profile = join(runtime, "home/profiles/plugin-split-validation");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await save(join(profile, "package.json"), {
    name: "plugin-split-validation",
    private: true,
    dsh: {
      profile: {
        bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
      },
    },
  });
  const child = spawn(
    process.execPath,
    [
      join(core, "apps/cli/lib/bin.js"),
      "--profile",
      "plugin-split-validation",
      "--patch",
      join(core, "apps/web/tests/pin-browse-picker.overlay.yml"),
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--no-open",
    ],
    { cwd: join(runtime, "workspace"), env: process.env, stdio: "inherit" },
  );
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.exitCode = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => done(code ?? 1));
  });
}

async function launch() {
  const { values } = parseArgs({
    options: {
      core: { type: "string" },
      payload: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/start-isolated-validation.mjs [--core <built source checkout> | --payload <control payload>]\nDefaults to the sibling deepseek-harness source checkout. macOS only; fresh offline profile; Ctrl-C stops this instance.",
    );
    return;
  }
  if (process.platform !== "darwin")
    throw Error("ISOLATED_VALIDATION_REQUIRES_MACOS_SANDBOX");
  if (values.core && values.payload)
    throw Error("CHOOSE_SOURCE_OR_CONTROL_PAYLOAD");
  const source = !values.payload;
  const payload = await realpath(
    values.payload ?? values.core ?? resolve(root, "../deepseek-harness"),
  );
  const manifest = await json(join(payload, "package.json"));
  const packages = {};
  if (source) {
    for await (const entry of glob(
      [
        "apps/*/package.json",
        "packages/*/*/package.json",
        "vendor/*/package.json",
      ],
      { cwd: payload },
    )) {
      const pkg = await json(join(payload, entry));
      packages[pkg.name] = pkg.version;
    }
    await readFile(join(payload, "apps/cli/lib/bin.js"));
    await readFile(join(payload, "apps/web/dist/index.html"));
  } else {
    const modules = join(payload, "node_modules");
    for (const name of await readdir(modules)) {
      if (name.startsWith(".")) continue;
      const names = name.startsWith("@")
        ? (await readdir(join(modules, name))).map(
            (entry) => `${name}/${entry}`,
          )
        : [name];
      for (const entry of names) {
        try {
          packages[entry] = (
            await json(join(modules, entry, "package.json"))
          ).version;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    for (const name of required)
      if (!packages[name]) throw Error(`PAYLOAD_PACKAGE_MISSING: ${name}`);
  }
  const base = join(root, ".runtime/plugin-split-validation");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const physicalBase = await realpath(base);
  if (!physicalBase.startsWith((await realpath(root)) + "/"))
    throw Error("RUNTIME_OUTSIDE_CHECKOUT");
  const runtime = await mkdtemp(join(physicalBase, "run-"));
  for (const dir of ["home", "tmp", "workspace"])
    await mkdir(join(runtime, dir), { mode: 0o700 });
  const sandbox = `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ${JSON.stringify(runtime)}) (literal "/dev/null"))
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
`;
  const sandboxPath = join(runtime, "isolation.sb");
  await writeFile(sandboxPath, sandbox, { mode: 0o600 });
  await save(join(runtime, "provenance.json"), {
    mode: source ? "official-source-build" : "installed-payload-baseline",
    generatedAt: new Date().toISOString(),
    payload,
    payloadVersion: manifest.version,
    packages,
    coreSource: source
      ? execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: payload,
          encoding: "utf8",
        }).trim()
      : null,
    coreDirty: source
      ? execFileSync("git", ["status", "--porcelain"], {
          cwd: payload,
          encoding: "utf8",
        }).trim()
      : null,
    packageSha256: await digest(join(payload, "package.json")),
    lockSha256: await digest(join(payload, "pnpm-lock.yaml")),
    launcherSource: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    launcherSha256: await digest(new URL(import.meta.url)),
    runtime,
    sourceOverlay: false,
    outboundNetwork: "denied",
    writableRoot: runtime,
    limitations: [
      source
        ? "Native core profile; company plugin compatibility still pending"
        : "Installed package versions, not unbuilt source checkouts",
      "No GEA login, business data, remote channels, or Electron shell validation",
    ],
  });
  console.log(`ISOLATED_RUNTIME=${runtime}`);
  const env = {
    PATH: `/usr/bin:/bin`,
    HOME: join(runtime, "home"),
    TMPDIR: join(runtime, "tmp"),
    DSH_HOME: join(runtime, "home"),
    LANG: "en_US.UTF-8",
    DSH_TELEMETRY_DISABLED: "1",
  };
  const code = `import(${JSON.stringify(import.meta.url)}).then(m => m.${source ? "runSourceProfile" : "runProfile"}(${JSON.stringify(payload)}, ${JSON.stringify(runtime)}))`;
  const log = await open(join(runtime, "server.log"), "a", 0o600);
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      sandboxPath,
      source ? process.execPath : join(payload, "node/bin/node"),
      "--input-type=module",
      "-e",
      code,
    ],
    { cwd: runtime, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const ended = new Promise((done, fail) => {
    child.once("error", fail);
    child.once("close", (code, signal) => done({ code, signal }));
  });
  void ended.catch(() => {});
  let writes = Promise.resolve();
  let logError;
  for (const pipe of [child.stdout, child.stderr])
    pipe.on("data", (data) => {
      writes = writes
        .then(() => {
          if (!logError) return log.write(data);
        })
        .catch((error) => {
          logError ??= error;
          stop("SIGTERM");
        });
      // The fresh local authentication URL is needed to open this isolated profile.
      // Raw logs are private (0600); no inherited credentials reach this process.
      process.stdout.write(data);
    });
  let stoppedBy = null;
  let killTimer;
  const stop = (signal) => {
    if (stoppedBy) return;
    stoppedBy = signal;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 5000);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await save(join(runtime, "process.json"), {
      launcherPid: process.pid,
      childPid: child.pid,
    });
    const exit = await ended;
    await writes;
    await save(join(runtime, "exit.json"), {
      ...exit,
      stoppedBy,
      logError: logError?.message,
      stoppedAt: new Date().toISOString(),
    });
    process.exitCode =
      !logError && (exit.code === 0 || (stoppedBy && exit.signal !== "SIGKILL"))
        ? 0
        : 1;
  } finally {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      stop("SIGTERM");
      await ended.catch(() => {});
    }
    clearTimeout(killTimer);
    await writes;
    await log.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  launch().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

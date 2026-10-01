/** Offline validation of the current isolated source composition. */
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { corePackages } from "./source-composition.mjs";

const root = resolve(import.meta.dirname, "..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/** Boot the official profile from artifacts built in the pinned source checkout. */
export async function runSourceProfile(
  core,
  runtime,
  plugins = false,
  deployment,
  port = 0,
) {
  const supported = await json(new URL("./current-core.json", import.meta.url));
  const cli = await json(join(core, "apps/cli/package.json"));
  if (cli.version !== supported.version)
    throw Error(
      "UNSUPPORTED_CORE_VERSION: build the registered current source",
    );
  const coreSha = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: core,
    encoding: "utf8",
  }).trim();
  if (
    plugins &&
    ((await realpath(core)) !==
      (await realpath(resolve(root, "../deepseek-harness"))) ||
      coreSha !== supported.adaptation)
  )
    throw Error(
      "UNSUPPORTED_CORE_BASELINE: use the registered isolated checkout",
    );
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await save(join(runtime, "core-source.json"), {
    upstream: supported.upstream,
    adaptation: coreSha,
    dirty: execFileSync("/usr/bin/git", ["status", "--porcelain"], {
      cwd: core,
      encoding: "utf8",
    }).trim(),
    version: cli.version,
  });
  const profile = join(runtime, "home/profiles/plugin-split-validation");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(join(runtime, "workspace"), { recursive: true, mode: 0o700 });
  const lock = await open(join(runtime, "source-profile.lock"), "wx", 0o600);
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    let composition = { dependencies: {}, bundles: [], patches: [] };
    if (plugins) {
      const { prepareSourcePlugins, readSourceCombination } = await import(
        "./source-profile.mjs"
      );
      let selected;
      try {
        selected = await json(join(runtime, "source-selection.json"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      composition = selected
        ? await readSourceCombination(runtime, selected.id, core)
        : await prepareSourcePlugins(core, runtime, deployment);
      if (!selected)
        await save(join(runtime, "source-selection.json"), {
          id: composition.id,
        });
      process.env.GEA_HTML_PLUGIN_ROOTS ??= JSON.stringify([
        join(
          runtime,
          "source-combinations",
          composition.id,
          "node_modules/@cleverc2200/dsh-agent-workbench/lib/business/inventory-fc",
        ),
      ]);
      const temporary = join(profile, `node_modules-${composition.id}`);
      await symlink(
        join(runtime, "source-combinations", composition.id, "node_modules"),
        temporary,
      );
      await rename(temporary, join(profile, "node_modules"));
      await save(
        join(runtime, "company-plugins.json"),
        await json(
          join(
            runtime,
            "source-combinations",
            composition.id,
            "company-plugins.json",
          ),
        ),
      );
    }
    await save(join(profile, "package.json"), {
      name: "plugin-split-validation",
      private: true,
      dependencies: composition.dependencies,
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            ...composition.bundles,
          ],
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
        ...composition.patches.flatMap((path) => ["--patch", path]),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
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
  } finally {
    await lock.close();
    await unlink(join(runtime, "source-profile.lock"));
  }
}

async function launch() {
  const { values } = parseArgs({
    options: {
      core: { type: "string" },
      plugins: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/start-isolated-validation.mjs [--core <built current source checkout>]\nDefaults to the sibling deepseek-harness source checkout. macOS only; fresh offline profile; Ctrl-C stops this instance.",
    );
    return;
  }
  if (process.platform !== "darwin")
    throw Error("ISOLATED_VALIDATION_REQUIRES_MACOS_SANDBOX");
  const core = await realpath(
    values.core ?? resolve(root, "../deepseek-harness"),
  );
  const manifest = await json(join(core, "package.json"));
  const packages = {};
  for (const { manifest: pkg } of await corePackages(core))
    packages[pkg.name] = pkg.version;
  await readFile(join(core, "apps/cli/lib/bin.js"));
  await readFile(join(core, "apps/web/dist/index.html"));
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
    mode: "current-source-build",
    companyPlugins: values.plugins === true,
    generatedAt: new Date().toISOString(),
    core,
    coreVersion: manifest.version,
    packages,
    coreSource: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: core,
      encoding: "utf8",
    }).trim(),
    coreDirty: execFileSync("git", ["status", "--porcelain"], {
      cwd: core,
      encoding: "utf8",
    }).trim(),
    packageSha256: await digest(join(core, "package.json")),
    lockSha256: await digest(join(core, "pnpm-lock.yaml")),
    launcherSource: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    launcherSha256: await digest(new URL(import.meta.url)),
    runtime,
    sourceOverlay: values.plugins === true,
    outboundNetwork: "denied",
    writableRoot: runtime,
    limitations: [
      values.plugins
        ? "Company source composition; live business acceptance is separate"
        : "Native core profile without company plugins",
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
  const code = `import(${JSON.stringify(import.meta.url)}).then(m => m.runSourceProfile(${JSON.stringify(core)}, ${JSON.stringify(runtime)}, ${values.plugins === true}))`;
  const log = await open(join(runtime, "server.log"), "a", 0o600);
  const child = spawn(
    "/usr/bin/sandbox-exec",
    ["-f", sandboxPath, process.execPath, "--input-type=module", "-e", code],
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

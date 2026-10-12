/** Opt-in, local GEA measurements. Never schedules work or reuses build results. */
import { spawn, execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  lstat,
  unlink,
  writeFile,
  statfs,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const VERSION = "0.1.0";
export const KIND = "dev-environment-governance";
export const defaultLogDir = join(homedir(), ".local/state/dev-environment-governance");
export const tasks = {
  install: ["install", "--frozen-lockfile", "--prefer-offline"],
  build: ["run", "build"],
  "build:host": ["run", "build:host"],
  typecheck: ["run", "typecheck"],
  test: ["run", "test"],
  package: ["run", "package"],
  "test:package": ["run", "test:package"],
  "test:build": ["run", "test:build"],
  "test:dependencies": ["run", "test:dependencies"],
};
const sources = ["terminal", "codex-action", "benchmark", "unknown"];
const conditions = ["unknown", "warm-store-empty-layout", "existing-layout", "cold-cache-isolated"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ownedName = /^run-([0-9a-f-]{36})\.jsonl$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const safe = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

export async function readRuns(logDir) {
  const runs = [];
  for (const name of (await safe(() => readdir(logDir))) ?? []) {
    const match = ownedName.exec(name);
    if (!match || !uuid.test(match[1])) continue;
    const path = join(logDir, name);
    const info = await safe(() => lstat(path));
    if (!info?.isFile() || info.size > 32768) continue;
    const events = await safe(async () =>
      (await readFile(path, "utf8")).trim().split("\n").map(JSON.parse),
    );
    if (
      !events?.length ||
      events.some(
        (e) =>
          !e ||
          typeof e !== "object" ||
          e.kind !== KIND ||
          e.schemaVersion !== 1 ||
          e.runId !== match[1],
      )
    )
      continue;
    const start = events.find((e) => e.event === "start");
    if (!start) continue;
    runs.push({
      path,
      info,
      start,
      end: events.find((e) => e.event === "end") ?? null,
    });
  }
  return runs;
}

export async function rotate(
  logDir,
  { maxAgeMs = 30 * 86400000, maxBytes = 50 * 1024 * 1024, now = Date.now() } = {},
) {
  const runs = await readRuns(logDir);
  let total = runs.reduce((n, r) => n + r.info.size, 0);
  let removed = 0;
  for (const run of runs.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
    // Incomplete/active files are never removed by retention.
    if (!run.end || (now - run.info.mtimeMs <= maxAgeMs && total <= maxBytes)) continue;
    const deleted = await safe(async () => {
      await unlink(run.path);
      return true;
    });
    if (deleted) {
      total -= run.info.size;
      removed++;
    }
  }
  return { removed, remainingBytes: total, limitBytes: maxBytes };
}

async function snapshot(cwd) {
  const git = (args) =>
    safe(() =>
      execFileSync("git", args, {
        cwd,
        timeout: 1500,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  const head = await git(["rev-parse", "HEAD"]);
  const status = await git(["status", "--porcelain=v1", "-z", "-uno"]);
  const locks = {};
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
    "pnpm-workspace.yaml",
  ]) {
    const content = await safe(() => readFile(join(cwd, name)));
    locks[name] = content === null ? null : digest(content);
  }
  const manifest = await safe(async () =>
    JSON.parse(await readFile(join(cwd, "package.json"), "utf8")),
  );
  const declaration = /^pnpm@\d+\.\d+\.\d+$/.test(manifest?.packageManager ?? "")
    ? manifest.packageManager
    : null;
  return {
    project: "gea",
    worktreeId: digest(resolve(cwd)).slice(0, 16),
    nodeVersion: process.version,
    packageManagerDeclaration: declaration,
    packageManagerActual: null,
    head: head?.toString().trim() ?? null,
    sourceStatusDigest: status === null ? null : digest(status),
    sourceIdentityCoverage: "HEAD-and-tracked-status-only; not content identity",
    locks,
  };
}

async function space(cwd, enabled) {
  if (!enabled) return null;
  const disk = await safe(() => statfs(cwd));
  const directories = {};
  // Explicit, project-local paths only; no shared-store or whole-machine scan.
  for (const name of ["node_modules", "lib", ".runtime/packages"]) {
    directories[name] = await safe(async () => {
      const info = await lstat(join(cwd, name));
      if (!info.isDirectory()) return null;
      const out = execFileSync("du", ["-sk", join(cwd, name)], {
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      return Number(out.split(/\s/)[0]) * 1024;
    });
  }
  return {
    availableBytes: disk ? disk.bavail * disk.bsize : null,
    directoryAllocatedBytes: directories,
    attribution: "filesystem snapshot; APFS sharing and concurrent writes unknown",
  };
}

export async function runObserved({
  command,
  args = [],
  cwd = process.cwd(),
  task = "unknown",
  source = "unknown",
  condition = "unknown",
  logDir = defaultLogDir,
  sampleSpace = false,
  parentRunId = null,
  storage = { writeFile, appendFile },
}) {
  const preparation = performance.now();
  const runId = randomUUID();
  const file = join(logDir, `run-${runId}.jsonl`);
  const metadata = await snapshot(cwd);
  const base = {
    kind: KIND,
    schemaVersion: 1,
    collectorVersion: VERSION,
    skillVersion: VERSION,
    policyVersion: VERSION,
    runId,
    parentRunId: uuid.test(parentRunId ?? "") ? parentRunId : null,
    task: Object.hasOwn(tasks, task) ? task : "unknown",
    source: sources.includes(source) ? source : "unknown",
    condition: conditions.includes(condition) ? condition : "unknown",
    ...metadata,
  };
  let writable = true;
  const emit = async (event, first = false) => {
    if (!writable) return;
    try {
      const data = JSON.stringify({ ...base, ...event }) + "\n";
      if (first) await storage.writeFile(file, data, { flag: "wx", mode: 0o600 });
      else await storage.appendFile(file, data);
    } catch {
      writable = false;
      process.stderr.write("[dev-observe] measurement unavailable; command continues\n");
    }
  };
  await safe(async () => {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await rotate(logDir);
  });
  const startSpace = await space(cwd, sampleSpace);
  await emit({ event: "start", at: new Date().toISOString(), space: startSpace }, true);
  const preparationMs = performance.now() - preparation;
  const start = performance.now();
  const reported = {
    reused: null,
    downloaded: null,
    added: null,
    resolved: null,
    cacheHit: null,
    provenance: "unknown",
  };
  let requestedSignal = null;
  let tail = "";
  let actualVersion = null;
  // In a TTY keep native output behavior. Non-TTY output is streamed verbatim;
  // only bounded numeric progress fields are retained, never terminal content.
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, DEV_GOV_PARENT_RUN_ID: runId },
    stdio: ["inherit", process.stdout.isTTY ? "inherit" : "pipe", "inherit"],
  });
  if (child.stdout) {
    child.stdout.pipe(process.stdout, { end: false });
    child.stdout.on("data", (chunk) => {
      tail = (tail + chunk.toString()).slice(-4096);
      const matches = [
        ...tail.matchAll(/Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/g),
      ];
      const m = matches.at(-1);
      if (m)
        Object.assign(reported, {
          resolved: Number(m[1]),
          reused: Number(m[2]),
          downloaded: Number(m[3]),
          added: Number(m[4]),
          provenance: "pnpm-progress-final-observed; not build-cache-hit",
        });
      const v = /using pnpm v(\d+\.\d+\.\d+)/.exec(tail);
      if (v) actualVersion = `pnpm@${v[1]}`;
    });
  }
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => {
        requestedSignal ??= signal;
        try {
          if (process.platform === "win32") child.kill(signal);
          else process.kill(-child.pid, signal);
        } catch {
          /* already exited */
        }
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise((resolveResult) => {
    child.once("error", () => resolveResult({ code: 127, signal: null, spawnFailed: true }));
    child.once("close", (code, signal) => resolveResult({ code, signal, spawnFailed: false }));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  const durationMs = performance.now() - start;
  const finish = performance.now();
  const endSpace = await space(cwd, sampleSpace);
  await emit({
    event: "end",
    at: new Date().toISOString(),
    durationMs,
    exitCode: result.code,
    signal: result.signal,
    requestedSignal,
    cancelled: requestedSignal !== null || result.signal !== null,
    spawnFailed: result.spawnFailed,
    packageManagerActual: actualVersion,
    reported,
    space: endSpace,
    measurementPreparationMs: preparationMs,
    measurementFinalizationBeforeWriteMs: performance.now() - finish,
  });
  await safe(() => rotate(logDir));
  return { ...result, runId };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      source: { type: "string", default: "terminal" },
      condition: { type: "string", default: "unknown" },
      "sample-space": { type: "boolean", default: false },
    },
  });
  if (
    !Object.hasOwn(tasks, values.task ?? "") ||
    !sources.includes(values.source) ||
    !conditions.includes(values.condition)
  ) {
    console.error(
      "Use --task <install|build|build:host|typecheck|test|package|test:package|test:build|test:dependencies> [--source terminal|codex-action|benchmark] [--sample-space]",
    );
    process.exitCode = 2;
  } else {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    if (manifest.name !== "@cleverc2200/gea-dsh-prototype") throw new Error("GEA pilot only");
    if (process.platform === "win32")
      throw new Error(
        "GEA observation pilot supports POSIX only; use the normal project commands on Windows",
      );
    const result = await runObserved({
      command: "corepack",
      args: ["pnpm", ...tasks[values.task]],
      task: values.task,
      source: values.source,
      condition: values.condition,
      sampleSpace: values["sample-space"],
      parentRunId: process.env.DEV_GOV_PARENT_RUN_ID,
    });
    if (result.signal && process.platform !== "win32") process.kill(process.pid, result.signal);
    else process.exitCode = result.code ?? 1;
  }
}

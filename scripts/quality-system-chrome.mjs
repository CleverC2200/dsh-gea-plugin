/** Freeze one system Chrome distribution; mount it only in this job's hosted Linux VM. */
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  statSync,
  realpathSync,
  readlinkSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  symlinkSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  opendirSync,
} from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const SOURCE = "/opt/google/chrome",
  PREPARED = ".quality-system-chrome",
  RECEIPT = "system-chrome-preparation.json";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const reject = (detail) => {
  throw Error("QUALITY_SYSTEM_CHROME_REJECTED: " + detail);
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value, flag = "w") =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag });
function command(file, args) {
  const r = spawnSync(file, args, { encoding: "utf8", timeout: 30000 });
  if (r.error || r.signal || r.status !== 0)
    reject(file + ": " + (r.error?.message ?? r.signal ?? r.stderr ?? r.status));
  return r.stdout.trim();
}
function context(root) {
  root = resolve(root);
  if (
    realpathSync(root) !== root ||
    process.env.GITHUB_WORKSPACE !== root ||
    process.platform !== "linux" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.env.RUNNER_OS !== "Linux" ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "")
  )
    reject("private hosted Linux job required");
  return root;
}
function fixedSource() {
  for (const p of ["/opt", "/opt/google", SOURCE])
    if (realpathSync(p) !== p || !lstatSync(p).isDirectory())
      reject("system Chrome source redirected");
}
function fileHash(file) {
  const fd = openSync(file, "r"),
    digest = createHash("sha256"),
    buffer = Buffer.alloc(64 * 1024);
  try {
    let n;
    while ((n = readSync(fd, buffer)) > 0) digest.update(buffer.subarray(0, n));
    return digest.digest("hex");
  } finally {
    closeSync(fd);
  }
}
const safe = (path) =>
  typeof path === "string" &&
  path !== "" &&
  !isAbsolute(path) &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((p) => p && p !== "." && p !== "..");
function observeRoot(path) {
  let stat,
    realpath = null;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return {
      path,
      type: error.code === "ENOENT" ? "missing" : "unavailable",
      mode: null,
      realpath,
      errorCode: error.code ?? null,
    };
  }
  try {
    realpath = realpathSync(path);
  } catch {}
  return {
    path,
    type: stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : stat.isFile()
          ? "file"
          : "other",
    mode: stat.mode & 0o7777,
    realpath,
  };
}
function inventory(root, { source = false, verifiedHashes } = {}) {
  const observed = observeRoot(root);
  if (
    observed.realpath !== root ||
    observed.type !== "directory" ||
    !Number.isInteger(observed.mode) ||
    (source ? observed.mode > 0o777 : observed.mode !== 0o755)
  )
    reject("Chrome root mode/path: " + JSON.stringify(observed));
  const entries = [];
  const walk = (prefix) => {
    for (const name of readdirSync(join(root, prefix)).sort()) {
      const path = prefix ? prefix + "/" + name : name;
      if (!safe(path)) reject("unsafe Chrome path");
      const full = join(root, path),
        s = lstatSync(full),
        sourceMode = s.mode & 0o7777;
      if (s.isDirectory()) {
        if (source ? sourceMode > 0o777 : sourceMode !== 0o755) reject("Chrome directory mode");
        entries.push({ path, type: "directory", mode: 0o755, sourceMode });
        walk(path);
        continue;
      }
      if (s.isSymbolicLink()) {
        const target = readlinkSync(full),
          resolved = resolve(dirname(full), target);
        if (
          !target ||
          isAbsolute(target) ||
          target.includes("\\") ||
          target.includes("\0") ||
          !resolved.startsWith(root + "/")
        )
          reject("Chrome external link");
        let actual;
        try {
          actual = realpathSync(full);
        } catch {
          reject("Chrome dangling/cyclic link");
        }
        if (!actual.startsWith(root + "/")) reject("Chrome resolved link escapes");
        entries.push({ path, type: "symlink", mode: sourceMode, sourceMode, target });
        continue;
      }
      if (!s.isFile() || s.nlink !== 1) reject("Chrome regular unlinked file required");
      const mode =
        source && path === "chrome-sandbox" && sourceMode === 0o4755 ? 0o755 : sourceMode;
      if (mode > 0o777) reject("Chrome special mode");
      entries.push({
        path,
        type: "file",
        mode,
        sourceMode,
        size: s.size,
        sha256: verifiedHashes ? verifiedHashes[path] : fileHash(full),
      });
    }
  };
  walk("");
  if (!entries.some((x) => x.path === "chrome" && x.type === "file" && x.mode & 0o111))
    reject("Chrome executable required");
  return entries;
}
const ordinary = (entries) => entries.map(({ sourceMode: _sourceMode, ...entry }) => entry);
function metadata(receipt, bytes) {
  return {
    source: SOURCE,
    sourceRootMode: receipt.sourceRootMode,
    prepared: receipt.prepared,
    version: receipt.version,
    package: receipt.package,
    snapshotSha256: receipt.snapshotSha256,
    receiptSha256: hash(bytes),
    fileCount: receipt.entries.filter((x) => x.type === "file").length,
    logicalBytes: receipt.entries.reduce((n, x) => n + (x.size ?? 0), 0),
  };
}
export function readSystemChrome({ root, expected, verifyBytes = true, verifiedHashes }) {
  root = resolve(root);
  if (realpathSync(root) !== root) reject("private Chrome root");
  const bytes = readFileSync(join(root, RECEIPT)),
    receipt = JSON.parse(bytes);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.status !== "system-chrome-prepared" ||
    receipt.root !== root ||
    receipt.source !== SOURCE ||
    !Number.isInteger(receipt.sourceRootMode) ||
    receipt.sourceRootMode < 0 ||
    receipt.sourceRootMode > 0o777 ||
    receipt.prepared !== join(root, PREPARED) ||
    typeof receipt.version !== "string" ||
    !/^Google Chrome \d+\.\d+\.\d+\.\d+$/.test(receipt.version) ||
    receipt.package?.name !== "google-chrome-stable" ||
    !receipt.package.version ||
    !receipt.package.arch ||
    !Array.isArray(receipt.entries) ||
    !receipt.entries.length
  )
    reject("fixed Chrome receipt");
  for (const e of receipt.entries) {
    if (
      !safe(e.path) ||
      !["directory", "file", "symlink"].includes(e.type) ||
      !Number.isInteger(e.mode) ||
      e.mode < 0 ||
      e.mode > 0o777 ||
      (e.type === "directory" && e.mode !== 0o755) ||
      !Number.isInteger(e.sourceMode) ||
      e.sourceMode < 0 ||
      (e.sourceMode !== e.mode &&
        !(e.type === "directory" && e.sourceMode <= 0o777 && e.mode === 0o755) &&
        !(
          e.path === "chrome-sandbox" &&
          e.type === "file" &&
          e.sourceMode === 0o4755 &&
          e.mode === 0o755
        ))
    )
      reject("Chrome inventory mode/path");
  }
  if (
    hash(
      JSON.stringify({
        source: receipt.source,
        sourceRootMode: receipt.sourceRootMode,
        prepared: receipt.prepared,
        version: receipt.version,
        package: receipt.package,
        entries: receipt.entries,
      }),
    ) !== receipt.snapshotSha256
  )
    reject("Chrome inventory digest");
  const result = metadata(receipt, bytes);
  if (expected && JSON.stringify(result) !== JSON.stringify(expected))
    reject("Chrome binding changed");
  if (
    verifyBytes &&
    JSON.stringify(ordinary(inventory(receipt.prepared, { verifiedHashes }))) !==
      JSON.stringify(ordinary(receipt.entries))
  )
    reject("Chrome snapshot bytes/mode/link changed");
  return result;
}
/** Rebuild authenticated 0755 directories, including empty ones; tar still admits files/symlinks only. */
export function restoreSystemChromeDirectories({ root, expected }) {
  readSystemChrome({ root, expected, verifyBytes: false });
  const receipt = json(join(root, RECEIPT));
  for (const entry of receipt.entries.filter((x) => x.type === "directory")) {
    const path = join(root, PREPARED, entry.path),
      parent = dirname(path);
    if (realpathSync(parent) !== parent || !lstatSync(parent).isDirectory())
      reject("Chrome directory parent redirected");
    if (existsSync(path)) {
      if (
        realpathSync(path) !== path ||
        !lstatSync(path).isDirectory() ||
        (lstatSync(path).mode & 0o7777) !== 0o755
      )
        reject("Chrome directory mode/path changed");
    } else {
      mkdirSync(path, { mode: 0o755 });
      chmodSync(path, 0o755);
    }
  }
}
function readChromePackage(version) {
  const packageLine = command("dpkg-query", [
    "--show",
    "--showformat=${Package}\t${Version}\t${Architecture}\n",
    "google-chrome-stable",
  ]).split("\t");
  if (
    packageLine.length !== 3 ||
    packageLine[0] !== "google-chrome-stable" ||
    !packageLine[1].startsWith(version.replace("Google Chrome ", "") + "-")
  )
    reject("installed Chrome package identity");
  const files = command("dpkg-query", ["--listfiles", "google-chrome-stable"]).split("\n").sort();
  return { identity: packageLine, files };
}
export async function prepareSystemChrome({ root }) {
  root = context(root);
  const plan = json(join(root, "quality-test-plan.json"));
  if (plan.browser !== true) return { status: "system-chrome-not-required" };
  const startedAt = new Date().toISOString(),
    prepared = join(root, PREPARED);
  if (existsSync(prepared) || existsSync(join(root, RECEIPT)))
    reject("Chrome snapshot already exists");
  const sourceRoot = observeRoot(SOURCE);
  process.stderr.write("[quality-system-chrome-source] " + JSON.stringify(sourceRoot) + "\n");
  fixedSource();
  const version = command(SOURCE + "/chrome", ["--version"]);
  const packageBefore = readChromePackage(version),
    packageLine = packageBefore.identity,
    owned = new Set(packageBefore.files);
  const before = inventory(SOURCE, { source: true });
  if (!owned.has(SOURCE) || before.some((e) => !owned.has(SOURCE + "/" + e.path)))
    reject("Chrome contains non-package files");
  const require = createRequire(join(root, "candidate/dsh-gea-plugin/package.json")),
    { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    if (browser.version() !== version.replace("Google Chrome ", ""))
      reject("producer Chrome launch version");
  } finally {
    await browser.close();
  }
  mkdirSync(prepared, { mode: 0o755 });
  chmodSync(prepared, 0o755);
  for (const e of before) {
    const target = join(prepared, e.path);
    if (e.type === "directory") {
      mkdirSync(target, { mode: e.mode });
      chmodSync(target, e.mode);
    } else if (e.type === "symlink") symlinkSync(e.target, target);
    else {
      copyFileSync(join(SOURCE, e.path), target);
      chmodSync(target, e.mode);
    }
  }
  const afterVersion = command(SOURCE + "/chrome", ["--version"]);
  const afterSourceRoot = observeRoot(SOURCE);
  if (
    afterVersion !== version ||
    JSON.stringify(afterSourceRoot) !== JSON.stringify(sourceRoot) ||
    JSON.stringify(inventory(SOURCE, { source: true })) !== JSON.stringify(before) ||
    JSON.stringify(ordinary(inventory(prepared))) !== JSON.stringify(ordinary(before))
  )
    reject(
      "Chrome changed during snapshot: " +
        JSON.stringify({ before: sourceRoot, after: afterSourceRoot }),
    );
  if (JSON.stringify(readChromePackage(version)) !== JSON.stringify(packageBefore))
    reject("Chrome package changed during snapshot");
  const pkg = {
    name: packageLine[0],
    version: packageLine[1],
    arch: packageLine[2],
    filesSha256: hash(JSON.stringify(packageBefore.files)),
  };
  const receipt = {
    schemaVersion: 1,
    status: "system-chrome-prepared",
    root,
    source: SOURCE,
    sourceRootMode: sourceRoot.mode,
    prepared,
    version,
    package: pkg,
    entries: before,
  };
  receipt.snapshotSha256 = hash(
    JSON.stringify({
      source: SOURCE,
      sourceRootMode: sourceRoot.mode,
      prepared,
      version,
      package: pkg,
      entries: before,
    }),
  );
  receipt.preparation = {
    sourceRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(startedAt),
  };
  write(join(root, RECEIPT), receipt, "wx");
  return readSystemChrome({ root });
}
function mountInfo(timeout = 10000) {
  const r = spawnSync("findmnt", ["--json", "--mountpoint", SOURCE, "--output", "TARGET,OPTIONS"], {
    encoding: "utf8",
    timeout,
  });
  if (r.status === 1 && !r.error && !r.signal) return null;
  if (r.error || r.signal || r.status !== 0) {
    const error = Error("QUALITY_SYSTEM_CHROME_REJECTED: mount inspection failed");
    error.commandFailure = {
      command: "findmnt",
      status: r.status,
      signal: r.signal ?? null,
      errorCode: r.error?.code ?? null,
      errorMessage: r.error?.message ?? null,
      stderr: r.stderr ?? null,
    };
    throw error;
  }
  const rows = JSON.parse(r.stdout).filesystems;
  if (rows?.length !== 1 || rows[0].target !== SOURCE) reject("unexpected Chrome mount target");
  return rows[0];
}
function sameRoot(prepared) {
  const a = statSync(prepared),
    b = statSync(SOURCE);
  if (a.dev !== b.dev || a.ino !== b.ino) reject("Chrome mount source changed");
}
export function mountSystemChrome({ root, expected }) {
  root = context(root);
  fixedSource();
  const snapshot = readSystemChrome({ root, expected });
  if (mountInfo()) reject("unknown existing Chrome mount");
  const marker = {
    schemaVersion: 1,
    status: "mounting",
    root,
    source: snapshot.prepared,
    target: SOURCE,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    snapshot,
  };
  write(join(root, "quality-system-chrome-mount.json"), marker, "wx");
  command("sudo", ["-n", "mount", "--bind", snapshot.prepared, SOURCE]);
  command("sudo", ["-n", "mount", "-o", "remount,bind,ro", SOURCE]);
  const mounted = mountInfo();
  if (!mounted?.options?.split(",").includes("ro")) reject("Chrome mount is not readonly");
  sameRoot(snapshot.prepared);
  if (command(SOURCE + "/chrome", ["--version"]) !== snapshot.version)
    reject("mounted Chrome version changed");
  marker.status = "system-chrome-mounted";
  write(join(root, "quality-system-chrome-mount.json"), marker);
  return marker;
}
// Diagnostic observations never grant ownership or authorize unmount/termination.
function mountReferences(prepared, deadline) {
  const started = performance.now(),
    limits = {
      budgetMs: Math.min(250, Math.max(0, deadline - started - 100)),
      maxProcesses: 256,
      maxFds: 64,
      maxReferences: 32,
      maxFileBytes: 65536,
    },
    stop = started + limits.budgetMs,
    result = {
      scope: "read-only-proc-candidate-references",
      holderProof: "unknown",
      limits,
      processesScanned: 0,
      references: [],
      mounts: [],
      unknown: [],
      unknownCount: 0,
    };
  const unknown = (kind, pid) => {
    result.unknownCount++;
    if (result.unknown.some((observation) => observation.kind === kind)) return;
    if (result.unknown.length >= 32) {
      result.unknownTruncated = true;
      return;
    }
    if (result.unknown.length < 32)
      result.unknown.push({ kind, ...(pid === undefined ? {} : { pid }) });
  };
  const available = () => {
    if (performance.now() < stop) return true;
    unknown("deadline");
    return false;
  };
  const read = (file) => {
    let fd;
    try {
      fd = openSync(file, "r");
      const bytes = Buffer.alloc(limits.maxFileBytes + 1);
      let size = 0;
      while (available() && size < bytes.length) {
        const n = readSync(fd, bytes, size, bytes.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size > limits.maxFileBytes) unknown("file-truncated");
      return bytes.subarray(0, Math.min(size, limits.maxFileBytes)).toString("utf8");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };
  const within = (path) =>
    [SOURCE, prepared].some((base) => path === base || path.startsWith(base + "/"));
  const add = (process, kind, path) => {
    if (result.references.length >= limits.maxReferences) {
      unknown("references-truncated");
      return;
    }
    result.references.push({ ...process, kind, path });
  };
  try {
    if (available()) {
      const mountinfo = read("/proc/self/mountinfo");
      for (const row of mountinfo.split("\n")) {
        const fields = row.split(" "),
          path = fields[4]?.replace(/\\([0-7]{3})/g, (_, octal) =>
            String.fromCharCode(parseInt(octal, 8)),
          );
        if (path && (path === SOURCE || path.startsWith(SOURCE + "/"))) {
          if (result.mounts.length >= 32) {
            unknown("mounts-truncated");
            break;
          }
          result.mounts.push({
            id: Number(fields[0]),
            parentId: Number(fields[1]),
            target: path,
            readonly: fields[5]?.split(",").includes("ro") ?? false,
          });
        }
      }
    }
  } catch (error) {
    unknown(error.code ?? "mountinfo-unavailable");
  }
  let processes;
  try {
    if (available()) processes = opendirSync("/proc");
    while (processes && available() && result.references.length < limits.maxReferences) {
      const entry = processes.readSync();
      if (!entry) break;
      if (!/^\d+$/.test(entry.name)) continue;
      if (result.processesScanned >= limits.maxProcesses) {
        unknown("processes-truncated");
        break;
      }
      const pid = Number(entry.name),
        base = "/proc/" + entry.name;
      result.processesScanned++;
      try {
        const stat = read(base + "/stat"),
          end = stat.lastIndexOf(")"),
          begin = stat.indexOf("("),
          fields = stat
            .slice(end + 2)
            .trim()
            .split(/\s+/);
        if (
          begin < 1 ||
          end < begin ||
          !/^\d+$/.test(fields[1] ?? "") ||
          !/^\d+$/.test(fields[19] ?? "")
        ) {
          unknown("invalid-stat", pid);
          continue;
        }
        const process = {
          pid,
          ppid: Number(fields[1]),
          starttime: fields[19],
          comm: stat.slice(begin + 1, end).slice(0, 64),
        };
        const link = (kind, file) => {
          if (!available()) return;
          try {
            const path = readlinkSync(file).replace(/ \(deleted\)$/, "");
            if (within(path)) add(process, kind, path);
          } catch (error) {
            unknown(error.code ?? "link-unavailable", pid);
          }
        };
        for (const kind of ["cwd", "root", "exe"]) link(kind, base + "/" + kind);
        let descriptors;
        try {
          if (available()) descriptors = opendirSync(base + "/fd");
          let count = 0;
          while (descriptors && available()) {
            const descriptor = descriptors.readSync();
            if (!descriptor) break;
            if (count++ >= limits.maxFds) {
              unknown("fds-truncated", pid);
              break;
            }
            link("fd", base + "/fd/" + descriptor.name);
          }
        } catch (error) {
          unknown(error.code ?? "fds-unavailable", pid);
        } finally {
          descriptors?.closeSync();
        }
        if (available()) {
          try {
            for (const line of read(base + "/maps").split("\n")) {
              if (!available()) break;
              const path = line
                .match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/)?.[1]
                ?.replace(/ \(deleted\)$/, "");
              if (path && within(path)) add(process, "maps", path);
            }
          } catch (error) {
            unknown(error.code ?? "maps-unavailable", pid);
          }
        }
      } catch (error) {
        unknown(error.code ?? "process-unavailable", pid);
      }
    }
  } catch (error) {
    unknown(error.code ?? "proc-unavailable");
  } finally {
    processes?.closeSync();
  }
  result.durationMs = performance.now() - started;
  return result;
}
export async function cleanupSystemChrome({ root }) {
  const startedAt = new Date().toISOString();
  root = context(root);
  const file = join(root, "quality-system-chrome-mount.json");
  if (!existsSync(file)) {
    if (mountInfo()) reject("unknown Chrome mount without owner");
    return { status: "system-chrome-not-mounted" };
  }
  const markerBytes = readFileSync(file, "utf8"),
    marker = JSON.parse(markerBytes);
  if (
    marker.schemaVersion !== 1 ||
    !["mounting", "system-chrome-mounted"].includes(marker.status) ||
    !/^[a-f0-9]{64}$/.test(marker.snapshot?.snapshotSha256 ?? "") ||
    marker.root !== root ||
    marker.source !== join(root, PREPARED) ||
    marker.target !== SOURCE ||
    marker.runId !== process.env.GITHUB_RUN_ID ||
    marker.runAttempt !== process.env.GITHUB_RUN_ATTEMPT
  )
    reject("Chrome mount ownership changed");
  const unmount = { timeoutMs: 10000, retryIntervalMs: 100, attempts: [] };
  let error;
  try {
    readSystemChrome({ root, expected: marker.snapshot });
  } catch (e) {
    error = e;
  }
  try {
    const mounted = mountInfo();
    if (!mounted && marker.status === "system-chrome-mounted")
      reject("previously mounted Chrome is missing");
    if (mounted) {
      const source = statSync(marker.source),
        deadline = performance.now() + unmount.timeoutMs;
      let current = mounted;
      const commandBudget = async (command) => {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining < unmount.retryIntervalMs) {
          unmount.stopReason = {
            kind: "insufficient-command-budget",
            command,
            remainingMs: Math.max(0, remaining),
            minimumMs: unmount.retryIntervalMs,
          };
          if (remaining > 0) await delay(remaining);
          reject(
            unmount.firstBusy && !unmount.unmountSucceeded
              ? "Chrome unmount remained busy after 10000ms"
              : "Chrome cleanup command budget exhausted before " + command,
          );
        }
        return remaining;
      };
      for (;;) {
        fixedSource();
        if (readFileSync(file, "utf8") !== markerBytes) reject("Chrome mount ownership changed");
        if (!current) reject("previously mounted Chrome is missing");
        if (
          current.options !== mounted.options ||
          (marker.status === "system-chrome-mounted" && !current.options?.split(",").includes("ro"))
        )
          reject("Chrome mount options changed");
        const prepared = statSync(marker.source);
        if (prepared.dev !== source.dev || prepared.ino !== source.ino)
          reject("Chrome mount source changed");
        sameRoot(marker.source);
        const remaining = await commandBudget("sudo");
        const started = performance.now(),
          attempt = {
            startedAt: new Date().toISOString(),
          },
          result = spawnSync("sudo", ["-n", "umount", SOURCE], {
            encoding: "utf8",
            timeout: remaining,
            env: { ...process.env, LC_ALL: "C", LANG: "C" },
          });
        Object.assign(attempt, {
          durationMs: performance.now() - started,
          status: result.status,
          signal: result.signal ?? null,
          errorCode: result.error?.code ?? null,
          errorMessage: result.error?.message ?? null,
          stderr: result.stderr ?? null,
        });
        unmount.attempts.push(attempt);
        if (!result.error && !result.signal && result.status === 0) {
          unmount.unmountSucceeded = true;
          if (mountInfo(await commandBudget("findmnt"))) reject("Chrome mount remains");
          break;
        }
        if (
          result.error ||
          result.signal ||
          result.status !== 32 ||
          result.stderr?.trim() !== "umount: /opt/google/chrome: target is busy."
        ) {
          unmount.terminalFailure = { command: "sudo", ...attempt };
          if (
            unmount.firstBusy &&
            result.error?.code === "ETIMEDOUT" &&
            performance.now() >= deadline
          )
            reject("Chrome unmount remained busy after 10000ms");
          reject(
            "sudo: " + (result.error?.message ?? result.signal ?? result.stderr ?? result.status),
          );
        }
        unmount.firstBusy ??= attempt;
        unmount.lastBusy = attempt;
        if (!unmount.referenceDiagnostics) {
          try {
            unmount.referenceDiagnostics = mountReferences(marker.source, deadline);
          } catch (diagnosticError) {
            unmount.referenceDiagnostics = {
              scope: "read-only-proc-candidate-references",
              holderProof: "unknown",
              unknown: [{ kind: diagnosticError.code ?? "diagnostic-failed" }],
            };
          }
        }
        const waitMs = deadline - performance.now();
        if (waitMs <= 0) reject("Chrome unmount remained busy after 10000ms");
        await delay(Math.min(unmount.retryIntervalMs, waitMs));
        const inspectionMs = await commandBudget("findmnt");
        try {
          current = mountInfo(inspectionMs);
        } catch (inspectionError) {
          if (inspectionError.commandFailure) {
            unmount.terminalFailure = inspectionError.commandFailure;
            if (
              unmount.firstBusy &&
              inspectionError.commandFailure.errorCode === "ETIMEDOUT" &&
              performance.now() >= deadline
            )
              reject("Chrome unmount remained busy after 10000ms");
          }
          throw inspectionError;
        }
      }
    }
  } catch (e) {
    unmount.terminalFailure ??= e.commandFailure;
    error ??= e;
  }
  const result = {
    schemaVersion: 1,
    status: error ? "failed" : "system-chrome-unmounted",
    startedAt,
    durationMs: Date.now() - Date.parse(startedAt),
    snapshotSha256: marker.snapshot.snapshotSha256,
    unmount,
    finishedAt: new Date().toISOString(),
    error: error?.message ?? null,
  };
  write(join(root, "quality-system-chrome-cleanup.json"), result);
  if (error) throw error;
  return result;
}
export async function chromeCli(args) {
  const {
    values,
    positionals: [action],
  } = parseArgs({ args, allowPositionals: true, options: { root: { type: "string" } } });
  if (!values.root) reject("explicit workspace required");
  if (action === "prepare") return prepareSystemChrome(values);
  if (action === "mount") return mountSystemChrome(values);
  if (action === "cleanup") return cleanupSystemChrome(values);
  reject("explicit prepare/mount/cleanup required");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  chromeCli(process.argv.slice(2))
    .then((value) => process.stdout.write(JSON.stringify(value) + "\n"))
    .catch((error) => {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    });

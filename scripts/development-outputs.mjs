import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import cp, { execFileSync } from "node:child_process";

const inside = (root, path) => {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
};
const text = (value) => typeof value === "string" && value.trim().length > 0;
function exists(path) {
  try {
    fs.lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function physical(path, missing = false) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    /[\0\r\n]/.test(path)
  )
    throw Error("OUTPUT_ABSOLUTE_PHYSICAL_PATH_REQUIRED");
  let parent = path;
  while (!exists(parent)) parent = dirname(parent);
  if (fs.realpathSync(parent) !== parent) throw Error("OUTPUT_PATH_LINK_FORBIDDEN");
  if (!missing && parent !== path) throw Error("OUTPUT_PATH_MISSING");
  return path;
}
function read(file) {
  physical(file);
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 ** 2)
    throw Error("OUTPUT_SCOPED_FILE_REQUIRED");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function readable(file) {
  physical(file);
  if (!fs.statSync(file).isFile()) throw Error("OUTPUT_EVIDENCE_FILE_REQUIRED");
  fs.accessSync(file, fs.constants.R_OK);
}

export function checkDevelopmentOutputs(file, lockFile) {
  const issues = [];
  let manifest;
  let items = [];
  let retainedAllocatedBytes = null;
  try {
    manifest = read(file);
    if (
      manifest.schemaVersion !== 1 ||
      !text(manifest.task) ||
      !text(manifest.owner) ||
      !Array.isArray(manifest.items)
    )
      throw Error("OUTPUT_MANIFEST_REQUIRED");
    if (!Array.isArray(manifest.roots) || !manifest.roots.length)
      throw Error("OUTPUT_TASK_ROOT_REQUIRED");
    if (!manifest.roots.some((root) => typeof root === "string" && inside(root, file)))
      throw Error("OUTPUT_MANIFEST_TASK_ROOT_REQUIRED");
    for (const [index, root] of manifest.roots.entries()) {
      physical(root, true);
      if (
        root === parse(root).root ||
        root === fs.realpathSync(os.homedir()) ||
        exists(join(root, ".git")) ||
        exists(join(root, "package.json")) ||
        manifest.roots
          .slice(0, index)
          .some((previous) => inside(previous, root) || inside(root, previous))
      )
        throw Error("OUTPUT_TASK_ROOT_REQUIRED");
    }
    const paths = [];
    for (const item of manifest.items) {
      physical(item.path, true);
      if (
        item.path === file ||
        !manifest.roots.some((root) => inside(root, item.path)) ||
        paths.some((path) => inside(path, item.path) || inside(item.path, path))
      )
        throw Error("OUTPUT_PATH_OUTSIDE_OR_OVERLAPPING");
      paths.push(item.path);
      if (!["generated", "artifact", "source", "failure-evidence", "user-data"].includes(item.kind))
        throw Error("OUTPUT_KIND_REQUIRED");
      if (item.disposition === "retain" ? !text(item.reason) : !["remove", "cleanup"].includes(item.disposition))
        issues.push({ path: item.path, reason: "OUTPUT_DISPOSITION_REQUIRED" });
      if (item.disposition === "retain" && !exists(item.path))
        issues.push({
          path: item.path,
          reason: "OUTPUT_RETAINED_PATH_MISSING",
        });
      if (item.kind === "generated") {
        try {
          if (!Array.isArray(item.restoreFrom) || !item.restoreFrom.length)
            throw Error("OUTPUT_RECOVERY_SOURCE_REQUIRED");
          for (const source of item.restoreFrom) {
            readable(source);
            if (inside(item.path, source)) throw Error("OUTPUT_RECOVERY_INSIDE_GENERATED_PATH");
          }
        } catch (error) {
          issues.push({ path: item.path, reason: error.message });
        }
      }
      if (item.disposition === "cleanup") {
        issues.push({ path: item.path, reason: item.kind === "generated" ? "OUTPUT_CLEANUP_PENDING" : "OUTPUT_PROTECTED_KIND" });
      }
      if (item.disposition === "remove") {
        try {
          if (item.kind !== "generated") throw Error("OUTPUT_PROTECTED_KIND");
          if (inside(item.path, item.cleanupReceipt ?? ""))
            throw Error("OUTPUT_RECEIPT_INSIDE_REMOVED_PATH");
          const receipt = read(item.cleanupReceipt);
          const records = receipt.items?.filter((entry) => entry.path === item.path);
          if (
            records?.length !== 1 ||
            records[0].removed !== true ||
            !Number.isFinite(Date.parse(records[0].startedAt)) ||
            !Number.isFinite(Date.parse(records[0].completedAt)) ||
            Date.parse(records[0].completedAt) < Date.parse(records[0].startedAt)
          )
            throw Error("OUTPUT_CLEANUP_RECEIPT_REQUIRED");
        } catch (error) {
          issues.push({ path: item.path, reason: error.message });
        }
        if (exists(item.path)) issues.push({ path: item.path, reason: "OUTPUT_STILL_PRESENT" });
      }
    }
    const inspect = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (path === file || path === lockFile) continue;
        if (path === file + ".finish-state") {
          checkFinishState(path, manifest);
          continue;
        }
        if (path === file + ".cleanup.json") {
          const journal = read(path);
          if (journal.task === manifest.task && journal.owner === manifest.owner && journal.items?.every((record) => manifest.items.some((item) => item.path === record.path))) continue;
        }
        if (!paths.some((declared) => inside(declared, path) || inside(path, declared))) {
          issues.push({ path, reason: "OUTPUT_UNDECLARED" });
          continue;
        }
        if (entry.isSymbolicLink()) {
          let target;
          try {
            target = fs.realpathSync(path);
          } catch {
            issues.push({ path, reason: "OUTPUT_LINK_TARGET_UNKNOWN" });
          }
          if (target && !manifest.roots.some((root) => inside(root, target)))
            issues.push({ path, reason: "OUTPUT_LINK_ESCAPE" });
        } else if (entry.isDirectory()) inspect(path);
      }
    };
    for (const root of manifest.roots) {
      if (exists(root)) {
        if (fs.statSync(root).isDirectory()) inspect(root);
        else if (!paths.includes(root)) issues.push({ path: root, reason: "OUTPUT_UNDECLARED" });
      } else if (
        !manifest.items.some((item) => item.path === root && ["remove", "cleanup"].includes(item.disposition))
      ) {
        issues.push({ path: root, reason: "OUTPUT_ROOT_MISSING" });
      }
    }
    const retained = manifest.items.filter(
      (item) => item.disposition === "retain" && exists(item.path),
    );
    const measured = retained.length
      ? execFileSync("du", ["-sk", ...retained.map((item) => item.path)], {
          encoding: "utf8",
        })
          .trimEnd()
          .split("\n")
      : [];
    if (measured.length !== retained.length) throw Error("OUTPUT_MEASUREMENT_FAILED");
    const sizes = new Map(
      measured.map((row, index) => {
        const separator = row.indexOf("\t");
        const amount = row.slice(0, separator);
        if (!/^\d+$/.test(amount) || row.slice(separator + 1) !== retained[index].path)
          throw Error("OUTPUT_MEASUREMENT_FAILED");
        return [retained[index].path, Number(amount) * 1024];
      }),
    );
    retainedAllocatedBytes = [...sizes.values()].reduce((sum, value) => sum + value, 0);
    items = manifest.items.map((item) => ({
      ...item,
      allocatedBytes: sizes.get(item.path) ?? null,
    }));
  } catch (error) {
    issues.push({ path: file ?? null, reason: error.message });
  }
  return {
    status: issues.length ? "needs-disposition" : "disposition-complete",
    scope: "declared-task-outputs",
    task: manifest?.task ?? null,
    owner: manifest?.owner ?? null,
    roots: manifest?.roots ?? [],
    manifest: file ?? null,
    items: items.length ? items : (manifest?.items ?? []),
    retainedAllocatedBytes,
    measurement: "du -sk; allocated bytes, not exclusive APFS blocks",
    performsCleanup: false,
    livePreflightVerified: false,
    issues,
  };
}

function assertDisposable(path) {
  physical(path);
  const protectedNames = new Set([
    ".git",
    "sessionData",
    "userData",
    "profiles",
    "sessions",
    "drafts",
    "credentials",
    "selected-resources.json",
    "user-agents.json",
    "credentials.json",
    "MEMORY.md",
  ]);
  if (path.split(sep).some((name) => protectedNames.has(name)))
    throw Error("OUTPUT_SOURCE_OR_USER_STATE");
  if (!fs.statSync(path).isDirectory()) throw Error("OUTPUT_GENERATED_DIRECTORY_REQUIRED");
  const inspect = (target) => {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink()) return;
    if (!info.isDirectory()) return;
    for (const name of fs.readdirSync(target)) {
      if (protectedNames.has(name)) throw Error("OUTPUT_SOURCE_OR_USER_STATE");
      inspect(join(target, name));
    }
  };
  inspect(path);
  const git = cp.spawnSync(
    "git",
    ["-C", fs.statSync(path).isDirectory() ? path : dirname(path), "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  if (git.status === 0) {
    const root = fs.realpathSync(git.stdout.trim());
    const tracked = cp.execFileSync(
      "git",
      ["-C", root, "ls-files", "-z", "--", relative(root, path)],
      { encoding: "utf8" },
    );
    if (tracked) throw Error("OUTPUT_TRACKED_SOURCE");
    const untracked = cp.execFileSync(
      "git",
      ["-C", root, "ls-files", "--others", "--exclude-standard", "-z", "--", relative(root, path)],
      { encoding: "utf8" },
    );
    if (untracked) throw Error("OUTPUT_UNTRACKED_SOURCE");
    const gitdir = cp
      .execFileSync("git", ["-C", root, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" })
      .trim();
    if (exists(join(gitdir, "index.lock"))) throw Error("OUTPUT_GIT_LOCKED");
    return root;
  } else if (git.error || git.status !== 128) throw Error("OUTPUT_GIT_STATE_UNKNOWN");
}

function assertIdle(path, roots, activityRoot) {
  if (!["darwin", "linux"].includes(process.platform)) throw Error("OUTPUT_LIVE_CHECK_UNSUPPORTED");
  const open = cp.spawnSync("lsof", ["-nP", "-Fpfn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 ** 2,
  });
  if (open.error || open.status !== 0 || !open.stdout) throw Error("OUTPUT_LIVE_CHECK_UNKNOWN");
  let pid, descriptor;
  for (const row of open.stdout.split("\n")) {
    if (row.startsWith("p")) pid = Number(row.slice(1));
    if (row.startsWith("f")) descriptor = row.slice(1);
    if (
      row.startsWith("n") &&
      isAbsolute(row.slice(1)) &&
      (inside(path, row.slice(1)) ||
        (pid !== process.pid &&
          descriptor === "cwd" &&
          inside(activityRoot, row.slice(1)) &&
          inside(row.slice(1), path)))
    )
      throw Error("OUTPUT_ACTIVE_READER");
  }
  const processes = cp.execFileSync("ps", ["-axo", "pid=,args="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 ** 2,
  });
  for (const row of processes.split("\n")) {
    const match = row.match(/^\s*(\d+)\s+([\s\S]*)$/);
    if (
      match &&
      Number(match[1]) !== process.pid &&
      new RegExp(
        "(?:^|[\\s\"'=])" + path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[/\\s\"'])",
      ).test(match[2])
    )
      throw Error("OUTPUT_ACTIVE_PROCESS");
  }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (inside(path, target)) continue;
      if (entry.isSymbolicLink()) {
        let linked;
        try {
          linked = fs.realpathSync(target);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        if (inside(path, linked) || inside(linked, path)) throw Error("OUTPUT_DEPENDENCY_READER");
      } else if (entry.isDirectory() && entry.name !== ".git") visit(target);
    }
  };
  for (const root of roots) visit(root);
}

function checkFinishState(directory, manifest) {
  physical(directory);
  const owner = read(join(directory, "owner.json"));
  if (owner.task !== manifest.task || owner.owner !== manifest.owner)
    throw Error("OUTPUT_TRANSACTION_OWNER_MISMATCH");
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^(?:owner\.json|claim\.json|record-[a-f0-9-]{36}\.json)$/.test(entry.name)
    )
      throw Error("OUTPUT_TRANSACTION_UNKNOWN_FILE");
  }
}

function prepareFinishState(directory, manifest) {
  physical(directory, true);
  fs.mkdirSync(directory, { recursive: true });
  const owner = join(directory, "owner.json");
  try {
    fs.writeFileSync(owner, JSON.stringify({ task: manifest.task, owner: manifest.owner }), {
      flag: "wx",
      flush: true,
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  checkFinishState(directory, manifest);
}

function writeRecord(file, value, state) {
  physical(file, true);
  const temporary = join(state, "record-" + randomUUID() + ".json");
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function releaseDeadLock(file, task, owner) {
  if (!exists(file)) return true;
  const before = fs.lstatSync(file);
  const lock = read(file);
  if (!Number.isSafeInteger(lock.pid) || lock.pid < 1 || lock.task !== task || lock.owner !== owner)
    return false;
  try {
    process.kill(lock.pid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }
  const current = fs.lstatSync(file);
  if (
    before.ino !== current.ino ||
    before.dev !== current.dev ||
    JSON.stringify(read(file)) !== JSON.stringify(lock)
  )
    return false;
  fs.unlinkSync(file);
  return true;
}

function lockFinish(file, task, owner, state) {
  const claim = join(state, "claim.json");
  try {
    if (!releaseDeadLock(claim, task, owner)) return false;
    fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, task, owner }), {
      flag: "wx",
      flush: true,
    });
  } catch {
    return false;
  }
  try {
    if (!releaseDeadLock(file, task, owner)) return false;
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, task, owner }), {
      flag: "wx",
      flush: true,
    });
    return true;
  } catch {
    return false;
  } finally {
    fs.unlinkSync(claim);
  }
}

export function finishDevelopmentOutputs(
  file,
  protectedPaths = [],
  referenceRoots = [process.cwd()],
) {
  const lock = file + ".finish-lock";
  const initial = checkDevelopmentOutputs(file, lock);
  if (initial.issues.some((issue) => issue.reason !== "OUTPUT_CLEANUP_PENDING")) return initial;
  if (!initial.items.some((item) => item.disposition === "cleanup")) return initial;
  const state = file + ".finish-state";
  prepareFinishState(state, initial);
  if (!lockFinish(lock, initial.task, initial.owner, state))
    return {
      ...initial,
      issues: [...initial.issues, { path: file, reason: "OUTPUT_FINISH_LOCKED" }],
      status: "needs-disposition",
    };
  try {
    for (const name of fs.readdirSync(state))
      if (name.startsWith("record-")) fs.unlinkSync(join(state, name));
    const manifest = read(file);
    const receipt = file + ".cleanup.json";
    const journal = exists(receipt)
      ? read(receipt)
      : { task: manifest.task, owner: manifest.owner, items: [] };
    const cleanup = [];
    for (const item of manifest.items.filter((item) => item.disposition === "cleanup")) {
      let record = journal.items.find((record) => record.path === item.path);
      if (
        record?.prepared === true &&
        Number.isFinite(Date.parse(record.startedAt)) &&
        !exists(item.path)
      ) {
        Object.assign(record, {
          removed: true,
          completedAt: new Date().toISOString(),
          recovered: true,
        });
        delete record.reason;
        writeRecord(receipt, journal, state);
      } else {
        record = { path: item.path, removed: false, startedAt: new Date().toISOString() };
        journal.items = [...journal.items.filter((row) => row.path !== item.path), record];
        try {
          if (
            protectedPaths.some(
              (protectedPath) =>
                inside(item.path, protectedPath) || inside(protectedPath, item.path),
            )
          )
            throw Error("OUTPUT_CURRENT_INPUT");
          if (
            manifest.items.some((other) =>
              other.restoreFrom?.some((source) => inside(item.path, source)),
            )
          )
            throw Error("OUTPUT_RECOVERY_DEPENDENCY");
          const activityRoot = assertDisposable(item.path) ?? dirname(item.path);
          const scope = [
            dirname(file),
            ...protectedPaths,
            ...referenceRoots,
            ...[".agents/skills", ".codex/skills", ".local/bin"]
              .map((path) => join(os.homedir(), path))
              .filter(exists),
          ];
          assertIdle(
            item.path,
            [...new Set(scope)].filter((root) => fs.statSync(root).isDirectory()),
            activityRoot,
          );
          physical(item.path);
          record.prepared = true;
          writeRecord(receipt, journal, state);
          fs.rmSync(item.path, { recursive: true });
          Object.assign(record, { removed: true, completedAt: new Date().toISOString() });
        } catch (error) {
          Object.assign(record, {
            removed: false,
            completedAt: new Date().toISOString(),
            reason: error.message,
          });
        }
        writeRecord(receipt, journal, state);
      }
      cleanup.push(record);
      if (record.removed) {
        item.disposition = "remove";
        item.cleanupReceipt = receipt;
        writeRecord(file, manifest, state);
      }
    }
    const report = checkDevelopmentOutputs(file, lock);
    report.performsCleanup = cleanup.some((item) => item.removed && !item.recovered);
    report.livePreflightVerified =
      cleanup.length > 0 && cleanup.every((item) => item.removed && !item.recovered);
    report.cleanup = cleanup;
    report.issues.push(
      ...cleanup.filter((item) => !item.removed).map(({ path, reason }) => ({ path, reason })),
    );
    if (report.issues.length) report.status = "needs-disposition";
    return report;
  } finally {
    fs.unlinkSync(lock);
  }
}

import fs from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

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

export function checkDevelopmentOutputs(file) {
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
      if (item.disposition === "retain" ? !text(item.reason) : item.disposition !== "remove")
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
        if (path === file) continue;
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
        !manifest.items.some((item) => item.path === root && item.disposition === "remove")
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

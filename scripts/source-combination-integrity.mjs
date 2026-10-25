/** Official read-only source-combination validation, shared with preparation. */
import {
  readFile,
  readdir as rawReaddir,
  realpath as rawRealpath,
  lstat as rawLstat,
} from "node:fs/promises";
import { readFile as readFileCallback } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync as rawExecFileSync } from "node:child_process";

import {
  sourceCostScope,
  sourceCostAsync,
  sourceCostSync,
  sourceCostCount,
  sourceCostQueue,
} from "./source-cost.mjs";
const execFileSync = (...args) => sourceCostSync("git", () => rawExecFileSync(...args));
const readdir = (...args) => sourceCostAsync("metadata.readdir", () => rawReaddir(...args));
const realpath = (...args) => sourceCostAsync("metadata.realpath", () => rawRealpath(...args));
const lstat = (...args) => sourceCostAsync("metadata.lstat", () => rawLstat(...args));
const callbackReadFile = promisify(readFileCallback);
const readBytes = (file, readScope) =>
  sourceCostAsync("read", () =>
    readScope
      ? readScope.read(file, 64 * 1024 * 1024)
      : typeof file === "string" || Buffer.isBuffer(file) || file instanceof URL
        ? callbackReadFile(file)
        : readFile(file),
  );
export const fileDigest = async (file, readScope) => {
  const hash = sourceCostSync("sha256.create", () => createHash("sha256"));
  const bytes = await readBytes(file, readScope);
  return sourceCostSync("sha256.update-digest", () => hash.update(bytes).digest("hex"));
};

/** Hash shipped resources, excluding dependency links and their writable stores. */
export async function resourceDigests(directory, prefix = "", readScope) {
  return digestResources(directory, prefix, readScope, false);
}

export async function publishedResourceDigests(directory, prefix = "") {
  return digestResources(directory, prefix, undefined, true);
}

async function digestResources(...args) {
  return sourceCostScope("resources", args[0], () => hashResourceTree(...args));
}

async function hashResourceTree(directory, prefix, readScope, excludeDependencies) {
  const files = {},
    pending = [];
  const reader = sourceReadPipeline(readScope);
  async function visit(directory, prefix) {
    sourceCostCount("directories", 1);
    if (readScope) await readScope.resolve(directory, { traverse: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludeDependencies && ["node_modules", ".git"].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, relative);
      else if (entry.isSymbolicLink()) {
        sourceCostCount("links", 1);
        if (readScope) await readScope.resolve(file, { traverse: true });
        files[relative] = "link:" + (await realpath(file));
      } else if (entry.isFile() && (excludeDependencies || relative !== "combination.json")) {
        files[relative] = null;
        pending.push([relative, file]);
        if (reader) await reader.read(pending.length - 1, file);
      }
    }
  }
  const scan = () => sourceCostAsync("scan.envelope", () => visit(directory, prefix));
  if (reader) return reader.run(scan, files, () => pending);
  await scan();
  return hashFiles(files, pending, readScope);
}

function sameDigests(actual, expected) {
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length) return false;
  for (const key of keys)
    if (!Object.hasOwn(expected, key) || actual[key] !== expected[key]) return false;
  return true;
}

/** Reject incomplete snapshots before changing the selected combination. */
export async function readSourceCombination(...args) {
  return sourceCostScope("verify", args[0], () => verifySourceCombination(...args));
}

async function verifySourceCombination(runtime, id, core, { readScope } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("INVALID_SOURCE_COMBINATION");
  const directory = join(runtime, "source-combinations", id);
  const record = JSON.parse(
    (await readBytes(join(directory, "combination.json"), readScope)).toString("utf8"),
  );
  if (record.composition.id !== id) throw Error("SOURCE_COMBINATION_ID_MISMATCH");
  if (
    core &&
    record.core !==
      execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
        cwd: core,
        encoding: "utf8",
      }).trim()
  )
    throw Error("SOURCE_COMBINATION_CORE_MISMATCH");
  if (
    !record.composition.dependencies ||
    typeof record.composition.dependencies !== "object" ||
    Array.isArray(record.composition.dependencies)
  )
    throw Error("INVALID_SOURCE_DEPENDENCIES");
  if (Object.keys(record.composition.dependencies).length) {
    const plugins = JSON.parse(
      (await readBytes(join(directory, "company-plugins.json"), readScope)).toString("utf8"),
    );
    for (const [name, version] of Object.entries(record.composition.dependencies)) {
      if (
        !/^(?:@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) ||
        typeof version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
      )
        throw Error("INVALID_SOURCE_COMPONENT");
      const manifest = JSON.parse(
        (
          await readBytes(join(directory, "node_modules", name, "package.json"), readScope)
        ).toString("utf8"),
      );
      if (
        manifest.name !== name ||
        manifest.version !== version ||
        plugins[name]?.version !== version
      )
        throw Error("SOURCE_COMPONENT_VERSION_MISMATCH");
    }
  }
  const actual = await resourceDigests(directory, "", readScope);
  if (!sameDigests(actual, record.files))
    throw Object.assign(Error("SOURCE_COMBINATION_DIGEST_MISMATCH"), {
      mismatches: changedInputs(actual, record.files),
    });
  const external = await dependencyDigests(record.externalRoots, readScope);
  for (const file of record.externalLockFiles) external[file] = await fileDigest(file, readScope);
  if (!sameDigests(external, record.externalFiles))
    throw Object.assign(Error("SOURCE_DEPENDENCY_DIGEST_MISMATCH"), {
      mismatches: changedInputs(external, record.externalFiles).map((entry) => ({
        ...entry,
        kind: record.externalLockFiles.includes(entry.path) ? "lock" : "external-dependency",
      })),
    });
  return record.composition;
}

/** Fix the resolved dependency graph, including built core files and transitive links. */
export async function dependencyDigests(...args) {
  return sourceCostScope("dependencies", "external", () => hashDependencyTree(...args));
}

async function hashDependencyTree(directories, readScope) {
  const files = {},
    visited = new Set(),
    pending = [];
  const reader = sourceReadPipeline(readScope);
  function enqueue(file) {
    files[file] = null;
    pending.push(file);
  }
  async function visit(directory) {
    const physical = readScope
      ? await readScope.resolve(directory, { traverse: true })
      : await realpath(directory);
    if (visited.has(physical)) return;
    visited.add(physical);
    sourceCostCount("directories", 1);
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = join(physical, entry.name);
      if (entry.isFile()) {
        enqueue(file);
        if (reader) await reader.read(pending.length - 1, file);
      } else if (entry.isDirectory()) await visit(file);
      else if (entry.isSymbolicLink()) {
        sourceCostCount("links", 1);
        const resolved = readScope
          ? await readScope.resolve(file, { traverse: true })
          : await realpath(file);
        files[file] = "link:" + resolved;
        if ((await lstat(resolved)).isDirectory()) await visit(resolved);
        else {
          enqueue(resolved);
          if (reader) await reader.read(pending.length - 1, resolved);
        }
      }
    }
  }
  const scan = () =>
    sourceCostAsync("scan.envelope", async () => {
      for (const directory of directories) await visit(directory);
    });
  if (reader) return reader.run(scan, files, () => pending.map((file) => [file, file]));
  await scan();
  return hashFiles(
    files,
    pending.map((file) => [file, file]),
    readScope,
  );
}

function sourceReadPipeline(readScope) {
  if (readScope) return;
  const mode = process.env.GEA_SOURCE_READ_PIPELINE;
  if (mode === undefined || mode === "off") return;
  if (mode !== "on") throw Error("INVALID_SOURCE_READ_PIPELINE");
  sourceCostCount("pipelineEnabled", 1);
  const active = new Set(),
    digests = [];
  let failure;
  return {
    async read(index, file) {
      if (failure) throw failure;
      if (active.size >= 16) await sourceCostAsync("backpressure", () => Promise.race(active));
      if (failure) throw failure;
      const task = fileDigest(file).then(
        (value) => {
          digests[index] = value;
        },
        (error) => {
          failure ??= error;
        },
      );
      active.add(task);
      void task.then(() => active.delete(task));
    },
    async run(scan, files, entries) {
      let scanFailure;
      try {
        await scan();
      } catch (error) {
        scanFailure = error;
      }
      await Promise.all(active);
      if (scanFailure) throw scanFailure;
      if (failure) throw failure;
      const pending = entries();
      sourceCostQueue(pending);
      for (const [index, [key]] of pending.entries()) files[key] = digests[index];
      return files;
    },
  };
}

async function hashFiles(files, pending, readScope) {
  sourceCostQueue(pending);
  const digests = [];
  let next = 0,
    failure;
  await Promise.all(
    Array.from({ length: Math.min(readScope ? 1 : 16, pending.length) }, async () => {
      while (!failure && next < pending.length) {
        const index = next++;
        try {
          digests[index] = await fileDigest(pending[index][1], readScope);
        } catch (error) {
          failure ??= error;
        }
      }
    }),
  );
  if (failure) throw failure;
  for (const [index, [key]] of pending.entries()) files[key] = digests[index];
  return files;
}

function changedInputs(actual, expected) {
  return [...new Set([...Object.keys(actual), ...Object.keys(expected)])]
    .sort()
    .filter((path) => actual[path] !== expected[path])
    .map((path) => ({
      path,
      actual: actual[path] ?? null,
      expected: expected[path] ?? null,
    }));
}

export function clientEntry(manifest) {
  const entry = manifest.exports?.["./client"];
  return typeof entry === "string" ? entry : (entry?.default ?? "client/client.js");
}

export function componentArtifactEntries(manifest) {
  return [
    "package.json",
    manifest.main ?? manifest.exports?.["."]?.default ?? "lib/host.js",
    clientEntry(manifest),
  ];
}

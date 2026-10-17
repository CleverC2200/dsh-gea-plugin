/** Official read-only source-combination validation, shared with preparation. */
import { readFile, readdir, realpath, lstat } from "node:fs/promises";
import { readFile as readFileCallback } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const callbackReadFile = promisify(readFileCallback);
const readBytes = (file, readScope) =>
  readScope
    ? readScope.read(file, 64 * 1024 * 1024)
    : typeof file === "string" || Buffer.isBuffer(file) || file instanceof URL
      ? callbackReadFile(file)
      : readFile(file);
export const fileDigest = async (file, readScope) =>
  createHash("sha256")
    .update(await readBytes(file, readScope))
    .digest("hex");

/** Hash shipped resources, excluding dependency links and their writable stores. */
export async function resourceDigests(directory, prefix = "", readScope) {
  if (readScope) await readScope.resolve(directory, { traverse: true });
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await resourceDigests(file, relative, readScope));
    else if (entry.isSymbolicLink()) {
      if (readScope) await readScope.resolve(file, { traverse: true });
      files[relative] = "link:" + (await realpath(file));
    } else if (entry.isFile() && relative !== "combination.json")
      files[relative] = await fileDigest(file, readScope);
  }
  return files;
}

function sameDigests(actual, expected) {
  const keys = Object.keys(actual);
  if (keys.length !== Object.keys(expected).length) return false;
  for (const key of keys)
    if (!Object.hasOwn(expected, key) || actual[key] !== expected[key]) return false;
  return true;
}

/** Reject incomplete snapshots before changing the selected combination. */
export async function readSourceCombination(runtime, id, core, { readScope } = {}) {
  return (await readSourceCombinationRecord(runtime, id, core, { readScope })).record.composition;
}

export async function readSourceCombinationRecord(runtime, id, core, { readScope } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("INVALID_SOURCE_COMBINATION");
  const directory = join(runtime, "source-combinations", id);
  const bytes = await readBytes(join(directory, "combination.json"), readScope);
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const record = JSON.parse(bytes.toString("utf8"));
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
  let plugins = {};
  if (Object.keys(record.composition.dependencies).length) {
    const pluginBytes = await readBytes(join(directory, "company-plugins.json"), readScope);
    if (
      createHash("sha256").update(pluginBytes).digest("hex") !==
      record.files["company-plugins.json"]
    )
      throw Error("SOURCE_COMBINATION_DIGEST_MISMATCH");
    plugins = JSON.parse(pluginBytes.toString("utf8"));
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
  return { record, plugins, manifestSha256 };
}

/** Fix the resolved dependency graph, including built core files and transitive links. */
export async function dependencyDigests(directories, readScope) {
  const files = {},
    visited = new Set(),
    pending = [];
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
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const file = join(physical, entry.name);
      if (entry.isFile()) enqueue(file);
      else if (entry.isDirectory()) await visit(file);
      else if (entry.isSymbolicLink()) {
        const resolved = readScope
          ? await readScope.resolve(file, { traverse: true })
          : await realpath(file);
        files[file] = "link:" + resolved;
        if ((await lstat(resolved)).isDirectory()) await visit(resolved);
        else enqueue(resolved);
      }
    }
  }
  for (const directory of directories) await visit(directory);
  // Keep the complete traversal and its key order; only independent byte reads overlap.
  const digests = [];
  let next = 0,
    failure;
  await Promise.all(
    Array.from({ length: Math.min(readScope ? 1 : 16, pending.length) }, async () => {
      while (!failure && next < pending.length) {
        const index = next++;
        try {
          digests[index] = await fileDigest(pending[index], readScope);
        } catch (error) {
          failure ??= error;
        }
      }
    }),
  );
  if (failure) throw failure;
  for (const [index, file] of pending.entries()) files[file] = digests[index];
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

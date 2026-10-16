import type { PluginUpdateFileCommit } from "./plugin-update-windows.ts";
import { createHash } from "node:crypto";
import { resolveBundleDir } from "@deepseek-ai/dsh-app-boot";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  access,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  writeFile,
  open,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, dirname, resolve } from "node:path";
import {
  companyPackageNames,
  comparePluginVersions,
  satisfiesPluginVersion,
  type PluginManifest,
  type PluginRelease,
  type FixedCore,
} from "../shared/plugin-release.mjs";

export const profilePreservedFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "cordis.patch.yml",
  "pnpm-workspace.yaml",
];
export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(".." + (process.platform === "win32" ? "\\" : "/")))
  );
};
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("PROFILE_OBJECT_REQUIRED");
  return value as Record<string, unknown>;
}
function strings(value: unknown): Record<string, string> {
  const row = object(value ?? {}),
    out: Record<string, string> = {};
  for (const [name, range] of Object.entries(row)) {
    if (typeof range !== "string") throw Error("PROFILE_GRAPH_INVALID");
    out[name] = range;
  }
  return out;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function optionalFile(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
export async function pluginProfileStoreDirectory(profile: string): Promise<string> {
  const bytes = await optionalFile(join(profile, "node_modules/.modules.yaml"));
  if (!bytes) throw Error("PROFILE_STORE_UNAVAILABLE");
  let modules: unknown;
  try {
    modules = parseYaml(bytes.toString("utf8"));
  } catch {
    throw Error("PROFILE_STORE_INVALID");
  }
  if (
    modules === null ||
    typeof modules !== "object" ||
    !("storeDir" in modules) ||
    typeof modules.storeDir !== "string" ||
    !isAbsolute(modules.storeDir)
  )
    throw Error("PROFILE_STORE_INVALID");
  try {
    if (!(await stat(modules.storeDir)).isDirectory()) throw Error("PROFILE_STORE_UNAVAILABLE");
    await access(modules.storeDir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw Error("PROFILE_STORE_UNAVAILABLE");
  }
  return modules.storeDir;
}
async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest("hex");
}
type TreeEntry = {
  path: string;
  kind: "file" | "directory" | "symlink";
  sha256?: string;
  target?: string;
  mode: number;
  size: number;
};
export type ProfilePackage = PluginManifest & {
  dir: string;
  manifest: Record<string, unknown>;
  root: boolean;
};
export type ProfileSnapshot = {
  sha256: string;
  ownedSha256: string;
  files: Record<string, Buffer | null>;
  manifest: Record<string, unknown>;
  packages: ProfilePackage[];
  entries: TreeEntry[];
  external: Record<string, string>;
  bytes: number;
};

/** Fingerprint physical contents without following protected external roots during a copy. */
async function tree(root: string): Promise<{ entries: TreeEntry[]; bytes: number }> {
  const entries: TreeEntry[] = [];
  let bytes = 0;
  async function walk(path: string, rel: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      entries.push({
        path: rel,
        kind: "symlink",
        target: await readlink(path),
        mode: info.mode,
        size: info.size,
      });
      return;
    }
    if (info.isDirectory()) {
      entries.push({ path: rel, kind: "directory", mode: info.mode, size: 0 });
      for (const name of (await readdir(path)).sort())
        await walk(join(path, name), rel ? rel + "/" + name : name);
      return;
    }
    if (!info.isFile()) throw Error("PROFILE_GRAPH_SPECIAL_FILE");
    bytes += info.size;
    entries.push({
      path: rel,
      kind: "file",
      sha256: await fileHash(path),
      mode: info.mode,
      size: info.size,
    });
  }
  await walk(root, "");
  return { entries, bytes };
}
async function profileRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM" &&
      (await lstat(path)).isSymbolicLink()
    )
      return realpath(resolve(dirname(path), await readlink(path)));
    throw error;
  }
}
async function externalRoots(
  nodeModules: string,
  entries: TreeEntry[],
): Promise<Record<string, string>> {
  const targets: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.kind !== "symlink") continue;
    let target: string;
    try {
      target = await profileRealpath(join(nodeModules, entry.path));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (within(nodeModules, target) || targets[target]) continue;
    const info = await lstat(target);
    targets[target] = info.isDirectory()
      ? sha256(canonical((await tree(target)).entries))
      : await fileHash(target);
  }
  return targets;
}
async function packages(root: string): Promise<ProfilePackage[]> {
  const output: ProfilePackage[] = [],
    seen = new Map<string, ProfilePackage>();
  const profileDirectory = dirname(root);
  async function visitPackage(location: string, rootLevel: boolean) {
    const dir = await profileRealpath(location),
      previous = seen.get(dir);
    if (previous) {
      if (rootLevel) previous.root = true;
      return;
    }
    const raw = await optionalFile(join(dir, "package.json"));
    if (!raw) return;
    const manifest = object(JSON.parse(raw.toString("utf8")));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string")
      throw Error("PROFILE_GRAPH_INVALID");
    comparePluginVersions(manifest.version, manifest.version);
    const peerDependencies = strings(manifest.peerDependencies),
      dependencies = strings(manifest.dependencies),
      optionalDependencies = strings(manifest.optionalDependencies);
    const peerDependenciesMeta: Record<string, { optional: boolean }> = {};
    for (const [peer, rawMeta] of Object.entries(object(manifest.peerDependenciesMeta ?? {}))) {
      const meta = object(rawMeta);
      if (typeof meta.optional !== "boolean") throw Error("PROFILE_GRAPH_INVALID");
      peerDependenciesMeta[peer] = { optional: meta.optional };
    }
    const parsed = {
      name: manifest.name,
      version: manifest.version,
      dir,
      manifest,
      root: rootLevel,
      peerDependencies,
      peerDependenciesMeta,
      dependencies,
    };
    output.push(parsed);
    seen.set(dir, parsed);
    // Resolve from the real consumer anchor. Pnpm peers/dependencies can be siblings
    // in its virtual context; enumerating .pnpm would also include obsolete instances.
    for (const name of Object.keys({
      ...dependencies,
      ...optionalDependencies,
      ...peerDependencies,
    }).sort()) {
      let resolved: string;
      try {
        resolved = resolveBundleDir("dsh", name, join(dir, "package.json"), profileDirectory);
      } catch (error) {
        if (Object.hasOwn(dependencies, name) && !Object.hasOwn(optionalDependencies, name))
          throw Error("PROFILE_GRAPH_UNRESOLVED", { cause: error });
        continue; // Missing peers remain on the consumer for compatibility validation.
      }
      await visitPackage(resolved, false);
    }
  }
  for (const name of (await readdir(root)).sort()) {
    if (name.startsWith(".")) continue;
    const locations = name.startsWith("@")
      ? (await readdir(join(root, name))).sort().map((child) => join(root, name, child))
      : [join(root, name)];
    for (const location of locations) {
      const info = await lstat(location);
      if (info.isDirectory() || info.isSymbolicLink()) await visitPackage(location, true);
    }
  }
  return output;
}
export async function readPluginProfile(profileDirectory: string): Promise<ProfileSnapshot> {
  const files: Record<string, Buffer | null> = {};
  for (const name of profilePreservedFiles)
    files[name] = await optionalFile(join(profileDirectory, name));
  if (!files["package.json"]) throw Error("PROFILE_MANIFEST_REQUIRED");
  const manifest = object(JSON.parse(files["package.json"].toString("utf8")));
  strings(manifest.dependencies);
  const ownNodeModules = join(profileDirectory, "node_modules");
  const nodeInfo = await lstat(ownNodeModules);
  if (!nodeInfo.isDirectory() || nodeInfo.isSymbolicLink())
    throw Error("PROFILE_NODE_MODULES_NOT_OWNED");
  const nodeModules = await realpath(ownNodeModules);
  if (!within(await realpath(profileDirectory), nodeModules))
    throw Error("PROFILE_NODE_MODULES_NOT_OWNED");
  const graph = await tree(nodeModules),
    external = await externalRoots(nodeModules, graph.entries);
  return {
    files,
    manifest,
    packages: await packages(nodeModules),
    entries: graph.entries,
    external,
    bytes: graph.bytes,
    ownedSha256: sha256(
      canonical({
        files: Object.fromEntries(
          ["package.json", "pnpm-lock.yaml"].map((name) => [
            name,
            files[name] ? sha256(files[name]) : null,
          ]),
        ),
        entries: graph.entries,
        external,
      }),
    ),
    sha256: sha256(
      canonical({
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, bytes ? sha256(bytes) : null]),
        ),
        entries: graph.entries,
        external,
      }),
    ),
  };
}
export async function combinationManifests(
  snapshot: ProfileSnapshot,
  core: FixedCore,
  profileDirectory: string,
): Promise<PluginManifest[]> {
  const roots = snapshot.packages.filter((row) => row.root && !Object.hasOwn(core.sdk, row.name));
  for (const consumer of snapshot.packages.filter((row) => !row.root)) {
    const affected: Record<string, string> = {};
    for (const [name, range] of Object.entries({
      ...consumer.dependencies,
      ...consumer.peerDependencies,
    })) {
      if (Object.hasOwn(core.sdk, name)) {
        affected[name] = range;
        continue;
      }
      if (!companyPackageNames.some((company) => company === name)) continue;
      const selected = snapshot.packages.find((row) => row.root && row.name === name);
      if (!selected) {
        affected[name] = range;
        continue;
      }
      try {
        const resolved = await profileRealpath(
          resolveBundleDir("dsh", name, join(consumer.dir, "package.json"), profileDirectory),
        );
        if (resolved === selected.dir) affected[name] = range;
      } catch {
        affected[name] = range;
      }
    }
    if (Object.keys(affected).length)
      roots.push({
        ...consumer,
        name: consumer.name + "@" + sha256(consumer.dir).slice(0, 12),
        peerDependencies: affected,
        dependencies: {},
        peerDependenciesMeta: consumer.peerDependenciesMeta,
      });
  }
  return roots;
}
export async function validateActualProfile(
  snapshot: ProfileSnapshot,
  core: FixedCore,
  profileDirectory: string,
  installAnchor: string,
): Promise<string[]> {
  const failures: string[] = [];
  for (const consumer of snapshot.packages) {
    for (const [name, range] of Object.entries(consumer.peerDependencies ?? {})) {
      const expectedSdk =
        core.sdk[name] ?? (/^@deepseek-ai\/dsh(?:-|$)/.test(name) ? core.version : undefined);
      let version: string | undefined;
      try {
        const dir = await profileRealpath(
          resolveBundleDir(
            "dsh",
            name,
            expectedSdk ? installAnchor : join(consumer.dir, "package.json"),
            profileDirectory,
          ),
        );
        const manifest = object(JSON.parse(await readFile(join(dir, "package.json"), "utf8")));
        if (typeof manifest.version === "string") version = manifest.version;
      } catch {
        /* Missing peers are judged below, including optional absence. */
      }
      if (!version && consumer.peerDependenciesMeta?.[name]?.optional) continue;
      if (
        !version ||
        !satisfiesPluginVersion(version, range) ||
        (expectedSdk && expectedSdk !== version)
      )
        failures.push(consumer.name + ":" + name);
    }
  }
  return failures;
}
export async function freezePluginProfile(
  profileDirectory: string,
  snapshot: ProfileSnapshot,
  directory: string,
  commit?: PluginUpdateFileCommit,
): Promise<void> {
  const targetDirectory = directory;
  if (process.platform === "win32") {
    if (!commit) throw Error("UPDATE_WINDOWS_STORAGE_UNAVAILABLE");
    directory += ".preparing";
  }
  if (!snapshot.files["pnpm-lock.yaml"]) throw Error("PROFILE_FROZEN_LOCK_REQUIRED");
  const capacity = await statfs(profileDirectory);
  if (capacity.bavail * capacity.bsize < snapshot.bytes * 2 + 64 * 1024 * 1024)
    throw Error("PROFILE_RECOVERY_CAPACITY_REQUIRED");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const [name, bytes] of Object.entries(snapshot.files))
    if (bytes)
      await writeFile(join(directory, name), bytes, {
        mode: 0o600,
        flag: "wx",
      });
  await cp(join(profileDirectory, "node_modules"), join(directory, "node_modules"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  for (const entry of snapshot.entries.filter((entry) => entry.kind === "file")) {
    const file = await open(
      join(directory, "node_modules", entry.path),
      process.platform === "win32" ? "r+" : "r",
    );
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  for (const [name, bytes] of Object.entries(snapshot.files)) {
    if (!bytes) continue;
    const file = await open(join(directory, name), process.platform === "win32" ? "r+" : "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  await writeFile(
    join(directory, "snapshot.json"),
    JSON.stringify(
      {
        schema: 1,
        profileDirectory,
        sha256: snapshot.sha256,
        external: snapshot.external,
        bytes: snapshot.bytes,
        availableBytes: capacity.bavail * capacity.bsize,
        requiredBytes: snapshot.bytes * 2 + 64 * 1024 * 1024,
        files: Object.fromEntries(
          Object.entries(snapshot.files).map(([name, bytes]) => [
            name,
            bytes ? sha256(bytes) : null,
          ]),
        ),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const snapshotFile = await open(
    join(directory, "snapshot.json"),
    process.platform === "win32" ? "r+" : "r",
  );
  try {
    await snapshotFile.sync();
  } finally {
    await snapshotFile.close();
  }
  if (process.platform === "win32" && commit) {
    await commit.replace(directory, targetDirectory);
    return;
  }
  // Sync directory entries after syncing file contents, before the durable acceptance receipt.
  const directories = snapshot.entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => join(directory, "node_modules", entry.path));
  for (const path of [...directories.reverse(), join(directory, "node_modules"), directory]) {
    const savedDirectory = await open(path, "r");
    try {
      await savedDirectory.sync();
    } finally {
      await savedDirectory.close();
    }
  }
}
export async function restorePluginProfile(
  profileDirectory: string,
  snapshot: ProfileSnapshot,
  directory: string,
): Promise<void> {
  const currentExternal: Record<string, string> = {};
  for (const target of Object.keys(snapshot.external)) {
    const info = await lstat(target);
    currentExternal[target] = info.isDirectory()
      ? sha256(canonical((await tree(target)).entries))
      : await fileHash(target);
  }
  if (canonical(currentExternal) !== canonical(snapshot.external))
    throw Error("PROFILE_EXTERNAL_ROOT_CHANGED");
  const failed = join(directory, "failed-node_modules");
  await rename(join(profileDirectory, "node_modules"), failed);
  await cp(join(directory, "node_modules"), join(profileDirectory, "node_modules"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  for (const name of ["package.json", "pnpm-lock.yaml"]) {
    const bytes = snapshot.files[name];
    if (bytes) await writeFile(join(profileDirectory, name), bytes, { mode: 0o600 });
    else await rm(join(profileDirectory, name), { force: true });
  }
  if ((await readPluginProfile(profileDirectory)).ownedSha256 !== snapshot.ownedSha256)
    throw Error("PROFILE_RESTORE_VERIFICATION_FAILED");
}
export function retainsProfileFields(
  before: ProfileSnapshot,
  after: ProfileSnapshot,
  release: PluginRelease,
  archivePath: string,
): boolean {
  const expected = structuredClone(before.manifest);
  expected.dependencies = {
    ...strings(expected.dependencies),
    [release.name]: "file:" + archivePath,
  };
  if (canonical(after.manifest) !== canonical(expected)) return false;
  return true;
}
export function retainsUnmanagedManifestFields(
  before: ProfileSnapshot,
  current: ProfileSnapshot,
): boolean {
  const withoutGraph = (manifest: Record<string, unknown>) => {
    const fields = structuredClone(manifest);
    for (const key of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
      "peerDependenciesMeta",
      "overrides",
      "resolutions",
      "pnpm",
      "packageManager",
    ])
      delete fields[key];
    return fields;
  };
  return canonical(withoutGraph(before.manifest)) === canonical(withoutGraph(current.manifest));
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, readlink, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  companyPackageNames,
  parseInstalledPluginManifest,
  type PluginManifest,
  type PluginRelease,
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
export type ProfilePackage = PluginManifest & { dir: string; root: true };
export type ProfileSnapshot = {
  sha256: string;
  files: Record<string, Buffer | null>;
  manifest: Record<string, unknown>;
  packages: ProfilePackage[];
};
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
export async function readPluginProfile(profileDirectory: string): Promise<ProfileSnapshot> {
  const files: Record<string, Buffer | null> = {};
  for (const name of profilePreservedFiles)
    files[name] = await optionalFile(join(profileDirectory, name));
  if (!files["package.json"]) throw Error("PROFILE_MANIFEST_REQUIRED");
  const manifest = object(JSON.parse(files["package.json"].toString("utf8")));
  const dependencies = strings(manifest.dependencies);
  const ownNodeModules = join(profileDirectory, "node_modules"),
    info = await lstat(ownNodeModules);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("PROFILE_NODE_MODULES_NOT_OWNED");
  const nodeModules = await realpath(ownNodeModules);
  if (!within(await realpath(profileDirectory), nodeModules))
    throw Error("PROFILE_NODE_MODULES_NOT_OWNED");
  const packages: ProfilePackage[] = [];
  for (const name of companyPackageNames) {
    if (!Object.hasOwn(dependencies, name)) continue;
    const bytes = await optionalFile(join(nodeModules, name, "package.json"));
    if (!bytes) continue;
    const parsed = parseInstalledPluginManifest(JSON.parse(bytes.toString("utf8")));
    if (parsed.name !== name) throw Error("PROFILE_GRAPH_INVALID");
    const dir = await profileRealpath(join(nodeModules, name));
    if (!within(nodeModules, dir)) throw Error("PROFILE_NODE_MODULES_NOT_OWNED");
    packages.push({ ...parsed, dir, root: true });
  }
  return {
    files,
    manifest,
    packages,
    sha256: sha256(
      canonical({
        files: Object.fromEntries(
          Object.entries(files).map(([name, bytes]) => [name, bytes ? sha256(bytes) : null]),
        ),
        packages,
      }),
    ),
  };
}
export function retainsProfileUpdates(
  before: ProfileSnapshot,
  after: ProfileSnapshot,
  updates: readonly { release: PluginRelease; archivePath: string }[],
): boolean {
  const expected = structuredClone(before.manifest);
  const current = structuredClone(after.manifest);
  const expectedDependencies = strings(expected.dependencies);
  const currentDependencies = strings(current.dependencies);
  for (const { release, archivePath } of updates) {
    expectedDependencies[release.name] = "file:" + archivePath;
    if (
      process.platform === "win32" &&
      currentDependencies[release.name] === "file:" + archivePath.replaceAll("\\", "/")
    )
      currentDependencies[release.name] = "file:" + archivePath;
  }
  expected.dependencies = expectedDependencies;
  current.dependencies = currentDependencies;
  return canonical(current) === canonical(expected);
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

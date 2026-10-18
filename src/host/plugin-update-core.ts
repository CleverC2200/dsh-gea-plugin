import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-app-boot";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { updateObject } from "../shared/plugin-update-wire.ts";
import type { FixedCore } from "../shared/plugin-release.mjs";
const run = promisify(execFile);
const criticalSdk = [
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-plugin-manager",
  "@deepseek-ai/dsh-atomic-write",
];
// Node selects the first matching condition in manifest order. Type-only and require entries do not run here.
function runtimeExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const [condition, target] of Object.entries(value))
    if (["node", "node-addons", "import", "default"].includes(condition))
      return runtimeExportTarget(target);
  return undefined;
}
const contained = (root: string, path: string) => {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith("../");
};

/** Verify an explicitly admitted deployment against its actual installation and artifact bytes. */
export async function readPluginUpdateCore(ctx: Context, raw: unknown): Promise<FixedCore> {
  const proof = updateObject(raw);
  if (
    Object.keys(proof).some(
      (key) => !["kind", "root", "head", "version", "artifacts"].includes(key),
    ) ||
    (proof.kind !== undefined && proof.kind !== "source" && proof.kind !== "desktop") ||
    typeof proof.root !== "string" ||
    !isAbsolute(proof.root) ||
    typeof proof.head !== "string" ||
    !/^[a-f0-9]{40}$/.test(proof.head) ||
    typeof proof.version !== "string" ||
    !proof.version ||
    !Array.isArray(proof.artifacts) ||
    !proof.artifacts.length
  )
    throw Error("UPDATE_CORE_PROVENANCE_REQUIRED");
  const root = await realpath(proof.root),
    anchor = await realpath(ctx.profileContext.installAnchor);
  if (!contained(root, anchor)) throw Error("UPDATE_CORE_INSTALLATION_MISMATCH");
  const git = async (args: string[]) =>
    (
      await run("git", ["-C", root, ...args], {
        timeout: 5000,
        maxBuffer: 4_000_000,
      })
    ).stdout.trim();
  const desktop = proof.kind === "desktop";
  if (
    !desktop &&
    ((await git(["rev-parse", "HEAD"])) !== proof.head ||
      (await git(["status", "--porcelain", "--untracked-files=no"])))
  )
    throw Error("UPDATE_CORE_SOURCE_MISMATCH");
  const launcher = updateObject(JSON.parse(await readFile(anchor, "utf8")));
  if (launcher.name !== "@deepseek-ai/dsh" || launcher.version !== proof.version)
    throw Error("UPDATE_CORE_VERSION_MISMATCH");
  const runtime = desktop
    ? updateObject(JSON.parse(await readFile(join(root, "dsh/package.json"), "utf8")))
    : undefined;
  if (runtime) {
    if (anchor !== (await realpath(join(root, "dsh/node_modules/@deepseek-ai/dsh/package.json"))))
      throw Error("UPDATE_CORE_INSTALLATION_MISMATCH");
    const app = updateObject(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
    if (
      app.name !== "@deepseek-ai/dsh-desktop" ||
      app.dshBuildCommit !== proof.head ||
      app.dshBuildDirty !== false
    )
      throw Error("UPDATE_CORE_SOURCE_MISMATCH");
    if (runtime.name !== "@deepseek-ai/dsh-desktop-runtime" || runtime.version !== proof.version)
      throw Error("UPDATE_CORE_VERSION_MISMATCH");
  }
  const observedPaths = new Set<string>();
  for (const rawArtifact of proof.artifacts) {
    const artifact = updateObject(rawArtifact);
    if (
      typeof artifact.path !== "string" ||
      !(desktop
        ? /^(package\.json|lib\/|dsh\/)/.test(artifact.path)
        : /^(apps|packages|vendor)\//.test(artifact.path)) ||
      isAbsolute(artifact.path) ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
      throw Error("UPDATE_CORE_ARTIFACT_INVALID");
    const path = await realpath(join(root, artifact.path));
    if (!contained(root, path) || observedPaths.has(path))
      throw Error("UPDATE_CORE_ARTIFACT_INVALID");
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== artifact.sha256
    )
      throw Error("UPDATE_CORE_ARTIFACT_CHANGED");
    observedPaths.add(path);
  }
  if (desktop) {
    for (const path of [
      "package.json",
      "lib/main.js",
      "dsh/package.json",
      "dsh/node_modules/@deepseek-ai/dsh/package.json",
      "dsh/node_modules/@deepseek-ai/dsh-desktop-host/package.json",
      "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js",
    ])
      if (!observedPaths.has(await realpath(join(root, path))))
        throw Error("UPDATE_CORE_ARTIFACT_INCOMPLETE");
  }
  const packages = ctx.get("pluginPackages"),
    base = ctx.fiber.entry?.parent.tree.ctx.baseUrl;
  if (!packages || !base) throw Error("UPDATE_CORE_RESOLUTION_REQUIRED");
  // These services govern runtime package resolution, namespace identity and installation.
  for (const name of criticalSdk) {
    const actual = packages.packageOf(name, base);
    if (!actual || !contained(root, await realpath(actual.dir)))
      throw Error("UPDATE_CORE_RESOLUTION_MISMATCH");
    if (
      desktop &&
      (await realpath(actual.dir)) !== (await realpath(join(root, "dsh/node_modules", name)))
    )
      throw Error("UPDATE_CORE_RESOLUTION_MISMATCH");
    const sourceManifest = updateObject(
      JSON.parse(await readFile(join(actual.dir, "package.json"), "utf8")),
    );
    if (
      sourceManifest.name !== name ||
      actual.manifest.name !== name ||
      actual.manifest.version !== sourceManifest.version
    )
      throw Error("UPDATE_CORE_SDK_MISMATCH");
    if (desktop && !observedPaths.has(await realpath(join(actual.dir, "package.json"))))
      throw Error("UPDATE_CORE_ARTIFACT_INCOMPLETE");
    if (
      desktop &&
      (JSON.stringify(actual.manifest.exports) !== JSON.stringify(sourceManifest.exports) ||
        actual.manifest.main !== sourceManifest.main)
    )
      throw Error("UPDATE_CORE_SDK_MISMATCH");
    const entry = actual.manifest.exports;
    for (const subpath of name === "@deepseek-ai/dsh-plugin-manager"
      ? [".", "./operations"]
      : ["."]) {
      const exports = entry && typeof entry === "object" ? updateObject(entry) : undefined;
      const selected =
        exports && Object.keys(exports).some((key) => key.startsWith("."))
          ? exports[subpath]
          : subpath === "."
            ? entry
            : undefined;
      const target =
        runtimeExportTarget(selected) ??
        (entry === undefined && subpath === "." ? actual.manifest.main : undefined);
      if (
        typeof target !== "string" ||
        !observedPaths.has(await realpath(join(actual.dir, target)))
      )
        throw Error("UPDATE_CORE_ARTIFACT_INCOMPLETE");
    }
  }
  const sdk: Record<string, string> = {};
  if (runtime) {
    const dependencies = updateObject(runtime.dependencies);
    for (const name of ["@deepseek-ai/dsh", "@deepseek-ai/dsh-desktop-host", ...criticalSdk])
      if (typeof dependencies[name] !== "string") throw Error("UPDATE_CORE_SDK_MISMATCH");
    for (const [name, version] of Object.entries(dependencies)) {
      if (!name.startsWith("@deepseek-ai/")) continue;
      if (!/^@deepseek-ai\/[a-z0-9][a-z0-9._~-]*$/.test(name) || typeof version !== "string")
        throw Error("UPDATE_CORE_SDK_MISMATCH");
      const manifestPath = await realpath(join(root, "dsh/node_modules", name, "package.json"));
      if (!contained(root, manifestPath)) throw Error("UPDATE_CORE_SDK_MISMATCH");
      const manifest = updateObject(JSON.parse(await readFile(manifestPath, "utf8")));
      if (manifest.name !== name || manifest.version !== version)
        throw Error("UPDATE_CORE_SDK_MISMATCH");
      sdk[name] = version;
    }
    return { head: proof.head, version: proof.version, sdk };
  }
  for (const path of (await git(["ls-files", "*package.json"])).split("\n")) {
    if (!/^(apps|packages|vendor)\//.test(path)) continue;
    const manifest = updateObject(JSON.parse(await readFile(join(root, path), "utf8")));
    if (
      typeof manifest.name === "string" &&
      manifest.name.startsWith("@deepseek-ai/") &&
      typeof manifest.version === "string"
    )
      sdk[manifest.name] = manifest.version;
  }
  return { head: proof.head, version: proof.version, sdk };
}

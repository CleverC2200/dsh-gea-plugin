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
const contained = (root: string, path: string) => {
  const local = relative(root, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith("../");
};

/** Verify an explicitly admitted source deployment against its real launcher and artifact hashes. */
export async function readPluginUpdateCore(ctx: Context, raw: unknown): Promise<FixedCore> {
  const proof = updateObject(raw);
  if (
    Object.keys(proof).some((key) => !["root", "head", "version", "artifacts"].includes(key)) ||
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
      await run("git", ["-C", root, ...args], { timeout: 5000, maxBuffer: 4_000_000 })
    ).stdout.trim();
  if (
    (await git(["rev-parse", "HEAD"])) !== proof.head ||
    (await git(["status", "--porcelain", "--untracked-files=no"]))
  )
    throw Error("UPDATE_CORE_SOURCE_MISMATCH");
  const launcher = updateObject(JSON.parse(await readFile(anchor, "utf8")));
  if (launcher.name !== "@deepseek-ai/dsh" || launcher.version !== proof.version)
    throw Error("UPDATE_CORE_VERSION_MISMATCH");
  const observedPaths = new Set<string>();
  for (const rawArtifact of proof.artifacts) {
    const artifact = updateObject(rawArtifact);
    if (
      typeof artifact.path !== "string" ||
      !/^(apps|packages|vendor)\//.test(artifact.path) ||
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
  const packages = ctx.get("pluginPackages"),
    base = ctx.fiber.entry?.parent.tree.ctx.baseUrl;
  if (!packages || !base) throw Error("UPDATE_CORE_RESOLUTION_REQUIRED");
  // These services govern runtime package resolution, namespace identity and installation.
  for (const name of [
    "@deepseek-ai/dsh-app-boot",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-plugin-manager",
    "@deepseek-ai/dsh-atomic-write",
  ]) {
    const actual = packages.packageOf(name, base);
    if (!actual || !contained(root, await realpath(actual.dir)))
      throw Error("UPDATE_CORE_RESOLUTION_MISMATCH");
    const sourceManifest = updateObject(
      JSON.parse(await readFile(join(actual.dir, "package.json"), "utf8")),
    );
    if (actual.manifest.name !== name || actual.manifest.version !== sourceManifest.version)
      throw Error("UPDATE_CORE_SDK_MISMATCH");
    const entry = actual.manifest.exports;
    for (const subpath of name === "@deepseek-ai/dsh-plugin-manager"
      ? [".", "./operations"]
      : ["."]) {
      const selected =
        typeof entry === "object" && entry !== null
          ? updateObject(entry)[subpath]
          : subpath === "."
            ? entry
            : undefined;
      const target =
        typeof selected === "string"
          ? selected
          : selected && typeof selected === "object"
            ? updateObject(selected).default
            : subpath === "."
              ? actual.manifest.main
              : undefined;
      if (
        typeof target !== "string" ||
        !observedPaths.has(await realpath(join(actual.dir, target)))
      )
        throw Error("UPDATE_CORE_ARTIFACT_INCOMPLETE");
    }
  }
  const sdk: Record<string, string> = {};
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

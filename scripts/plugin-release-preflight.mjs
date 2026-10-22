import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { readPluginUpdateCore } from "../src/host/plugin-update-core.ts";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { inspectPluginArchive } from "../src/host/plugin-release-source.ts";
import {
  companyPackageNames,
  projectPluginRelease,
  findPluginUpdatePath,
  comparePluginVersions,
  parsePluginManifest,
  parseInstalledPluginManifest,
} from "../src/shared/plugin-release.mjs";
import { sourceChanges, verifyPackageBuild, builtArchive } from "./package-source-integrity.mjs";
import { findSupportedCore } from "./supported-cores.mjs";
import { verifyUpgradeReceipts } from "./step-upgrade-receipts.mjs";

const fail = (code, detail = "") => {
  throw Error(`${code}${detail ? ": " + detail : ""}`);
};
const read = async (path) => JSON.parse(await readFile(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absolute = (path) =>
  typeof path === "string" && isAbsolute(path) ? path : fail("RELEASE_ABSOLUTE_INPUTS_REQUIRED");

function validateGraph(manifests) {
  if (
    !Array.isArray(manifests) ||
    new Set(manifests.map((manifest) => manifest?.name)).size !== manifests.length ||
    !companyPackageNames.every((name) => manifests.some((manifest) => manifest?.name === name))
  )
    fail("RELEASE_INSTALLED_GRAPH_INCOMPLETE");
  for (const manifest of manifests) {
    if (typeof manifest?.name !== "string" || !manifest.name)
      fail("RELEASE_INSTALLED_GRAPH_INCOMPLETE");
    if (companyPackageNames.includes(manifest.name)) parsePluginManifest(manifest);
    else parseInstalledPluginManifest(manifest);
    if (
      companyPackageNames.includes(manifest.name) &&
      !/^[a-f0-9]{64}$/.test(manifest.artifactSha256)
    )
      fail("RELEASE_ARTIFACT_IDENTITY_REQUIRED", manifest.name);
  }
}

function validateCore(core) {
  if (
    !core ||
    !/^[a-f0-9]{40}$/.test(core.head) ||
    !core.sdk ||
    typeof core.sdk !== "object" ||
    Array.isArray(core.sdk) ||
    !Object.keys(core.sdk).length
  )
    fail("RELEASE_CORE_SDK_REQUIRED");
  try {
    comparePluginVersions(core.version, core.version);
    for (const [name, version] of Object.entries(core.sdk)) {
      if (!name || typeof version !== "string") fail("RELEASE_CORE_SDK_REQUIRED");
      comparePluginVersions(version, version);
    }
  } catch {
    fail("RELEASE_CORE_SDK_REQUIRED");
  }
}

export async function runPluginReleasePreflight(inputPath, { desktopCore } = {}) {
  const input = await read(absolute(inputPath));
  if (
    input?.schemaVersion !== 1 ||
    !Array.isArray(input.targets) ||
    input.targets.length !== 3 ||
    !Array.isArray(input.supportedStarts) ||
    !input.supportedStarts.length
  )
    fail("RELEASE_PREFLIGHT_INPUT_REQUIRED");
  if (
    !Array.isArray(input.sources) ||
    input.sources.length !== 3 ||
    new Set(input.sources.map((source) => source.name)).size !== 3
  )
    fail("RELEASE_SOURCE_COVERAGE_REQUIRED");
  const sources = [];
  for (const source of input.sources) {
    if (
      !companyPackageNames.includes(source.name) ||
      !/^[a-f0-9]{40}$/.test(source.head) ||
      !Array.isArray(source.requiredCommits) ||
      !source.requiredCommits.length ||
      !source.requiredCommits.every((commit) => /^[a-f0-9]{40}$/.test(commit))
    )
      fail("RELEASE_SOURCE_COVERAGE_REQUIRED");
    const path = await realpath(absolute(source.path));
    const git = (...args) =>
      execFileSync("git", ["-C", path, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    if (git("rev-parse", "HEAD") !== source.head) fail("RELEASE_SOURCE_HEAD_MISMATCH", source.name);
    if (sourceChanges(path).length) fail("RELEASE_SOURCE_DIRTY", source.name);
    for (const commit of source.requiredCommits) {
      if (
        spawnSync("git", ["-C", path, "merge-base", "--is-ancestor", commit, source.head])
          .status !== 0
      )
        fail("RELEASE_REQUIRED_COMMIT_MISSING", `${source.name}@${commit}`);
    }
    sources.push({ ...source, path, manifest: await read(join(path, "package.json")) });
  }
  if (typeof input.deliveryManifest !== "string" || !isAbsolute(input.deliveryManifest))
    fail("RELEASE_DELIVERY_MANIFEST_REQUIRED");
  const deliveryBytes = await readFile(input.deliveryManifest),
    delivery = JSON.parse(deliveryBytes);
  if (
    delivery?.stage !== "ordinary-three-package-delivery" ||
    delivery.status !== "packaged" ||
    !Array.isArray(delivery.packages) ||
    delivery.packages.length !== 3 ||
    new Set(delivery.packages.map((row) => row.name)).size !== 3
  )
    fail("RELEASE_DELIVERY_MANIFEST_REQUIRED");
  const targets = [];
  for (const target of input.targets) {
    const bytes = await readFile(absolute(target.archive)),
      metadata = await read(absolute(target.metadata));
    if (
      !Array.isArray(metadata.supportedCores) ||
      !metadata.supportedCores.length ||
      !metadata.supportedCores.every(
        (core) =>
          findSupportedCore(core) ||
          (desktopCore && core?.head === desktopCore.head && core?.version === desktopCore.version),
      )
    )
      fail("RELEASE_CORE_UNSUPPORTED");
    const manifest = await inspectPluginArchive(target.archive);
    const release = projectPluginRelease({
      manifest,
      artifact: { url: metadata.artifactUrl, size: bytes.length, sha256: digest(bytes) },
      supportedCores: metadata.supportedCores,
      dataCompatibility: metadata.dataCompatibility,
      notes: metadata.notes,
    });
    const source = sources.find((entry) => entry.name === release.name);
    if (
      !source ||
      source.manifest.name !== release.name ||
      source.manifest.version !== release.version
    )
      fail("RELEASE_SOURCE_ARTIFACT_MISMATCH", release.name);
    const delivered = delivery.packages.find((row) => row.name === release.name);
    if (
      !delivered ||
      delivered.version !== release.version ||
      delivered.sha256 !== release.artifact.sha256 ||
      delivered.source?.head !== source.head ||
      (await realpath(absolute(delivered.source?.path))) !== source.path ||
      typeof delivered.filename !== "string" ||
      (await realpath(join(dirname(input.deliveryManifest), "packages", delivered.filename))) !==
        (await realpath(target.archive))
    )
      fail("RELEASE_DELIVERY_SOURCE_MISMATCH", release.name);
    const build = await verifyPackageBuild({
      path: source.path,
      head: source.head,
      buildReceipt: delivered.source.buildReceipt,
      lock: release.name === companyPackageNames[0] ? "package-lock.json" : "pnpm-lock.yaml",
    });
    if (
      build.lockSha256 !== delivered.source.lockSha256 ||
      build.buildReceiptSha256 !== delivered.source.buildReceiptSha256
    )
      fail("RELEASE_DELIVERY_SOURCE_MISMATCH", release.name);
    builtArchive(
      target.archive,
      JSON.parse(
        execFileSync("tar", ["-xOf", target.archive, "package/package.json"], {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        }),
      ),
      build.outputs,
    );
    targets.push({ ...target, metadataSha256: digest(await readFile(target.metadata)), release });
  }
  if (new Set(targets.map(({ release }) => release.name)).size !== 3)
    fail("RELEASE_TARGET_GRAPH_INCOMPLETE");
  if (!Array.isArray(input.deployed) || !input.deployed.length)
    fail("RELEASE_DEPLOYED_INPUT_REQUIRED");
  for (const snapshot of [...input.deployed, ...input.supportedStarts]) {
    if (typeof snapshot.id !== "string" || !snapshot.id) fail("RELEASE_SNAPSHOT_ID_REQUIRED");
    validateGraph(snapshot.installed);
    for (const { release } of targets) {
      const installed = snapshot.installed.find((manifest) => manifest.name === release.name);
      const comparison = comparePluginVersions(release.version, installed.version);
      if (comparison < 0)
        fail(
          "RELEASE_VERSION_BELOW_DEPLOYED_HIGH_WATER",
          `${snapshot.id}:${release.name}@${installed.version}`,
        );
      if (comparison === 0 && release.artifact.sha256 !== installed.artifactSha256)
        fail(
          "RELEASE_SAME_VERSION_CONTENT_MISMATCH",
          `${snapshot.id}:${release.name}@${installed.version}`,
        );
    }
  }
  for (const start of input.supportedStarts) {
    validateCore(start.core);
    const order = findPluginUpdatePath({
      core: start.core,
      installed: start.installed,
      releases: targets.map(({ release }) => release),
    });
    if (!order) fail("RELEASE_UPGRADE_PATH_MISSING", start.id);
  }
  const runtime = await verifyUpgradeReceipts(
    input.upgradeVerification,
    input.supportedStarts,
    targets,
  );
  const paths = runtime.paths.map(({ id, order }) => ({ id, order }));
  return {
    status: "release-preflight-passed",
    inputSha256: digest(await readFile(inputPath)),
    deliveryManifestSha256: digest(deliveryBytes),
    sources: sources.map(({ manifest: _manifest, ...source }) => source),
    targets,
    paths,
    upgradeRuntime: runtime,
  };
}

export async function readReleaseDesktopCore(proofPath) {
  if (proofPath === undefined) return undefined;
  let desktopCore;
  if (!isAbsolute(proofPath)) throw Error("RELEASE_ABSOLUTE_INPUTS_REQUIRED");
  const proof = JSON.parse(await readFile(proofPath, "utf8"));
  if (proof?.kind !== "desktop" || typeof proof.root !== "string" || !isAbsolute(proof.root))
    throw Error("UPDATE_CORE_PROVENANCE_REQUIRED");
  const { Context } = await import("@deepseek-ai/cordis");
  const { PluginPackages } = await import("@deepseek-ai/dsh-app-boot");
  const context = new Context();
  try {
    await context.plugin(PluginPackages);
    desktopCore = await readPluginUpdateCore(
      {
        profileContext: {
          installAnchor: join(proof.root, "dsh/node_modules/@deepseek-ai/dsh/package.json"),
        },
        fiber: {
          entry: {
            parent: {
              tree: { ctx: { baseUrl: pathToFileURL(join(proof.root, "dsh/package.json")).href } },
            },
          },
        },
        get: (name) => context.get(name),
      },
      proof,
    );
  } finally {
    await context.fiber.dispose();
  }
  return desktopCore;
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { artifactSetSha256, digest } from "./plugin-reception/contract.mjs";
import { companyPackageNames, planPluginUpdate } from "../src/shared/plugin-release.mjs";

export async function verifyUpgradeReceipts(file, starts, targets) {
  const files = Array.isArray(file) ? file : [file];
  assert(
    files.length > 0 && files.every((path) => typeof path === "string" && isAbsolute(path)),
    "RELEASE_UPGRADE_RUNTIME_REQUIRED",
  );
  const receipts = await Promise.all(
    files.map(async (path) => ({ path, bytes: await readFile(path) })),
  );
  const observer = await readFile(
    new URL("./plugin-reception/observe-worker.mjs", import.meta.url),
  );
  const targetArtifacts = targets.map(({ release }) => ({
    name: release.name,
    version: release.version,
    sha256: release.artifact.sha256,
  }));
  for (const stored of receipts) {
    const receipt = JSON.parse(stored.bytes);
    assert(
      receipt.schema === 1 &&
        receipt.status === "step-upgrades-verified" &&
        Array.isArray(receipt.paths),
      "RELEASE_UPGRADE_RUNTIME_REQUIRED",
    );
    assert.equal(receipt.observerSha256, digest(observer), "RELEASE_UPGRADE_OBSERVER_CHANGED");
    assert.equal(
      artifactSetSha256(receipt.targets),
      artifactSetSha256(targetArtifacts),
      "RELEASE_UPGRADE_TARGET_MISMATCH",
    );
    stored.receipt = receipt;
  }
  const paths = [];
  for (const start of starts) {
    const matching = receipts.filter(
      ({ receipt }) =>
        receipt.core.head === start.core.head && receipt.core.version === start.core.version,
    );
    assert(matching.length > 0, "RELEASE_UPGRADE_CORE_MISMATCH");
    const candidates = matching.flatMap(({ receipt }) =>
      receipt.paths.filter((row) => row.id === start.id),
    );
    assert(candidates.length > 0, "RELEASE_UPGRADE_START_NOT_VERIFIED");
    const initial = start.installed
      .filter((row) => companyPackageNames.includes(row.name))
      .map((row) => ({ name: row.name, version: row.version, sha256: row.artifactSha256 }));
    for (const candidate of candidates) {
      assert.equal(
        candidate.startArtifactSetSha256,
        artifactSetSha256(initial),
        "RELEASE_UPGRADE_START_MISMATCH",
      );
      assert.deepEqual(
        [...candidate.order].sort(),
        [...companyPackageNames].sort(),
        "RELEASE_UPGRADE_ORDER_INVALID",
      );
      assert.equal(candidate.steps.length, candidate.order.length, "RELEASE_UPGRADE_STEP_MISSING");
      let installed = start.installed,
        artifacts = initial;
      for (const [index, name] of candidate.order.entries()) {
        const release = targets.find((row) => row.release.name === name).release;
        const plan = planPluginUpdate({ core: start.core, installed, release });
        assert(["ready", "current"].includes(plan.kind), "RELEASE_UPGRADE_STEP_INCOMPATIBLE");
        installed = installed.map((row) =>
          row.name === name ? { ...release, artifactSha256: release.artifact.sha256 } : row,
        );
        artifacts = artifacts.map((row) =>
          row.name === name ? targetArtifacts.find((target) => target.name === name) : row,
        );
        const step = candidate.steps[index];
        assert.equal(
          step.installedArchiveBytesVerified,
          true,
          "RELEASE_UPGRADE_INSTALLED_BYTES_UNVERIFIED",
        );
        assert.equal(step.packageName, name, "RELEASE_UPGRADE_ORDER_INVALID");
        assert.equal(
          step.artifactSetSha256,
          artifactSetSha256(artifacts),
          "RELEASE_UPGRADE_STEP_INPUT_MISMATCH",
        );
        assert(isAbsolute(step.observation ?? ""), "RELEASE_UPGRADE_OBSERVATION_REQUIRED");
        const bytes = await readFile(step.observation),
          observed = JSON.parse(bytes);
        assert.equal(digest(bytes), step.observationSha256, "RELEASE_UPGRADE_OBSERVATION_CHANGED");
        assert.equal(
          observed.artifactSetSha256,
          step.artifactSetSha256,
          "RELEASE_UPGRADE_STEP_INPUT_MISMATCH",
        );
        assert(
          observed.success === true && observed.checkpoint === "complete",
          "RELEASE_UPGRADE_RESTART_FAILED",
        );
        assert(
          observed.credentialsReadOrCopied === false &&
            observed.modelTasks === 0 &&
            observed.businessQueries === 0,
          "RELEASE_UPGRADE_OBSERVATION_SCOPE_CHANGED",
        );
        assert(
          observed.upgrade?.identityRouteAvailable && observed.upgrade?.updateRouteAvailable,
          "RELEASE_UPGRADE_SERVICES_UNAVAILABLE",
        );
        assert.deepEqual(
          observed.plugins.map((row) => row.name).sort(),
          [...companyPackageNames].sort(),
          "RELEASE_UPGRADE_PLUGIN_COVERAGE_MISSING",
        );
        assert(
          observed.plugins.every((row) => row.active === true && row.mounts === 1),
          "RELEASE_UPGRADE_PLUGIN_INACTIVE",
        );
        assert.equal(
          Object.values(observed.outgoingAttempts).reduce((sum, value) => sum + value, 0),
          0,
          "RELEASE_UPGRADE_OUTGOING_ATTEMPTED",
        );
        if (index === candidate.order.length - 1)
          assert.deepEqual(
            observed.upgrade.incompatibleResources,
            [],
            "RELEASE_UPGRADE_FINAL_RESOURCE_INCOMPATIBLE",
          );
      }
    }
    paths.push({
      id: start.id,
      order: candidates[0].order,
      verifiedOrders: candidates.map((row) => row.order),
    });
  }
  return { receipts: receipts.map(({ path, bytes }) => ({ path, sha256: digest(bytes) })), paths };
}

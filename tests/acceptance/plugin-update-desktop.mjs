/** Explicit actual desktop snapshot lane; never reads the current App or a user profile. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { installedScenario } from "../fixtures/plugin-updates/installed-runtime.mjs";
import { createReleasePreflightFixture } from "../fixtures/plugin-release-preflight.mjs";
const proofFile = process.env.GEA_PLUGIN_UPDATE_DESKTOP_PROOF;
if (!proofFile || !isAbsolute(proofFile)) throw Error("GEA_PLUGIN_UPDATE_DESKTOP_PROOF required");
const proof = JSON.parse(await readFile(proofFile, "utf8"));

test("release preparation accepts only the explicitly proven desktop identity", async (t) => {
  const fixture = await createReleasePreflightFixture(t, {
    core: {
      head: proof.head,
      version: proof.version,
      sdk: { "@deepseek-ai/dsh-tools": "0.2.0-rc.2" },
    },
  });
  const root = fixture.root,
    artifact = fixture.input.targets[2];
  const metadata = artifact.metadata,
    entry = fileURLToPath(new URL("../../scripts/create-plugin-release.mjs", import.meta.url));
  const input = JSON.parse(await readFile(metadata, "utf8"));
  await writeFile(fixture.file, JSON.stringify(fixture.input));
  const args = [
    "--expose-internals",
    entry,
    "--archive",
    artifact.archive,
    "--metadata",
    metadata,
    "--destination",
    join(root, "release"),
    "--preflight",
    fixture.file,
    "--desktop-core-proof",
    proofFile,
  ];
  const accepted = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  const receipt = JSON.parse(accepted.stdout),
    release = JSON.parse(await readFile(receipt.path, "utf8"));
  assert.deepEqual(release.supportedCores, input.supportedCores);
  assert.equal(receipt.published, false);
  await writeFile(
    metadata,
    JSON.stringify({
      ...input,
      supportedCores: [{ head: "e".repeat(40), version: proof.version }],
    }),
  );
  const rejected = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /RELEASE_CORE_UNSUPPORTED/);
});

test(
  "actual packaged Host routes install through real pnpm and confirm fresh Host/client modules",
  { timeout: 120000 },
  async (t) => {
    const result = await installedScenario(t, proof);
    assert.deepEqual(result.profileRetained, { draft: "keep", selection: "sales" });
    assert.equal(result.personalAgentPreserved, true);
    assert.equal(result.pluginCustomizationPreserved, true);
    assert.equal(result.completeSkillAssetsPreserved, true);
    if (process.env.GEA_PLUGIN_UPDATE_INSTALL_RECEIPT)
      await writeFile(
        process.env.GEA_PLUGIN_UPDATE_INSTALL_RECEIPT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);

/** Explicit actual desktop snapshot lane; never reads the current App or a user profile. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  makeArchive as archive,
  installedScenario,
} from "../fixtures/plugin-updates/installed-runtime.mjs";
const proofFile = process.env.GEA_PLUGIN_UPDATE_DESKTOP_PROOF;
if (!proofFile || !isAbsolute(proofFile)) throw Error("GEA_PLUGIN_UPDATE_DESKTOP_PROOF required");
const proof = JSON.parse(await readFile(proofFile, "utf8"));
const gea = "@cleverc2200/gea-dsh-prototype";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function temporary(t) {
  await mkdir(".runtime", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".runtime/desktop-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("release preparation accepts only the explicitly proven desktop identity", async (t) => {
  const root = await temporary(t),
    artifact = await archive(root, gea, "3.1.0");
  const metadata = join(root, "metadata.json"),
    entry = fileURLToPath(new URL("../../scripts/create-plugin-release.mjs", import.meta.url));
  const input = {
    artifactUrl: `https://fixture.invalid/packages/${digest(artifact.bytes)}/plugin.tgz`,
    supportedCores: [{ head: proof.head, version: proof.version }],
    dataCompatibility: { kind: "preserve" },
    notes: "actual desktop fixture",
  };
  await writeFile(metadata, JSON.stringify(input));
  const args = [
    "--expose-internals",
    entry,
    "--archive",
    artifact.path,
    "--metadata",
    metadata,
    "--destination",
    join(root, "release"),
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
    if (process.env.GEA_PLUGIN_UPDATE_INSTALL_RECEIPT)
      await writeFile(
        process.env.GEA_PLUGIN_UPDATE_INSTALL_RECEIPT,
        JSON.stringify(result, null, 2) + "\n",
      );
  },
);

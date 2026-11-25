import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractAll } from "@electron/asar";
import { installedScenario } from "../plugin-updates/installed-runtime.mjs";
import { coreArtifactPaths, desktopCoreHead } from "../../../scripts/windows-complete-local/input.mjs";

test("Windows three-package update preserves data with system tar unavailable to the updater", { timeout: 180000 }, async (t) => {
  assert.equal(process.platform, "win32");
  const target = process.env.GEA_INSTALLED_SUITE_ROOT;
  const output = process.env.GEA_INSTALLED_SUITE_OUTPUT;
  const root = join(output, "suite-runtime");
  await mkdir(root);
  extractAll(join(target, "resources/app.asar"), root);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(manifest.dshBuildCommit, desktopCoreHead);
  process.env.GEA_PLUGIN_UPDATE_PNPM = join(target, "resources/runtime/pnpm/bin/pnpm.mjs");
  process.env.TAR_OPTIONS = "--gea-fail-if-system-tar-is-invoked";
  const proof = {
    kind: "desktop",
    root,
    head: desktopCoreHead,
    version: JSON.parse(await readFile(join(root, "dsh/package.json"), "utf8")).version,
    artifacts: await Promise.all(coreArtifactPaths.map(async (path) => ({
      path,
      sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
    }))),
  };
  const result = await installedScenario(t, proof, undefined, {
    customStore: true,
    allUpdates: true,
    strictSuitePeers: true,
  });
  assert.deepEqual(result.profileRetained, { draft: "keep", selection: "sales" });
  assert.equal(result.sessionPreserved, true);
  assert.equal(result.operation.stage, "completed");
  assert.equal(result.operation.completionProofs.length, 3);
  await writeFile(join(output, "independent-suite.json"), JSON.stringify({
    status: "passed",
    core: proof.head,
    candidateVersion: manifest.version,
    candidateSource: manifest.geaBrandingCommit,
    packages: result.fresh.items.map(({packageName, runningHostVersion, runningClientVersion}) => ({
      packageName, runningHostVersion, runningClientVersion,
    })),
    sessionPreserved: result.sessionPreserved,
    draftAndSettingsPreserved: result.profileRetained,
    pluginCustomizationPreserved: result.pluginCustomizationPreserved,
  }, null, 2));
});

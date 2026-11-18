import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildR9Bundle, collectR9Evidence, verifyR9Evidence, r9Case } from "./evidence.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const head = "a".repeat(40);
async function fixture(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), "r9-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await buildR9Bundle(join(root, "bundle"), head);
  const artifactRoot = join(root, "native-artifact-recheck");
  await mkdir(artifactRoot);
  const receipt = {
    schemaVersion: 2,
    caseId: r9Case.id,
    acceptanceKind: "historical-signed-overwrite",
    status: "passed",
    actualNativeUpdateAcceptance: true,
    installedBaselineProofs: r9Case.installedBaselineProofs,
    buildReceiptSha256: "b".repeat(64),
    inputSha256: "c".repeat(64),
    syntheticSessionFixturePreserved: true,
    draftMarkerPreserved: true,
    requiredProfileBundlesPresent: true,
    configurationParsedValuesPreservedExceptCoreProof: true,
    configurationBytesUnchanged: false,
    employeeDeviceAcceptance: false,
    realBusinessDraftAcceptance: false,
    businessQueries: 0,
    modelTasks: 0,
  };
  const records = {};
  for (const [key, version, phase, status, name] of [
    ["before", r9Case.baselineVersion, "failed", 404, "baseline-observation.json"],
    ["after", r9Case.targetVersion, "active", 200, "target-observation.json"],
  ]) {
    const inventory = {
      status: 200,
      correlated: true,
      ok: true,
      gea: [
        {
          entryId: "include:gea-proof",
          moduleName: "@cleverc2200/gea-dsh-prototype",
          enabled: true,
          fiberPhase: phase,
        },
      ],
    };
    const routes = ["/api/gea-html/identity", "/api/gea/plugin-updates/status"].map((path) => ({
      path,
      status,
    }));
    const observations = {
      first: { observedAt: "2026-11-17T00:00:00.000Z", inventory, routes },
      second: { observedAt: "2026-11-17T00:00:05.000Z", inventory, routes },
      settleMs: 5000,
    };
    const exit = {
      pid: 123,
      elapsedMs: 100,
      quitAcknowledgement: "acknowledged",
      requestError: null,
      forcedTermination: false,
      forceError: null,
      code: 0,
      signal: null,
      processError: null,
      gracefulExit: true,
    };
    receipt[key] = {
      version,
      normalPackagedMain: true,
      isolatedBeforeReady: true,
      routes,
      pluginInventory: inventory,
      observations,
      exit,
    };
    records[version + "-exit.json"] = exit;
    const packages = {
      ...r9Case.packages,
      ...(key === "before" ? { "@cleverc2200/gea-dsh-prototype": r9Case.baselineGeaVersion } : {}),
    };
    records[name] = {
      observations,
      installedPackages: Object.entries(packages).map(([name, version]) => ({ name, version })),
    };
  }
  records["receipt.json"] = receipt;
  records["bundle-binding.json"] = {
    status: "passed",
    actualNativeUpdateAcceptance: true,
    bundleSha256: bundle.sha256,
    bundleUrl: bundle.url,
    buildReceiptSha256: receipt.buildReceiptSha256,
    inputSha256: receipt.inputSha256,
  };
  change(records);
  for (const [file, value] of Object.entries(records))
    await writeFile(join(artifactRoot, file), JSON.stringify(value));
  execFileSync("zip", ["-qr", "artifact.zip", "native-artifact-recheck"], { cwd: root });
  const archive = await readFile(join(root, "artifact.zip"));
  const run = {
    id: 123,
    head_sha: head,
    event: "workflow_dispatch",
    path: ".github/workflows/delivery-fixtures.yml",
    status: "completed",
    conclusion: "success",
    repository: { full_name: r9Case.repository },
  };
  const job = {
    id: 456,
    name: "windows-overwrite-recheck",
    conclusion: "success",
    steps: [
      "Verify original main packaging source",
      "Prepare artifact acceptance dependencies",
      "Recheck Native recovery using the original installer artifact",
    ].map((name) => ({ name, conclusion: "success" })),
  };
  const artifact = {
    id: 789,
    name: `windows-overwrite-recheck-${r9Case.originalBuildRun}`,
    expired: false,
    size_in_bytes: archive.length,
    digest: "sha256:" + sha(archive),
    workflow_run: { id: run.id },
  };
  const github = {
    json(path) {
      if (path === "actions/runs/123") return run;
      if (path === `actions/runs/${r9Case.originalBuildRun}`)
        return {
          id: r9Case.originalBuildRun,
          head_branch: "main",
          event: "workflow_dispatch",
          head_sha: r9Case.originalSourceSha,
        };
      if (path === `actions/artifacts/${r9Case.originalArtifactId}`)
        return {
          id: r9Case.originalArtifactId,
          digest: r9Case.originalArtifactDigest,
          workflow_run: { id: r9Case.originalBuildRun },
        };
      throw Error(path);
    },
    pages(path) {
      if (path.startsWith("actions/runs/123/jobs")) return [job];
      if (path.startsWith("actions/runs/123/artifacts"))
        return run.conclusion === "success" ? [artifact] : [];
      if (path.startsWith(`actions/runs/${r9Case.originalBuildRun}/jobs`))
        return [
          {
            name: "windows-complete-package",
            steps: [
              {
                name: "Build full Windows package and verify isolated first installation",
                conclusion: "success",
              },
            ],
          },
        ];
      throw Error(path);
    },
    bytes(path) {
      if (path === "actions/artifacts/789/zip") return archive;
      if (path === "actions/jobs/456/logs") return Buffer.from("raw native log\n");
      throw Error(path);
    },
  };
  const output = join(root, "capture");
  return {
    root,
    output,
    bundle,
    run,
    github,
    collect: () =>
      collectR9Evidence({
        runId: run.id,
        expectedHead: head,
        bundleFile: join(root, "bundle/bundle.json"),
        output,
        github,
      }),
  };
}

test("bundle is reproducible and binds maintained helpers to the unchanged historical bundle", async (t) => {
  const f = await fixture(t);
  const second = await buildR9Bundle(join(f.root, "second"), head);
  assert.equal(second.sha256, f.bundle.sha256);
  assert.deepEqual(second.originalBundle, r9Case.originalBundle);
  assert.equal(Object.keys(second.sourceHashes).length, 6);
  await assert.rejects(buildR9Bundle(join(f.root, "bundle"), head), { code: "EEXIST" });
});

test("collector refuses sealed output before any network call", async (t) => {
  const f = await fixture(t);
  f.github.json = () => {
    throw Error("NETWORK_MUST_NOT_RUN");
  };
  await assert.rejects(
    collectR9Evidence({
      runId: 123,
      expectedHead: head,
      bundleFile: join(f.root, "bundle/bundle.json"),
      output: join(f.root, "bundle/forbidden"),
      github: f.github,
    }),
    /R9_SEALED_OUTPUT_FORBIDDEN/,
  );
});

test("capture and offline verification are separate and leave the sealed input unchanged", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.collect()).acceptance, "not-evaluated");
  const before = await readFile(join(f.output, "SHA256SUMS.json"));
  const result = await verifyR9Evidence(f.output);
  assert.equal(result.status, "passed");
  assert.equal(result.configurationBytesUnchanged, false);
  assert.equal(result.realBusinessDraftAcceptance, false);
  assert.deepEqual(await readFile(join(f.output, "SHA256SUMS.json")), before);
  assert.equal((await verifyR9Evidence(f.output)).status, "passed");
  await writeFile(join(f.output, "native-job.log"), "changed");
  await assert.rejects(verifyR9Evidence(f.output), /R9_CAPTURE_CHANGED/);
});

test("failed Native run retains its raw log without promoting it to acceptance", async (t) => {
  const f = await fixture(t);
  f.run.conclusion = "failure";
  assert.deepEqual(await f.collect(), {
    status: "captured",
    runId: 123,
    conclusion: "failure",
    artifactCaptured: false,
    output: f.output,
    acceptance: "not-evaluated",
  });
  assert.equal(await readFile(join(f.output, "native-job.log"), "utf8"), "raw native log\n");
  await assert.rejects(verifyR9Evidence(f.output));
});

test("offline verifier rejects forced exit, unstable phase and a proof moved to another package", async (t) => {
  for (const change of [
    (records) => {
      records["receipt.json"].after.exit.forcedTermination = true;
    },
    (records) => {
      records["receipt.json"].after.observations.second.inventory.gea[0].fiberPhase = "failed";
    },
    (records) => {
      records["receipt.json"].installedBaselineProofs = r9Case.installedBaselineProofs.map(
        (row, i) => (i ? row : { ...row, name: "wrong-owner" }),
      );
    },
  ]) {
    const f = await fixture(t, change);
    await f.collect();
    await assert.rejects(verifyR9Evidence(f.output));
  }
});

test("collector rejects bundle metadata from a different checkout", async (t) => {
  const f = await fixture(t);
  f.run.head_sha = "d".repeat(40);
  await assert.rejects(f.collect());
});

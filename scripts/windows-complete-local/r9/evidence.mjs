import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { create } from "tar";
import { assertObservation } from "./runtime.mjs";

export const r9Case = JSON.parse(await readFile(new URL("./case.json", import.meta.url), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceFiles = [
  "case.json",
  "install-old.mjs",
  "install.ps1",
  "runtime.mjs",
  "seed-history.mjs",
  "windows-run.mjs",
];
const evidenceFiles = [
  "receipt.json",
  "bundle-binding.json",
  "baseline-observation.json",
  "target-observation.json",
  r9Case.baselineVersion + "-exit.json",
  r9Case.targetVersion + "-exit.json",
];

async function createOutput(output) {
  const target = resolve(output);
  let parent = await realpath(dirname(target));
  for (;;) {
    let sealed = false;
    try {
      await access(join(parent, "SHA256SUMS.json"));
      sealed = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(sealed, false, "R9_SEALED_OUTPUT_FORBIDDEN");
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  await mkdir(target);
  return target;
}

export async function buildR9Bundle(output, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  const sourceHashes = {};
  for (const file of sourceFiles)
    sourceHashes[file] = digest(await readFile(new URL(file, import.meta.url)));
  const chunks = [];
  for await (const bytes of create(
    { cwd: import.meta.dirname, prefix: "package", portable: true, noMtime: true, gzip: true },
    sourceFiles,
  ))
    chunks.push(bytes);
  const bytes = Buffer.concat(chunks);
  const sha256 = digest(bytes);
  const name = "gea218-r9.tgz";
  const bundle = {
    schemaVersion: 2,
    caseId: r9Case.id,
    sourceSha,
    originalBundle: r9Case.originalBundle,
    originalBuildRun: r9Case.originalBuildRun,
    sha256,
    size: bytes.length,
    sourceHashes,
    url: `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/verification/${sha256}/${name}`,
  };
  const directory = await createOutput(output);
  await writeFile(join(directory, name), bytes, { flag: "wx" });
  await writeFile(join(directory, "bundle.json"), JSON.stringify(bundle, null, 2) + "\n", {
    flag: "wx",
  });
  await seal(directory, [name, "bundle.json"]);
  return bundle;
}

export async function uploadR9Bundle(directory) {
  const bundle = JSON.parse(await readFile(join(directory, "bundle.json"), "utf8"));
  const bytes = await readFile(join(directory, "gea218-r9.tgz"));
  assert.equal(digest(bytes), bundle.sha256);
  const key = `client-release/verification/${bundle.sha256}/gea218-r9.tgz`;
  assert.equal(bundle.url, "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/" + key);
  let response = await fetch(bundle.url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (response.status === 404) {
    const id = process.env.OSS_ACCESS_KEY_ID,
      secret = process.env.OSS_ACCESS_KEY_SECRET;
    assert.ok(id && secret, "R9_VERIFICATION_CREDENTIALS_REQUIRED");
    const date = new Date().toUTCString();
    const canonical = `PUT\n\napplication/octet-stream\n${date}\nx-oss-forbid-overwrite:true\nx-oss-object-acl:public-read\n/synear-gea/${key}`;
    const signature = createHmac("sha1", secret).update(canonical).digest("base64");
    response = await fetch(bundle.url, {
      method: "PUT",
      redirect: "error",
      signal: AbortSignal.timeout(60000),
      headers: {
        Date: date,
        Authorization: `OSS ${id}:${signature}`,
        "Content-Type": "application/octet-stream",
        "x-oss-forbid-overwrite": "true",
        "x-oss-object-acl": "public-read",
      },
      body: bytes,
    });
    assert.ok([200, 409].includes(response.status), "R9_VERIFICATION_UPLOAD_FAILED");
  } else assert.equal(response.status, 200);
  response = await fetch(bundle.url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    bytes,
    "R9_VERIFICATION_READBACK_FAILED",
  );
  return { ...bundle, anonymousReadback: true, releasePerformed: false };
}

const gh = (path, binary = false) =>
  execFileSync("gh", ["api", `repos/${r9Case.repository}/${path}`], {
    encoding: binary ? "buffer" : "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GODEBUG: "http2client=0" },
  });
const api = (path) => JSON.parse(gh(path));
function pages(path, key) {
  const values = JSON.parse(
    execFileSync("gh", ["api", `repos/${r9Case.repository}/${path}`, "--paginate", "--slurp"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  return values.flatMap((page) => page[key]);
}

function assertCapture(capture, requireSuccess = true) {
  const { run, jobs, artifact, originalRun, originalJobs, originalArtifact, bundle, expectedHead } =
    capture;
  assert.match(expectedHead, /^[a-f0-9]{40}$/);
  assert.equal(run.head_sha, expectedHead);
  assert.equal(bundle.sourceSha, expectedHead, "R9_BUNDLE_SOURCE_MISMATCH");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.path.split("@")[0], ".github/workflows/delivery-fixtures.yml");
  assert.equal(run.status, "completed");
  if (requireSuccess) assert.equal(run.conclusion, "success");
  assert.equal(run.repository.full_name, r9Case.repository);
  const job = jobs.find((entry) => entry.name === "windows-overwrite-recheck");
  if (requireSuccess) {
    assert.equal(job?.conclusion, "success");
    for (const name of [
      "Verify original main packaging source",
      "Prepare artifact acceptance dependencies",
      "Recheck Native recovery using the original installer artifact",
    ])
      assert.equal(job.steps.find((step) => step.name === name)?.conclusion, "success");
  }
  if (artifact) {
    assert.equal(artifact.name, `windows-overwrite-recheck-${r9Case.originalBuildRun}`);
    assert.equal(artifact.workflow_run.id, run.id);
  }
  if (requireSuccess) {
    assert.ok(artifact, "R9_ARTIFACT_REQUIRED");
    assert.equal(capture.logCaptureError, null, "R9_LOG_CAPTURE_REQUIRED");
  }
  assert.equal(originalRun.id, r9Case.originalBuildRun);
  assert.equal(originalRun.head_branch, "main");
  assert.equal(originalRun.event, "workflow_dispatch");
  assert.equal(originalRun.head_sha, r9Case.originalSourceSha);
  assert.equal(originalArtifact.id, r9Case.originalArtifactId);
  assert.equal(originalArtifact.digest, r9Case.originalArtifactDigest);
  assert.equal(originalArtifact.workflow_run.id, originalRun.id);
  const build = originalJobs.find((entry) => entry.name === "windows-complete-package");
  assert.equal(
    build?.steps.find(
      (step) => step.name === "Build full Windows package and verify isolated first installation",
    )?.conclusion,
    "success",
  );
  assert.equal(bundle.caseId, r9Case.id);
  assert.deepEqual(bundle.originalBundle, r9Case.originalBundle);
  assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    bundle.url,
    `https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/verification/${bundle.sha256}/gea218-r9.tgz`,
  );
}

const githubApi = { json: api, pages, bytes: (path) => gh(path, true) };

async function seal(directory, files) {
  const manifest = {};
  for (const file of files) manifest[file] = digest(await readFile(join(directory, file)));
  await writeFile(join(directory, "SHA256SUMS.json"), JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
}

export async function collectR9Evidence({
  runId,
  expectedHead,
  bundleFile,
  output,
  github = githubApi,
}) {
  assert.match(String(runId), /^[1-9][0-9]*$/);
  assert.match(expectedHead, /^[a-f0-9]{40}$/);
  const bundle = JSON.parse(await readFile(bundleFile, "utf8"));
  const directory = await createOutput(output);
  const run = github.json(`actions/runs/${runId}`);
  const jobs = github.pages(`actions/runs/${runId}/jobs?filter=latest&per_page=100`, "jobs");
  const artifacts = github.pages(`actions/runs/${runId}/artifacts?per_page=100`, "artifacts");
  const artifact =
    artifacts.find(
      (entry) => entry.name === `windows-overwrite-recheck-${r9Case.originalBuildRun}`,
    ) ?? null;
  if (artifact)
    assert.ok(
      !artifact.expired && artifact.size_in_bytes < 10 * 1024 * 1024,
      "R9_ARTIFACT_UNAVAILABLE",
    );
  const capture = {
    expectedHead,
    bundle,
    run,
    jobs,
    artifact,
    originalRun: github.json(`actions/runs/${r9Case.originalBuildRun}`),
    originalJobs: github.pages(`actions/runs/${r9Case.originalBuildRun}/jobs?per_page=100`, "jobs"),
    originalArtifact: github.json(`actions/artifacts/${r9Case.originalArtifactId}`),
    logCaptureError: null,
  };
  assertCapture(capture, false);
  const files = ["capture.json"];
  if (artifact) {
    const archive = github.bytes(`actions/artifacts/${artifact.id}/zip`);
    assert.equal("sha256:" + digest(archive), artifact.digest);
    await writeFile(join(directory, "artifact.zip"), archive, { flag: "wx" });
    files.push("artifact.zip");
  }
  const job = jobs.find((entry) => entry.name === "windows-overwrite-recheck");
  if (job && job.conclusion !== "skipped") {
    try {
      await writeFile(
        join(directory, "native-job.log"),
        github.bytes(`actions/jobs/${job.id}/logs`),
        { flag: "wx" },
      );
      files.push("native-job.log");
    } catch (error) {
      capture.logCaptureError = error.message;
    }
  }
  await writeFile(join(directory, "capture.json"), JSON.stringify(capture, null, 2) + "\n", {
    flag: "wx",
  });
  await seal(directory, files);
  return {
    status: capture.logCaptureError ? "partial-capture" : "captured",
    runId: run.id,
    conclusion: run.conclusion,
    artifactCaptured: !!artifact,
    output: directory,
    acceptance: "not-evaluated",
  };
}

export async function verifyR9Evidence(directory) {
  const manifest = JSON.parse(await readFile(join(directory, "SHA256SUMS.json"), "utf8"));
  assert.ok(
    manifest["capture.json"] && manifest["artifact.zip"] && manifest["native-job.log"],
    "R9_SEALED_CAPTURE_REQUIRED",
  );
  for (const file of ["capture.json", "artifact.zip", "native-job.log"])
    assert.equal(
      digest(await readFile(join(directory, file))),
      manifest[file],
      "R9_CAPTURE_CHANGED: " + file,
    );
  const capture = JSON.parse(await readFile(join(directory, "capture.json"), "utf8"));
  assertCapture(capture);
  const archivePath = join(directory, "artifact.zip");
  assert.equal("sha256:" + digest(await readFile(archivePath)), capture.artifact.digest);
  const records = {};
  for (const file of evidenceFiles)
    records[file] = JSON.parse(
      execFileSync("unzip", ["-p", archivePath, "native-artifact-recheck/" + file], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }),
    );
  const receipt = records["receipt.json"],
    binding = records["bundle-binding.json"];
  assert.equal(receipt.schemaVersion, 2, "R9_RECEIPT_SCHEMA_REQUIRED");
  assert.equal(receipt.caseId, r9Case.id);
  assert.equal(receipt.acceptanceKind, "historical-signed-overwrite");
  for (const record of [receipt, binding]) {
    assert.equal(record.status, "passed");
    assert.equal(record.actualNativeUpdateAcceptance, true);
  }
  assert.equal(binding.bundleSha256, capture.bundle.sha256);
  assert.equal(binding.bundleUrl, capture.bundle.url);
  for (const key of ["buildReceiptSha256", "inputSha256"]) {
    assert.match(receipt[key], /^(?!0{64}$)[a-f0-9]{64}$/);
    assert.equal(receipt[key], binding[key]);
  }
  assert.deepEqual(receipt.installedBaselineProofs, r9Case.installedBaselineProofs);
  for (const [phase, version, state, status, file] of [
    ["before", r9Case.baselineVersion, "failed", 404, "baseline-observation.json"],
    ["after", r9Case.targetVersion, "active", 200, "target-observation.json"],
  ]) {
    const result = receipt[phase],
      observation = records[file];
    assert.equal(result.version, version);
    assert.equal(result.normalPackagedMain, true);
    assert.equal(result.isolatedBeforeReady, true);
    assert.deepEqual(result.observations, observation.observations);
    const { first, second, settleMs } = result.observations;
    assertObservation(first, state, status);
    assertObservation(second, state, status);
    assert.equal(first.inventory.gea[0].entryId, second.inventory.gea[0].entryId);
    assert.ok(settleMs >= 5000);
    assert.ok(Date.parse(second.observedAt) - Date.parse(first.observedAt) >= settleMs);
    assert.deepEqual(result.routes, second.routes);
    assert.deepEqual(result.pluginInventory, second.inventory);
    const shutdown = records[version + "-exit.json"];
    assert.deepEqual(result.exit, shutdown);
    assert.equal(shutdown.gracefulExit, true);
    assert.equal(shutdown.forcedTermination, false);
    assert.equal(shutdown.code, 0);
    assert.equal(shutdown.signal, null);
    assert.equal(shutdown.requestError, null);
    assert.equal(shutdown.forceError, null);
    assert.equal(shutdown.processError, null);
    const expected = {
      ...r9Case.packages,
      ...(phase === "before"
        ? { "@cleverc2200/gea-dsh-prototype": r9Case.baselineGeaVersion }
        : {}),
    };
    assert.deepEqual(
      Object.fromEntries(observation.installedPackages.map((row) => [row.name, row.version])),
      expected,
    );
  }
  for (const flag of [
    "syntheticSessionFixturePreserved",
    "draftMarkerPreserved",
    "requiredProfileBundlesPresent",
    "configurationParsedValuesPreservedExceptCoreProof",
  ])
    assert.equal(receipt[flag], true);
  assert.equal(receipt.employeeDeviceAcceptance, false);
  assert.equal(receipt.realBusinessDraftAcceptance, false);
  assert.equal(receipt.businessQueries, 0);
  assert.equal(receipt.modelTasks, 0);
  return {
    status: "passed",
    caseId: r9Case.id,
    runId: capture.run.id,
    head: capture.expectedHead,
    bundleSha256: capture.bundle.sha256,
    before: receipt.before,
    after: receipt.after,
    syntheticSessionFixturePreserved: true,
    draftMarkerPreserved: true,
    configurationParsedValuesPreservedExceptCoreProof: true,
    configurationBytesUnchanged: receipt.configurationBytesUnchanged,
    employeeDeviceAcceptance: false,
    realBusinessDraftAcceptance: false,
    releasePerformed: false,
  };
}

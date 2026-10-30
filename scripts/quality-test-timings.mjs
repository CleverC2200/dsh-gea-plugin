import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { verifyExecutionResults, executionDigest } from "./quality-test-execution.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const relativeFile = (file) =>
  typeof file === "string" &&
  /^(?:(?:tests|scripts|src|desktop)\/|package\.json$|pnpm-lock\.yaml$)/.test(file) &&
  !file.split("/").some((part) => !part || part === "." || part === "..") &&
  !/[\\\0\r\n]/.test(file);

export function currentTestTimings({ timings, root, environment }) {
  if (!timings?.source || !Array.isArray(timings.files))
    throw Error("QUALITY_TEST_TIMINGS_REQUIRED");
  const seen = new Set();
  for (const entry of timings.files) {
    if (
      !relativeFile(entry.file) ||
      seen.has(entry.file) ||
      !Number.isFinite(entry.durationMs) ||
      entry.durationMs < 0
    )
      throw Error("QUALITY_TEST_TIMING_INVALID");
    seen.add(entry.file);
  }
  const sameEnvironment = ["platform", "node", "core", "fileConcurrency"].every(
    (key) => timings.source[key] === environment[key],
  );
  const observed = new Map();
  const matches = (file, sha256) => {
    if (!relativeFile(file) || !/^[a-f0-9]{64}$/.test(sha256 ?? "")) return false;
    if (!observed.has(file)) {
      try {
        observed.set(file, digest(readFileSync(resolve(root, file))));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        observed.set(file, null);
      }
    }
    return observed.get(file) === sha256;
  };
  const invalidated = [];
  const sameInputs = Object.entries(timings.inputs ?? {}).every(([file, sha256]) =>
    matches(file, sha256),
  );
  const orderingFiles = [];
  const files = timings.files.filter((entry) => {
    const reason =
      timings.schemaVersion !== 2
        ? "unbound-source"
        : !sameEnvironment
          ? "environment-changed"
          : !matches(entry.file, entry.sha256)
            ? "file-changed-or-missing"
            : !Array.isArray(entry.fixtures) ||
                !entry.fixtures.every((file) => matches(file, timings.fixtures?.[file]))
              ? "fixture-changed-or-missing"
              : null;
    if (!reason) orderingFiles.push(entry);
    const predictionReason = reason ?? (!sameInputs ? "shared-input-changed-or-missing" : null);
    if (predictionReason) invalidated.push({ file: entry.file, reason: predictionReason });
    return !predictionReason;
  });
  return {
    source: {
      ...timings.source,
      inputSha256: digest(JSON.stringify(timings)),
      invalidated,
    },
    files,
    orderingFiles,
  };
}

export function timingsFromExecution({ plan, receipts, root, inputs }) {
  const first = receipts[0];
  if (
    !first ||
    receipts.some(
      (receipt) =>
        receipt.planSha256 !== plan.planSha256 ||
        receipt.buildSha256 !== first.buildSha256 ||
        receipt.terminal !== true ||
        receipt.status !== "passed",
    )
  )
    throw Error("QUALITY_TEST_TIMING_EXECUTION_REQUIRED");
  const receipt = {
    ...first,
    scope: "platform",
    results: receipts.flatMap((entry) => entry.results),
  };
  verifyExecutionResults({ plan, receipt, buildSha256: first.buildSha256 });
  const hashFile = (file) => {
    if (!relativeFile(file)) throw Error("QUALITY_TEST_TIMING_INVALID");
    return digest(readFileSync(resolve(root, file)));
  };
  return {
    schemaVersion: 2,
    source: {
      kind: "measured-reference-only",
      acceptance: "not-acceptance",
      runId: plan.binding.runId == null ? null : Number(plan.binding.runId),
      runAttempt: plan.binding.runAttempt == null ? null : Number(plan.binding.runAttempt),
      platform: plan.binding.platform,
      node: plan.binding.node,
      core: plan.binding.manifest.core,
      fileConcurrency: plan.concurrency,
      planSha256: plan.planSha256,
      buildSha256: first.buildSha256,
      head:
        plan.binding.manifest.repositories?.find((entry) => entry.repo === "dsh-gea-plugin")
          ?.head ?? null,
      executions: receipts.map((entry) => ({
        executionId: entry.executionId,
        sha256: executionDigest(entry),
      })),
    },
    inputs: Object.fromEntries(inputs.map((file) => [file, hashFile(file)])),
    fixtures: {},
    files: receipt.results
      .flatMap((result) => result.report.files)
      .map((file) => ({
        file: file.file,
        durationMs: file.durationMs,
        sha256: hashFile(file.file),
        fixtures: [],
      })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      execution: { type: "string", multiple: true },
      output: { type: "string" },
    },
  });
  if (!values.plan || !values.execution?.length || !values.output)
    throw Error("QUALITY_TEST_TIMING_INPUT_REQUIRED");
  const plan = JSON.parse(readFileSync(values.plan));
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (
    plan.binding.manifest.repositories.find((entry) => entry.repo === "dsh-gea-plugin")?.head !==
      head ||
    execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        "src",
        "scripts",
        "tests",
        "desktop",
        "package.json",
        "pnpm-lock.yaml",
      ],
      { encoding: "utf8" },
    ).trim()
  )
    throw Error("QUALITY_TEST_TIMING_SOURCE_MISMATCH");
  const inputs = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "--",
      "src",
      "scripts",
      "desktop",
      "tests/fixtures",
      "tests/profile.mjs",
      "package.json",
      "pnpm-lock.yaml",
    ],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => relativeFile(file) && file !== "scripts/quality-test-timings.json");
  const timings = timingsFromExecution({
    plan,
    receipts: values.execution.map((file) => JSON.parse(readFileSync(file))),
    root: process.cwd(),
    inputs,
  });
  writeFileSync(values.output, JSON.stringify(timings, null, 2) + "\n");
}

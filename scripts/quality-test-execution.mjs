/** Job-local plans and execution receipts for the admitted required-and-affected selection. */
import { createHash, randomUUID } from "node:crypto";
import {
  writeFileSync,
  readFileSync,
  renameSync,
  realpathSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { availableParallelism, totalmem } from "node:os";

export const executionDigest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function requireConcurrency(concurrency) {
  if (concurrency !== 2 && concurrency !== 3 && concurrency !== 4)
    throw Error("QUALITY_TEST_CONCURRENCY_REQUIRED");
}

export function verifyExecutionCapacity({ concurrency, resources }) {
  requireConcurrency(concurrency);
  if (concurrency === 2) return { status: "not-required", concurrency };
  const observed = resources ?? {
    availableParallelism: availableParallelism(),
    totalMemoryBytes: totalmem(),
  };
  const required = { availableParallelism: 4, totalMemoryBytes: 12884901888 };
  if (
    !Number.isSafeInteger(observed.availableParallelism) ||
    observed.availableParallelism < required.availableParallelism ||
    !Number.isSafeInteger(observed.totalMemoryBytes) ||
    observed.totalMemoryBytes < required.totalMemoryBytes
  )
    throw Object.assign(Error("QUALITY_TEST_CAPACITY_REQUIRED"), {
      code: "QUALITY_TEST_CAPACITY_REQUIRED",
      required,
      observed: {
        availableParallelism: observed.availableParallelism ?? null,
        totalMemoryBytes: observed.totalMemoryBytes ?? null,
      },
    });
  return { status: "passed", concurrency, required, observed };
}

export function executionFile(root, file) {
  const name = relative(realpathSync(root), realpathSync(resolve(root, file)));
  if (!name || name === ".." || name.startsWith(".." + sep) || isAbsolute(name))
    throw Error("QUALITY_TEST_FILE_OUTSIDE_ROOT: " + file);
  return name.split(sep).join("/");
}

export function writeExecutionReceipt(file, value) {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  renameSync(file + ".tmp", file);
}

export function createExecutionPlan({
  selection,
  platformPlan,
  binding,
  timings,
  shardCount = 1,
  concurrency = 2,
}) {
  requireConcurrency(concurrency);
  if (!Number.isSafeInteger(shardCount) || shardCount < 1)
    throw Error("QUALITY_TEST_SHARDS_REQUIRED");
  const files = [...platformPlan.files];
  const measured = new Map();
  if (timings) {
    if (!timings.source || !Array.isArray(timings.files))
      throw Error("QUALITY_TEST_TIMINGS_REQUIRED");
    for (const entry of timings.files) {
      if (measured.has(entry.file) || !Number.isFinite(entry.durationMs) || entry.durationMs < 0)
        throw Error("QUALITY_TEST_TIMING_INVALID");
      measured.set(entry.file, entry.durationMs);
    }
  }
  const known = files.filter((file) => measured.has(file));
  const maximum = Math.max(0, ...known.map((file) => measured.get(file)));
  const filenameCost = (assigned) => {
    const slots = Array(concurrency).fill(0);
    for (const file of [...assigned].sort()) {
      const slot = slots.indexOf(Math.min(...slots));
      // Unknowns have only a conservative sorting weight; estimates remain null.
      slots[slot] += measured.get(file) ?? (maximum || 1);
    }
    return Math.max(...slots);
  };
  const groups = Array.from({ length: Math.min(shardCount, files.length) }, (_, index) => ({
    id: String(index + 1),
    files: [],
  }));
  for (const file of [...files].sort(
    (left, right) =>
      Number(measured.has(left)) - Number(measured.has(right)) ||
      (measured.get(right) ?? 0) - (measured.get(left) ?? 0) ||
      left.localeCompare(right),
  )) {
    const group =
      groups.find((entry) => !entry.files.length) ??
      [...groups].sort(
        (left, right) =>
          filenameCost([...left.files, file]) - filenameCost([...right.files, file]) ||
          Number(left.id) - Number(right.id),
      )[0];
    group.files.push(file);
  }
  const shards = groups.map((group) => ({
    ...group,
    runtimeFiles: group.files.filter((file) => selection.runtimeFiles?.includes(file)),
    estimatedMs: group.files.every((file) => measured.has(file)) ? filenameCost(group.files) : null,
  }));
  const plan = {
    schemaVersion: 1,
    binding,
    selectionSha256: executionDigest(selection),
    selected: [...selection.files],
    files,
    required: [...(selection.required ?? [])],
    platformTasks: platformPlan.platformTasks ?? [],
    concurrency,
    timingSource: timings ? { ...timings.source, sha256: executionDigest(timings) } : null,
    estimates: {
      selectedFiles: selection.files.length,
      requiredFiles: (selection.required ?? []).length,
      profileFiles: (selection.runtimeFiles ?? []).length,
      knownFiles: known.length,
      unknownFiles: files.length - known.length,
      knownSumMs: known.reduce((sum, file) => sum + measured.get(file), 0),
      estimatedMs:
        files.length === known.length
          ? Math.max(0, ...shards.map((shard) => shard.estimatedMs))
          : null,
    },
    shards,
  };
  return { ...plan, planSha256: executionDigest(plan) };
}

function requireExecution(condition, detail) {
  if (!condition) throw Error("QUALITY_TEST_EXECUTION_REJECTED: " + detail);
}
function sameFiles(actual, expected) {
  return (
    Array.isArray(actual) &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}
export function verifyExecutionPlan(plan) {
  requireConcurrency(plan.concurrency);
  const { planSha256, ...contents } = plan;
  requireExecution(
    plan.schemaVersion === 1 && executionDigest(contents) === planSha256,
    "plan hash",
  );
  requireExecution(
    sameFiles(
      plan.shards.flatMap((shard) => shard.files),
      plan.files,
    ),
    "assigned files",
  );
  requireExecution(
    new Set(plan.shards.map((shard) => shard.id)).size === plan.shards.length,
    "duplicate shard",
  );
  requireExecution(
    plan.shards.every((shard) => shard.files.length > 0 && /^\d+$/.test(shard.id)),
    "empty or invalid shard",
  );
  const delegated = plan.platformTasks.flatMap((task) => task.files);
  requireExecution(
    plan.selected.every((file) => plan.files.includes(file) || delegated.includes(file)) &&
      plan.files.every((file) => plan.selected.includes(file)),
    "selection coverage",
  );
}
const contextFor = (plan, shardId, buildSha256, executionId) => ({
  planSha256: plan.planSha256,
  shardId,
  buildSha256,
  executionId,
});
function libuvPoolDeclaration(plan, shard, capacity) {
  if (plan.concurrency !== 3) return undefined;
  requireExecution(
    capacity?.status === "passed" && capacity.concurrency === 3 && capacity.observed,
    "libuv capacity declaration",
  );
  const { observed } = verifyExecutionCapacity({ concurrency: 3, resources: capacity.observed });
  const activeFiles = Math.min(plan.concurrency, shard.files.length);
  return {
    status: "declared",
    size: Math.min(4, Math.max(1, Math.floor(observed.availableParallelism / activeFiles))),
    activeFiles,
    availableParallelism: observed.availableParallelism,
    source: "capacity.observed.availableParallelism",
  };
}
const validCounts = (counts) =>
  counts &&
  ["tests", "passed", "failed", "cancelled", "skipped", "todo"].every(
    (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
  ) &&
  counts.tests === counts.passed &&
  ["failed", "cancelled", "skipped", "todo"].every((key) => counts[key] === 0);

function verifyShardResult(plan, shard, result, buildSha256) {
  const libuvPool = libuvPoolDeclaration(plan, shard, result.capacity);
  if (libuvPool)
    requireExecution(
      result.libuvPool && executionDigest(result.libuvPool) === executionDigest(libuvPool),
      "libuv pool declaration",
    );
  requireExecution(
    typeof result.executionId === "string" && result.executionId.length > 0,
    "child execution identity",
  );
  const report = result.report;
  requireExecution(
    result.exitCode === 0 && result.signal === null && !result.error,
    "child exit " + shard.id,
  );
  requireExecution(
    report?.schemaVersion === 1 &&
      report.terminal === true &&
      report.status === "completed" &&
      executionDigest(report.context) ===
        executionDigest(contextFor(plan, shard.id, buildSha256, result.executionId)),
    "report input or terminal state",
  );
  requireExecution(
    Number.isFinite(report.durationMs) &&
      report.durationMs >= 0 &&
      Number.isFinite(Date.parse(report.startedAt)) &&
      Number.isFinite(Date.parse(report.finishedAt)) &&
      Date.parse(report.finishedAt) >= Date.parse(report.startedAt),
    "report timing",
  );
  requireExecution(
    report.summary?.success === true && validCounts(report.summary.counts),
    "run case outcomes",
  );
  requireExecution(
    sameFiles(
      report.files?.map((file) => file.file),
      shard.files,
    ),
    "file coverage",
  );
  for (const file of report.files) {
    requireExecution(
      file.startCount === 1 && file.completeCount === 1 && file.summaryCount === 1,
      "file execution count " + file.file,
    );
    requireExecution(
      file.passed === true && file.success === true && validCounts(file.counts),
      "file case outcomes " + file.file,
    );
    requireExecution(
      Number.isFinite(file.durationMs) &&
        file.durationMs >= 0 &&
        Number.isFinite(Date.parse(file.startedAt)) &&
        Number.isFinite(Date.parse(file.finishedAt)) &&
        Date.parse(file.finishedAt) >= Date.parse(file.startedAt),
      "file timing " + file.file,
    );
  }
  requireExecution(
    report.files.reduce((sum, file) => sum + file.counts.tests, 0) === report.summary.counts.tests,
    "case total",
  );
}

export function verifyExecutionResults({ plan, receipt, buildSha256 }) {
  verifyExecutionPlan(plan);
  requireExecution(
    receipt.schemaVersion === 1 &&
      receipt.terminal === true &&
      ["completed", "passed"].includes(receipt.status) &&
      !receipt.error &&
      typeof receipt.executionId === "string" &&
      receipt.executionId.length > 0 &&
      receipt.planSha256 === plan.planSha256 &&
      receipt.buildSha256 === buildSha256,
    "receipt input or terminal state",
  );
  requireExecution(
    sameFiles(
      receipt.results?.map((result) => result.shardId),
      plan.shards.map((shard) => shard.id),
    ),
    "shard coverage",
  );
  for (const shard of plan.shards) {
    const result = receipt.results.find((entry) => entry.shardId === shard.id);
    verifyShardResult(plan, shard, result, buildSha256);
  }
  return {
    status: "passed",
    planSha256: plan.planSha256,
    files: plan.files.length,
    shards: plan.shards.length,
    execution: plan.files.length ? "observed" : "not-applicable",
  };
}

export function runExecutionPlan({
  plan,
  root,
  resultFile,
  reporter,
  buildSha256,
  shardId,
  environment = {},
  nodeArgs = [],
  verifyUnchanged = () => {},
}) {
  verifyExecutionPlan(plan);
  const assigned =
    shardId === undefined ? plan.shards : plan.shards.filter((shard) => shard.id === shardId);
  requireExecution(shardId === undefined || assigned.length === 1, "unknown or empty shard");
  const capacity = verifyExecutionCapacity({ concurrency: plan.concurrency });
  mkdirSync(dirname(resultFile), { recursive: true });
  const receipt = {
    schemaVersion: 1,
    executionId: randomUUID(),
    scope: shardId === undefined ? "platform" : "shard",
    status: "running",
    terminal: false,
    planSha256: plan.planSha256,
    buildSha256,
    capacity,
    results: [],
  };
  const persist = () => writeExecutionReceipt(resultFile, receipt);
  persist();
  try {
    for (const shard of assigned) {
      for (const file of shard.files)
        requireExecution(
          executionFile(root, file) === file && statSync(resolve(root, file)).isFile(),
          "file path " + file,
        );
      verifyUnchanged();
      const libuvPool = libuvPoolDeclaration(plan, shard, capacity);
      const reportFile = resolve(
        dirname(resultFile),
        "quality-test-results",
        receipt.executionId,
        shard.id + ".json",
      );
      mkdirSync(dirname(reportFile), { recursive: true });
      const result = spawnSync(
        process.execPath,
        [
          ...nodeArgs,
          "--test",
          `--test-concurrency=${plan.concurrency}`,
          `--test-reporter=${reporter}`,
          ...shard.files,
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: {
            ...process.env,
            ...environment,
            ...(libuvPool ? { UV_THREADPOOL_SIZE: String(libuvPool.size) } : {}),
            QUALITY_TEST_ROOT: root,
            QUALITY_TEST_FILES: JSON.stringify(shard.files),
            QUALITY_TEST_RECEIPT: reportFile,
            QUALITY_TEST_CONTEXT: JSON.stringify(
              contextFor(plan, shard.id, buildSha256, receipt.executionId),
            ),
          },
        },
      );
      let report;
      try {
        report = JSON.parse(readFileSync(reportFile));
      } catch {
        /* Missing/partial reporter output remains evidence of an incomplete child. */
      }
      receipt.results.push({
        shardId: shard.id,
        executionId: receipt.executionId,
        exitCode: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
        report,
        ...(libuvPool ? { capacity, libuvPool } : {}),
      });
      persist();
      verifyUnchanged();
    }
    receipt.terminal = true;
    receipt.status = "completed";
    let verified;
    if (shardId === undefined) verified = verifyExecutionResults({ plan, receipt, buildSha256 });
    else {
      verifyShardResult(plan, assigned[0], receipt.results[0], buildSha256);
      verified = {
        status: "passed",
        planSha256: plan.planSha256,
        files: assigned[0].files.length,
        shards: 1,
        execution: "observed",
      };
    }
    receipt.status = "passed";
    persist();
    return { ...verified, receipt };
  } catch (error) {
    Object.assign(receipt, { status: "failed", terminal: true, error: error.message });
    persist();
    throw error;
  }
}

import { readHostedRun, verifyHostedSnapshot } from "./quality-hosted-run.mjs";
export { readHostedRun, verifyHostedSnapshot } from "./quality-hosted-run.mjs";
const budgetMs = 600000;
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

export const skippedTestShardsJobName =
  "matrix.core && format('test-{0}-{1}', matrix.core, matrix.shard) || 'test-shards'";

export const unexpandedSkippedJobNames = [
  "prepare-${{ matrix.core }}",
  "macos-${{ matrix.core }}",
  skippedTestShardsJobName,
];

export async function waitForHostedRun({ intervalMs = 30000, timeoutMs = 1800000, ...input }) {
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  )
    throw Error("HOSTED_WAIT_INPUT_REQUIRED");
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const snapshot = await readHostedRun(input);
    if (["completed", "waiting", "action_required"].includes(snapshot.run.status)) return snapshot;
    if (!["queued", "in_progress", "pending", "requested"].includes(snapshot.run.status))
      throw Error("HOSTED_RUN_STATUS_REQUIRED");
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Error("HOSTED_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    if (performance.now() >= deadline) throw Error("HOSTED_WAIT_TIMEOUT");
  }
}

export function assessSourceRetry(history) {
  if (!Array.isArray(history) || !history.length) throw Error("SOURCE_RETRY_HISTORY_REQUIRED");
  const current = history.at(-1);
  for (const [index, snapshot] of history.entries()) {
    verifyHostedSnapshot(snapshot);
    if (
      snapshot.jobFilter ||
      snapshot.expected.runAttempt !== index + 1 ||
      history.length !== current.expected.runAttempt ||
      (index < history.length - 1 && snapshot.run.status !== "completed")
    )
      throw Error("SOURCE_RETRY_REJECTED: complete attempt history required");
    if (
      ["repository", "runId", "headSha"].some(
        (key) => snapshot.expected[key] !== current.expected[key],
      )
    )
      throw Error("SOURCE_RETRY_REJECTED: history identity");
  }
  if (current.run.status !== "completed") return { action: "wait", reason: "run-not-completed" };
  if (current.run.conclusion === "success") return { action: "complete", reason: "run-succeeded" };
  const failures = (snapshot) =>
    snapshot.jobs
      .filter(
        (job) =>
          ["failure", "timed_out"].includes(job.conclusion) && job.name !== "candidate-quality",
      )
      .map((job) => ({
        name: job.name,
        step:
          job.steps?.find((step) => ["failure", "timed_out"].includes(step.conclusion))?.name ??
          null,
      }));
  const latest = failures(current);
  const family = (failure) => failure.name.replace(/ \(\d+\)$/, "") + ":" + failure.step;
  const earlier = new Set(history.slice(0, -1).flatMap(failures).map(family));
  const repeated = latest.some((failure) => earlier.has(family(failure)));
  const preparation = latest.some(
    (failure) =>
      !failure.step || /prepare|restore|download|polic|install|checkout/i.test(failure.step),
  );
  let reason = "failure-evidence-incomplete";
  if (repeated) reason = "same-failure-stage-repeated";
  else if (preparation) reason = "preparation-needs-diagnosis";
  else if (latest.length) reason = "first-behavior-failure";
  return {
    action: reason === "first-behavior-failure" ? "retry-failed-only" : "diagnose",
    repeated,
    reason,
    jobs: latest.map((failure) => failure.name),
    failures: latest,
    wholeRunRetry: "blocked",
  };
}

export function assessSourceBudget(snapshot, options = {}) {
  const jobs = snapshot?.jobs ?? [];
  const sourceJobs = jobs.some((job) => /^source-checks \([12]\)$/.test(job.name))
    ? ["source-checks (1)", "source-checks (2)"]
    : ["source-checks"];
  const skipped = jobs.filter((job) => job.conclusion === "skipped").map((job) => job.name);
  const result = assessHostedBudget({
    snapshot,
    requiredJobs: [
      ...new Set([
        "source-plan",
        ...sourceJobs,
        ...jobs.filter((job) => job.name !== "candidate-quality").map((job) => job.name),
      ]),
    ].filter((name) => !skipped.includes(name) || name === "source-plan"),
    notApplicableJobs: skipped.filter((name) => name !== "source-plan"),
    finalJobName: "candidate-quality",
    ...options,
  });
  if (result.mode === "in-gate" && options.admission !== "success") {
    result.functional.status = options.admission ? "failed" : "unknown";
    result.functional.reasons.push("SOURCE_ADMISSION_NOT_PASSED");
    result.passed = false;
  }
  return result;
}

export function assessFinalDependencies({
  snapshot,
  requiredJobs,
  notApplicableJobs = [],
  finalJobName,
  needs,
  applicability,
  hasShards,
  dependencyReview,
}) {
  verifyHostedSnapshot(snapshot);
  if (
    !["source", "docs"].includes(applicability) ||
    typeof hasShards !== "boolean" ||
    typeof dependencyReview !== "boolean" ||
    (applicability === "docs" && (hasShards || dependencyReview))
  )
    throw Error("QUALITY_FINAL_DEPENDENCIES_INPUT_REQUIRED");
  const source = applicability === "source";
  const expected = {
    "candidate-scope": "success",
    "source-plan": "success",
    gates: source ? "success" : "skipped",
    "plan-test-shards": source ? "success" : "skipped",
    "test-shards": hasShards ? "success" : "skipped",
    "macos-isolation": source ? "success" : "skipped",
    "windows-plugin-update": "success",
    "dependency-review": dependencyReview ? "success" : "skipped",
  };
  const reasons = [];
  if (
    !needs ||
    typeof needs !== "object" ||
    Array.isArray(needs) ||
    Object.keys(needs).sort().join(",") !== Object.keys(expected).sort().join(",")
  )
    reasons.push("QUALITY_FINAL_DEPENDENCIES_REQUIRED");
  const dependencies = Object.entries(expected).map(([job, result]) => {
    const actual = needs?.[job]?.result;
    if (actual !== result) reasons.push("QUALITY_FINAL_DEPENDENCY_RESULT: " + job);
    return { job, expected: result, actual: actual ?? null };
  });
  if (needs?.["source-plan"]?.outputs?.applicability !== applicability)
    reasons.push("QUALITY_FINAL_APPLICABILITY_MISMATCH");
  const observed = assessHostedBudget({
    snapshot,
    requiredJobs,
    notApplicableJobs,
    finalJobName,
    mode: "in-gate",
  });
  const pending = (entry) =>
    ["queued", "pending", "requested", "in_progress"].includes(entry?.status) &&
    entry.conclusion === null;
  const deferred = [];
  for (const reason of observed.functional.reasons) {
    const upstream = requiredJobs.find((name) => reason === "HOSTED_REQUIRED_JOB: " + name);
    const matches = snapshot.jobs.filter((job) => job.name === (upstream ?? finalJobName));
    const lagging = upstream
      ? matches.length === 1 && pending(matches[0])
      : reason === "HOSTED_FINAL_STATE: " + finalJobName &&
        pending(snapshot.run) &&
        matches.length === 1 &&
        pending(matches[0]);
    (lagging ? deferred : reasons).push(reason);
  }
  for (const job of snapshot.jobs) {
    if (
      Array.isArray(job.steps) &&
      job.steps.some(
        (step) => step.conclusion != null && !["success", "skipped"].includes(step.conclusion),
      )
    )
      reasons.push("HOSTED_STEP_CONCLUSION: " + job.name);
    if (
      job.conclusion !== null &&
      !(
        job.status === "completed" &&
        (job.conclusion === "success" ||
          (job.conclusion === "skipped" && notApplicableJobs.includes(job.name)))
      )
    )
      reasons.push("HOSTED_JOB_CONCLUSION: " + job.name);
  }
  return {
    schemaVersion: 1,
    identity: snapshot.expected,
    basis: "github-needs-with-validated-rest-snapshot",
    scope: "scheduler-dependencies",
    applicability,
    status: reasons.length ? "failed" : "passed",
    dependencies,
    reasons: [...new Set(reasons)],
    observerPending: deferred,
  };
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour < 24 &&
    minute < 60 &&
    second < 60
    ? parsed
    : null;
}
export function assessHostedBudget({
  snapshot,
  requiredJobs,
  notApplicableJobs = [],
  finalJobName,
  mode = "completed",
  now = new Date().toISOString(),
  gateDecision,
}) {
  if (
    !["in-gate", "completed"].includes(mode) ||
    !Array.isArray(requiredJobs) ||
    !requiredJobs.length ||
    new Set(requiredJobs).size !== requiredJobs.length ||
    requiredJobs.includes(finalJobName) ||
    !requiredJobs.every((name) => typeof name === "string" && name.length) ||
    !Array.isArray(notApplicableJobs) ||
    new Set(notApplicableJobs).size !== notApplicableJobs.length ||
    notApplicableJobs.some(
      (name) =>
        (!/^(?:test-shards|plan-test-shards|gates|macos-isolation|Dependency review|dependency-review|dependency-policy|source-checks(?: \((?:[1-9]|1[0-9]|20)\))?|(?:prepare|macos)-(?:[a-f0-9]{40})?)$/.test(
          name,
        ) &&
          !unexpandedSkippedJobNames.includes(name)) ||
        requiredJobs.includes(name),
    ) ||
    !finalJobName
  )
    throw Error("HOSTED_BUDGET_INPUT_REQUIRED");
  try {
    verifyHostedSnapshot(snapshot);
  } catch (error) {
    return {
      schemaVersion: 1,
      mode,
      observedAt: now,
      identity: snapshot?.expected ?? null,
      completedMeasurement: false,
      gateDecision: null,
      functional: { status: "unknown", scope: "unverified-run-attempt", reasons: [error.message] },
      performance: {
        status: "unknown",
        budgetMs,
        reasons: [error.message],
        decisionAt: null,
        completionAt: null,
        completionSource: null,
        postGateMs: null,
        workflowToDecisionMs: null,
        triggerToDecisionMs: null,
        initialSchedulingWaitMs: null,
        triggerQueueMs: null,
        jobs: [],
      },
      passed: false,
    };
  }
  const { run, jobs } = snapshot;
  const final = jobs.filter((job) => job.name === finalJobName);
  const functionalReasons = [];
  for (const name of notApplicableJobs) {
    const found = jobs.filter((job) => job.name === name);
    if (
      found.length > 1 ||
      (found.length === 1 && (found[0].status !== "completed" || found[0].conclusion !== "skipped"))
    )
      functionalReasons.push("HOSTED_NOT_APPLICABLE_JOB: " + name);
  }
  for (const name of requiredJobs) {
    const found = jobs.filter((job) => job.name === name);
    if (found.length !== 1 || found[0].status !== "completed" || found[0].conclusion !== "success")
      functionalReasons.push("HOSTED_REQUIRED_JOB: " + name);
  }
  const finalMatches =
    final.length === 1 &&
    (mode === "in-gate"
      ? run.status === "in_progress" &&
        run.conclusion === null &&
        final[0].status === "in_progress" &&
        final[0].conclusion === null
      : run.status === "completed" &&
        run.conclusion === "success" &&
        final[0].status === "completed" &&
        final[0].conclusion === "success");
  if (!finalMatches) functionalReasons.push("HOSTED_FINAL_STATE: " + finalJobName);
  const reasons = [];
  const readTime = (value, label) => {
    const time = timestamp(value);
    if (time === null) reasons.push("HOSTED_TIME_REQUIRED: " + label);
    return time;
  };
  const order = (condition, label) => {
    if (!condition) reasons.push("HOSTED_TIME_ORDER: " + label);
  };
  const observed = readTime(now, "observation"),
    fetched = readTime(snapshot.observedAt, "REST observation");
  const started = readTime(run.run_started_at, "workflow start"),
    triggered = readTime(run.created_at, "trigger");
  const updated = readTime(run.updated_at, "run update");
  const decision = mode === "in-gate" ? observed : updated;
  order(triggered !== null && started !== null && triggered <= started, "trigger/workflow");
  order(started !== null && updated !== null && started <= updated, "workflow/update");
  order(updated !== null && observed !== null && updated <= observed, "run/observation");
  order(fetched !== null && observed !== null && fetched <= observed, "REST/observation");
  order(started !== null && decision !== null && started <= decision, "workflow/decision");
  if (mode === "completed" && run.status !== "completed") reasons.push("HOSTED_COMPLETION_PENDING");
  if (mode === "in-gate" && !finalMatches) reasons.push("HOSTED_CURRENT_FINAL_REQUIRED");
  const walls = jobs
    .filter(
      (job) =>
        !notApplicableJobs.includes(job.name) ||
        job.status !== "completed" ||
        job.conclusion !== "skipped",
    )
    .map((job) => {
      const start = readTime(job.started_at, "job " + job.id + " start");
      const currentFinal =
        mode === "in-gate" &&
        final.length === 1 &&
        job.id === final[0].id &&
        job.status === "in_progress";
      if (!currentFinal && job.status !== "completed")
        reasons.push("HOSTED_JOB_COMPLETION_REQUIRED: " + job.id);
      const end = currentFinal ? observed : readTime(job.completed_at, "job " + job.id + " finish");
      if (currentFinal && job.completed_at !== null)
        reasons.push("HOSTED_CURRENT_FINAL_COMPLETED_AT");
      const valid =
        start !== null &&
        end !== null &&
        started !== null &&
        decision !== null &&
        started <= start &&
        start <= end &&
        end <= decision;
      order(valid, "job " + job.id);
      return {
        id: job.id,
        name: job.name,
        status: job.status,
        startedAt: job.started_at,
        finishedAt: currentFinal ? null : job.completed_at,
        durationMs: valid ? end - start : null,
        measurement: currentFinal ? "running-to-decision" : "completed",
        start,
      };
    });
  const firstJob =
    jobs.length && walls.every((job) => job.start !== null)
      ? Math.min(...walls.map((job) => job.start))
      : null;
  if (firstJob === null) reasons.push("HOSTED_FIRST_JOB_REQUIRED");
  let postGateMs = null;
  if (gateDecision) {
    const previous = readTime(gateDecision.at, "previous gate decision");
    const same = ["repository", "runId", "runAttempt", "headSha"].every(
      (key) => gateDecision[key] === snapshot.expected[key],
    );
    const finalStart = final.length === 1 ? timestamp(final[0].started_at) : null;
    const valid =
      mode === "completed" &&
      same &&
      gateDecision.finalJobId === final[0]?.id &&
      previous !== null &&
      finalStart !== null &&
      decision !== null &&
      finalStart <= previous &&
      previous <= decision;
    if (!valid) reasons.push("HOSTED_PREVIOUS_GATE_MISMATCH");
    else postGateMs = decision - previous;
  }
  const completeClock = reasons.length === 0;
  const workflowToDecisionMs = completeClock ? decision - started : null;
  if (completeClock && workflowToDecisionMs > budgetMs) reasons.push("HOSTED_BUDGET_EXCEEDED");
  const performance = {
    status: completeClock ? (workflowToDecisionMs <= budgetMs ? "passed" : "failed") : "unknown",
    budgetMs,
    reasons,
    decisionAt: decision === null ? null : new Date(decision).toISOString(),
    completionAt: mode === "completed" && run.status === "completed" ? run.updated_at : null,
    completionSource:
      mode === "completed" ? "completed-run.updated_at-checked-against-all-jobs" : null,
    postGateMs,
    workflowToDecisionMs,
    triggerToDecisionMs: completeClock ? decision - triggered : null,
    initialSchedulingWaitMs: completeClock ? firstJob - started : null,
    triggerQueueMs: completeClock ? started - triggered : null,
    jobs: walls.map(({ start: _start, ...job }) => job),
  };
  const functional = {
    status: functionalReasons.length ? "failed" : "passed",
    reasons: functionalReasons,
    scope:
      mode === "in-gate" ? "required-upstream-and-current-final" : "completed-required-workflow",
  };
  return {
    schemaVersion: 1,
    mode,
    observedAt: now,
    identity: snapshot.expected,
    completedMeasurement: mode === "completed" && run.status === "completed" && completeClock,
    gateDecision:
      mode === "in-gate" && completeClock
        ? { ...snapshot.expected, finalJobId: final[0]?.id, at: now }
        : (gateDecision ?? null),
    functional,
    performance,
    passed: functional.status === "passed" && performance.status === "passed",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      "source-report": { type: "string" },
      snapshot: { type: "string" },
      "retry-plan": { type: "boolean" },
      "request-retry": { type: "string" },
      "retry-history": { type: "string" },
      "source-checks": { type: "string" },
      mode: { type: "string", default: "in-gate" },
    },
  });
  if (!values["source-report"]) throw Error("SOURCE_BUDGET_OUTPUT_REQUIRED");
  if (values["request-retry"]) {
    if (values["request-retry"] !== "failed")
      throw Error(
        "SOURCE_RETRY_FAILED_ONLY: whole-run retries require diagnosis and a changed verification plan",
      );
    values["retry-plan"] = true;
  }
  const { summarizeSourceChecks, sourceReportMarkdown } =
    await import("./source-check-summary.mjs");
  let result;
  try {
    const snapshot = values.snapshot
      ? JSON.parse(readFileSync(values.snapshot, "utf8"))
      : await readHostedRun({
          repository: process.env.GITHUB_REPOSITORY,
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          headSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          token: process.env.GITHUB_TOKEN,
        });
    if (values["retry-plan"]) {
      const history = values["retry-history"]
        ? JSON.parse(readFileSync(values["retry-history"], "utf8"))
        : [];
      if (!values["retry-history"] && values.snapshot && snapshot.expected.runAttempt !== 1)
        throw Error(
          "SOURCE_RETRY_HISTORY_REQUIRED: --retry-history <complete attempt snapshots.json>",
        );
      if (!values["retry-history"] && !values.snapshot)
        for (let attempt = 1; attempt < snapshot.expected.runAttempt; attempt++)
          history.push(
            await readHostedRun({
              repository: snapshot.expected.repository,
              runId: snapshot.expected.runId,
              runAttempt: attempt,
              headSha: snapshot.expected.headSha,
              token: process.env.GITHUB_TOKEN,
            }),
          );
      if (values["retry-history"]) {
        if (JSON.stringify(history.at(-1)?.expected) !== JSON.stringify(snapshot.expected))
          throw Error(
            "SOURCE_RETRY_REJECTED: history does not end at the observed run/attempt/head",
          );
        history[history.length - 1] = snapshot;
      } else history.push(snapshot);
      result = { recovery: assessSourceRetry(history) };
    }
    result = {
      ...result,
      ...assessSourceBudget(snapshot, {
        mode: values.mode,
        admission: process.env.SOURCE_ADMISSION_RESULT,
      }),
    };
  } catch (error) {
    result = {
      schemaVersion: 1,
      mode: values.mode,
      completedMeasurement: false,
      functional: { status: "unknown" },
      performance: { status: "unknown", budgetMs, reasons: [error.message] },
      passed: false,
      ...(values["retry-plan"]
        ? { recovery: { action: "diagnose", reason: error.message, wholeRunRetry: "blocked" } }
        : {}),
    };
  }
  if (values["source-checks"]) {
    try {
      result.coverage = summarizeSourceChecks(values["source-checks"], {
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        runId: result.identity?.runId ?? process.env.GITHUB_RUN_ID,
        runAttempt: result.identity?.runAttempt ?? process.env.GITHUB_RUN_ATTEMPT,
        producers: values.snapshot
          ? undefined
          : await readHostedRun({
              repository: process.env.GITHUB_REPOSITORY,
              runId: process.env.GITHUB_RUN_ID,
              runAttempt: process.env.GITHUB_RUN_ATTEMPT,
              headSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
              token: process.env.GITHUB_TOKEN,
              jobFilter: "latest",
            }),
      });
    } catch (error) {
      result.coverage = { status: "unknown", error: error.message };
    }
  }
  writeFileSync(values["source-report"], JSON.stringify(result, null, 2) + "\n");
  if (values["request-retry"] && result.recovery?.action !== "retry-failed-only")
    process.exitCode = 1;
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, sourceReportMarkdown(result));
}

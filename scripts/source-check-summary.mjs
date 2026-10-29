import { existsSync, globSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { aggregateSourceCheckShards, sourceCheckMatrix } from "./source-check-shards.mjs";
import { selectPlatformTests } from "./ci-platform-tests.mjs";
import { executionDigest, verifyExecutionResults } from "./quality-test-execution.mjs";

const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const same = (left, right) => executionDigest(left) === executionDigest(right);
const requireValue = (condition, detail) => {
  if (!condition) throw Error("SOURCE_SUMMARY_REJECTED: " + detail);
};
const runtimeFile = (worker, name) => {
  const paths = ["candidate/dsh-gea-plugin/.runtime", ".runtime", ""].map((prefix) =>
    join(worker, prefix, name),
  );
  const existing = paths.filter(existsSync);
  requireValue(existing.length <= 1, "ambiguous runtime artifact");
  return existing[0] ?? paths[0];
};

export function summarizeSourceChecks(
  directory,
  { head, runId, runAttempt, root = process.cwd() },
) {
  requireValue(/^[a-f0-9]{40}$/.test(head ?? "") && runId && runAttempt, "expected source run");
  const flat = existsSync(runtimeFile(directory, "source-checks-plan.json"));
  const workerRoot = (name) => (flat ? directory : join(directory, name));
  const names = flat
    ? ["source-checks-single"]
    : existsSync(directory)
      ? readdirSync(directory).sort()
      : [];
  requireValue(
    names.length > 0 && names.every((name) => /^source-checks-(?:single|[1-9]\d*)$/.test(name)),
    "worker inventory",
  );
  const selection = json(runtimeFile(workerRoot(names[0]), "source-checks-plan.json"));
  requireValue(selection.head === head && selection.repo === "dsh-gea-plugin", "selection head");
  const matrix = sourceCheckMatrix(selection);
  requireValue(
    same(names, matrix.shards.map((id) => "source-checks-" + id).sort()),
    "worker inventory",
  );
  const selected = [...selection.files].sort();
  const platformFiles = selectPlatformTests(selection, "linux").files.sort();
  const policy = json(join(root, "scripts/ci-test-policy.json"));
  const registered = [
    ...new Set(policy.tests.flatMap((pattern) => globSync(pattern, { cwd: root }))),
  ].sort();
  const workers = names.map((name) => {
    const worker = workerRoot(name);
    requireValue(
      same(json(runtimeFile(worker, "source-checks-plan.json")), selection),
      "selection drift",
    );
    const resultPath = runtimeFile(worker, "source-checks-result.json");
    const result = existsSync(resultPath) ? json(resultPath) : null;
    if (result)
      requireValue(
        result.schemaVersion === 1 &&
          result.head === head &&
          String(result.runId) === String(runId) &&
          String(result.runAttempt) === String(runAttempt) &&
          same(result.plan, selection),
        "worker result input",
      );
    const stages = existsSync(join(worker, "quality-stages.json"))
      ? json(join(worker, "quality-stages.json"))
      : null;
    return { name, worker, result, stages };
  });
  let verified = null;
  let verificationError = null;
  try {
    if (matrix.parallel)
      verified = aggregateSourceCheckShards(directory, { head, runId, runAttempt });
    else if (selection.joint) {
      const { worker, stages } = workers[0];
      const plan = json(join(worker, "quality-test-execution-plan.json"));
      requireValue(
        String(plan.binding.runId) === String(runId) &&
          String(plan.binding.runAttempt) === String(runAttempt) &&
          plan.binding.platform === "linux" &&
          plan.binding.manifest.repositories.find((entry) => entry.repo === "dsh-gea-plugin")
            ?.head === head &&
          same([...plan.selected].sort(), selected),
        "execution input",
      );
      requireValue(
        same(stages.binding.executionPlan, plan) &&
          ["prepare", "build", "checks", "tests"].every(
            (name) => stages.stages[name]?.status === "passed",
          ),
        "execution stages",
      );
      verified = verifyExecutionResults({
        plan,
        receipt: json(join(worker, "quality-test-execution.json")),
        buildSha256: executionDigest(stages.artifacts),
      });
    }
  } catch (error) {
    verificationError = error.message;
  }
  const files = verified
    ? workers.flatMap(({ worker }) =>
        json(join(worker, "quality-test-execution.json")).results.flatMap(
          (result) => result.report.files,
        ),
      )
    : [];
  const counts = verified
    ? Object.fromEntries(
        ["tests", "passed", "failed", "cancelled", "skipped", "todo"].map((key) => [
          key,
          files.reduce((total, file) => total + file.counts[key], 0),
        ]),
      )
    : null;
  const entryPassed = workers.every(({ result }) => result?.status === "passed");
  return {
    schemaVersion: 1,
    identity: { head, runId, runAttempt, base: selection.base, diffBase: selection.diffBase },
    scope: {
      mode: selection.mode,
      platform: "linux",
      fullSuite: selection.fullSuite,
      allRepositoryAndPlatforms: "not-established",
      registeredFiles: registered.length,
      selectedFiles: selected.length,
      selected,
      platformSelected: platformFiles,
      platformFiles: platformFiles.length,
      unselected: registered.filter((file) => !selected.includes(file)),
      selectedOutsidePool: selected.filter((file) => !registered.includes(file)),
      deferred: selected.filter((file) => !platformFiles.includes(file)),
      executedBy: selection.executedBy ?? {},
      selectedOwners: Object.fromEntries(
        Object.entries(policy.testOwners ?? {}).filter(([, owner]) =>
          platformFiles.includes(owner),
        ),
      ),
    },
    execution: {
      status: verified
        ? "verified"
        : verificationError
          ? "unverified"
          : entryPassed
            ? "entry-passed"
            : "not-observed",
      verifiedFiles: verified?.files ?? null,
      entryPassedFiles: entryPassed ? platformFiles.length : null,
      counts,
      verificationError,
      note: verified
        ? "Exact file and case receipts verified by the existing execution contract."
        : "Entry completion does not establish strict per-case counts or absence of skipped cases.",
    },
    workers: workers.map(({ name, result, stages }) => ({
      name: name === "source-checks-single" ? "source-checks" : name.replace(/-(\d+)$/, " ($1)"),
      entryStatus: result?.status ?? "not-observed",
      stages: stages?.stages
        ? Object.fromEntries(
            Object.entries(stages.stages).map(([name, stage]) => [
              name,
              {
                status: stage.status,
                startedAt: stage.startedAt,
                finishedAt: stage.finishedAt,
                durationMs: stage.durationMs,
              },
            ]),
          )
        : null,
    })),
    slowFiles: files
      .map((file) => ({ file: file.file, durationMs: file.durationMs }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10),
  };
}

export function sourceReportMarkdown(result) {
  const scope = result.coverage?.scope;
  const execution = result.coverage?.execution;
  const unknown = "unknown";
  const jobs = [...(result.performance.jobs ?? [])].sort(
    (a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1),
  );
  const lastWorker = jobs
    .filter((job) => /^source-checks(?: \(\d+\))?$/.test(job.name) && job.finishedAt)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt))[0];
  const stages = result.coverage?.workers?.find(
    (worker) => worker.name === lastWorker?.name,
  )?.stages;
  const stageText = stages
    ? `\nLast completed worker: ${lastWorker.name}.\n\n| Worker stage | Duration ms |\n| --- | ---: |\n${Object.entries(
        stages,
      )
        .map(([name, stage]) => `| ${name} | ${stage.durationMs ?? unknown} |`)
        .join(
          "\n",
        )}\n\nThese stages start inside the worker and exclude earlier workflow planning, checkout and installation.\n`
    : "";
  return (
    `## Source checks scope and timing\n\nFunctional: ${result.functional.status}. Measurement: ${result.mode}; completed workflow: ${result.completedMeasurement}.\n\n` +
    (scope
      ? `Scope: ${scope.mode}, ${scope.platform}; fullSuite: ${scope.fullSuite}. All-repository and cross-platform acceptance: ${scope.allRepositoryAndPlatforms}.\n\n| Coverage | Files |\n| --- | ---: |\n| Registered pool | ${scope.registeredFiles} |\n| Selected | ${scope.selectedFiles} |\n| Selected on this platform | ${scope.platformFiles} |\n| Deferred to other platforms | ${scope.deferred.length} |\n| Registered entries not directly selected | ${scope.unselected.length} |\n| Verified executed files | ${execution.verifiedFiles ?? unknown} |\n\nExecution: ${execution.status}. Cases: ${execution.counts?.tests ?? unknown}; failed: ${execution.counts?.failed ?? unknown}; skipped: ${execution.counts?.skipped ?? unknown}. ${execution.note} ${execution.verificationError ?? ""}\n\nRegistered entries may delegate cases to selected owners; owner mappings are retained in the JSON.\n\n`
      : `Coverage: unknown (${result.coverage?.error ?? "no engineering execution receipts"}).\n\n`) +
    `Workflow to ${result.completedMeasurement ? "completion" : "observation"}: ${result.performance.workflowToDecisionMs ?? unknown} ms. Trigger queue: ${result.performance.triggerQueueMs ?? unknown} ms. In-gate timing excludes subsequent upload and cleanup. The historical ${result.performance.budgetMs} ms reference is informational and does not change admission.\n\n| Longest jobs | Allocated duration ms | Measurement |\n| --- | ---: | --- |\n${jobs
      .slice(0, 5)
      .map((job) => `| ${job.name} | ${job.durationMs ?? unknown} | ${job.measurement} |`)
      .join(
        "\n",
      )}\n\nJob durations overlap and must not be summed as workflow elapsed time.${stageText}\n\nRaw scope, deferred and unselected files, worker stages and slow files are retained in source-budget.json.\n`
  );
}

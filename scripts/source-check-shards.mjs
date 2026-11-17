import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import {
  executionDigest,
  verifyExecutionResults,
  createExecutionPlan,
} from "./quality-test-execution.mjs";
import { selectPlatformTests } from "./ci-platform-tests.mjs";
import { currentTestTimings } from "./quality-test-timings.mjs";
import {
  readHostedRun,
  verifyHostedSnapshot,
  hostedProducerAttempt,
} from "./quality-hosted-run.mjs";

export const sourceCheckWorkerLimit = 40;
export const sourceCheckWorkerTarget = 40;
const shardIds = (count) => Array.from({ length: count }, (_, index) => String(index + 1));
const requireValue = (condition, detail) => {
  if (!condition) throw Error("SOURCE_CHECK_SHARDS_REJECTED: " + detail);
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const same = (left, right) => executionDigest(left) === executionDigest(right);

export function sourceCheckShard(environment = process.env) {
  const id = environment.GEA_SOURCE_CHECK_SHARD;
  if (id === undefined || id === "") return undefined;
  const count = Number(environment.GEA_SOURCE_CHECK_SHARD_COUNT);
  requireValue(
    Number.isSafeInteger(count) && count >= 2 && count <= sourceCheckWorkerLimit,
    "shard count",
  );
  requireValue(shardIds(count).includes(id), "shard id");
  return { id, count };
}

export function sourceCheckMatrix(plan) {
  requireValue(typeof plan?.joint === "boolean" && Array.isArray(plan.files), "source plan");
  const files = selectPlatformTests(plan, "linux").files;
  const runtime = files.filter((file) => plan.runtimeFiles?.includes(file)).length;
  const count = Math.min(
    sourceCheckWorkerLimit,
    sourceCheckWorkerTarget,
    files.length,
    Math.max(1, Math.ceil(runtime / 3), Math.ceil((files.length - runtime) / 40)),
  );
  const parallel = plan.joint && count > 1;
  return { parallel, shards: parallel ? shardIds(count) : ["single"] };
}

export function sourceCheckCost({ selection, root, environment, timings }) {
  return createExecutionPlan({
    selection,
    platformPlan: selectPlatformTests(selection, environment.platform),
    binding: { kind: "estimate-only", environment },
    shardCount: sourceCheckMatrix(selection).shards.length,
    concurrency: environment.fileConcurrency,
    timings: timings ? currentTestTimings({ timings, root, environment }) : undefined,
  });
}

export function sourceSelectionMarkdown(selection, workers) {
  const unknown = "unknown";
  const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
  const reasons = selection?.reasons;
  const changes = new Map(
    (selection?.changes ?? []).map((change) => [`${change.repo}/${change.file}`, change]),
  );
  const triggers = [...new Set([...changes.keys(), ...Object.keys(reasons ?? {})])]
    .map((change) => {
      const details = selection?.reasonDetails?.[change];
      return {
        change,
        files: Array.isArray(reasons?.[change]) ? [...new Set(reasons[change])] : null,
        relation: !Array.isArray(reasons?.[change])
          ? "unknown"
          : changes.get(change)?.versionOnly
            ? "version contract"
            : changes.get(change)?.companionPeerOnly
              ? "companion peer compatibility contract"
              : details
                ? `rules: ${details.rules.join(", ") || "none"}; rule files: ${details.rule}; direct consumers: ${details.direct}; transitive consumers: ${details.transitive}`
                : unknown,
      };
    })
    .sort(
      (a, b) =>
        (b.files?.length ?? -1) - (a.files?.length ?? -1) || a.change.localeCompare(b.change),
    );
  const profile = selection?.runtimeFiles;
  return (
    `### Selection triggers and preparation\n\nProfile files: ${profile?.length ?? unknown}; workers: ${workers ?? unknown}; required files: ${selection?.required?.length ?? unknown}. Profile files transitively import tests/profile.mjs. File counts cover all selected platforms; workers run the Linux selection.\n\n` +
    `Types: ${selection?.typecheck ?? unknown}; dependencies: ${selection?.dependencies ?? unknown}; SDK: ${selection?.sdk ?? unknown}; browser: ${selection?.browser ?? unknown}; upstreams: ${selection?.upstreams ?? unknown}. These are planned requirements; preparation completion is reported separately.\n\n` +
    (triggers.length
      ? `| Changed file (largest trigger first) | Triggered files | Profile files | Selection relation | Main test consumers (up to 3) |\n| --- | ---: | ---: | --- | --- |\n${triggers
          .map(
            ({ change, files, relation }) =>
              `| ${cell(change)} | ${files?.length ?? unknown} | ${files && profile ? files.filter((file) => profile.includes(file)).length : unknown} | ${cell(relation)} | ${files ? cell(files.slice(0, 3).join(", ") || "none") + (files.length > 3 ? `; +${files.length - 3} more` : "") : unknown} |`,
          )
          .join("\n")}\n\n`
      : `Change triggers: ${reasons ? "none recorded" : unknown}.\n\n`) +
    `Triggered file counts reuse plan.reasons. Source counts reuse plan.reasonDetails. Trigger sets may overlap and must not be added to obtain total selection. Required files are included independently. Source categories may overlap after owner deduplication; their counts must not be added. Individual dependency paths are not recorded; older plans without source metadata report unknown. Test file counts do not represent total cost; preparation, builds, scheduling and finalization have separate costs.\n\n`
  );
}

export function aggregateSourceCheckShards(directory, { head, runId, runAttempt, producers }) {
  if (producers) {
    verifyHostedSnapshot(producers);
    requireValue(
      producers.jobFilter === "latest" &&
        producers.expected.runId === Number(runId) &&
        producers.expected.runAttempt === Number(runAttempt) &&
        producers.expected.headSha === head,
      "producer source run",
    );
  }
  requireValue(/^[a-f0-9]{40}$/.test(head ?? "") && runId && runAttempt, "expected source run");
  const firstScope = json(join(directory, "source-checks-1", "source-checks-scope.json"));
  const expectedIds = sourceCheckMatrix(firstScope.plan).shards;
  const names = expectedIds.map((id) => "source-checks-" + id);
  requireValue(same(readdirSync(directory).sort(), [...names].sort()), "worker inventory");
  const workers = names.map((name, index) => {
    const root = join(directory, name);
    const scope = json(join(root, "source-checks-scope.json"));
    requireValue(
      scope.schemaVersion === 1 &&
        scope.head === head &&
        String(scope.runId) === String(runId) &&
        (String(scope.runAttempt) === String(runAttempt) ||
          (producers &&
            /^[1-9]\d*$/.test(String(scope.runAttempt)) &&
            Number(scope.runAttempt) < Number(runAttempt))) &&
        typeof scope.plan?.joint === "boolean" &&
        Array.isArray(scope.plan.files) &&
        scope.shard.id === expectedIds[index] &&
        scope.shard.count === expectedIds.length,
      `worker source or assignment; shard=${expectedIds[index]} expectedAttempt=${runAttempt} observedAttempt=${scope.runAttempt} expectedRun=${runId} observedRun=${scope.runId} expectedHead=${head} observedHead=${scope.head} observedAssignment=${JSON.stringify(scope.shard)}`,
    );
    if (producers) {
      const jobs = producers.jobs.filter(
        (job) => job.name === `source-checks (${expectedIds[index]})`,
      );
      let observedProducerAttempt;
      try {
        requireValue(
          jobs.length === 1 &&
            jobs[0].status === "completed" &&
            jobs[0].conclusion === "success" &&
            (observedProducerAttempt = hostedProducerAttempt(producers, jobs[0].name)) ===
              Number(scope.runAttempt),
          "latest successful worker producer",
        );
      } catch (error) {
        const observedJobs = jobs.map((job) => ({
          id: job.id,
          name: job.name,
          attempt: job.run_attempt,
          status: job.status,
          conclusion: job.conclusion,
        }));
        throw Error(
          `${error.message}; shard=${expectedIds[index]} expectedAttempt=${scope.runAttempt} latestMatches=${jobs.length} observedProducerAttempt=${observedProducerAttempt ?? "unknown"} observedJobs=${JSON.stringify(observedJobs)}`,
          { cause: error },
        );
      }
    }
    return { root, scope };
  });
  const scope = workers[0].scope;
  requireValue(
    workers.every((worker) => same(worker.scope.plan, scope.plan)),
    "source selection",
  );
  requireValue(sourceCheckMatrix(scope.plan).parallel, "parallel source selection");
  const records = workers.map(({ root, scope: workerScope }) => ({
    scope: workerScope,
    plan: json(join(root, "quality-test-execution-plan.json")),
    stages: json(join(root, "quality-stages.json")),
    receipt: json(join(root, "quality-test-execution.json")),
  }));
  const { plan, stages } = records[0];
  requireValue(
    String(plan.binding.runId) === String(runId) &&
      String(plan.binding.runAttempt) === String(scope.runAttempt) &&
      plan.binding.platform === "linux" &&
      plan.binding.manifest.repositories.find((entry) => entry.repo === "dsh-gea-plugin")?.head ===
        head &&
      same([...plan.selected].sort(), [...scope.plan.files].sort()) &&
      same(
        plan.shards.map((shard) => shard.id),
        expectedIds,
      ),
    "execution input",
  );
  const buildSha256 = executionDigest(stages.artifacts);
  const comparable = (value) => {
    const contents = structuredClone(value);
    delete contents.planSha256;
    delete contents.binding.runAttempt;
    return contents;
  };
  const verified = records.map((record) => {
    requireValue(
      same(comparable(record.plan), comparable(plan)) &&
        String(record.plan.binding.runAttempt) === String(record.scope.runAttempt) &&
        same(record.stages.binding.executionPlan, record.plan) &&
        same(record.stages.binding.manifest, record.plan.binding.manifest) &&
        record.stages.binding.inputSha256 === record.plan.binding.inputSha256 &&
        executionDigest(record.stages.artifacts) === buildSha256 &&
        ["prepare", "build", "checks", "tests"].every(
          (name) => record.stages.stages[name]?.status === "passed",
        ),
      "worker preparation or build",
    );
    requireValue(
      record.receipt.scope === "shard" && record.receipt.status === "passed",
      "worker execution",
    );
    return verifyExecutionResults({
      plan: record.plan,
      receipt: record.receipt,
      buildSha256,
      shardId: record.scope.shard.id,
    });
  });
  return {
    status: "passed",
    files: verified.reduce((sum, result) => sum + result.files, 0),
    shards: verified.length,
    execution: "observed",
    producers: records.map(({ scope, plan }) => ({
      shard: scope.shard.id,
      runAttempt: scope.runAttempt,
      planSha256: plan.planSha256,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      matrix: { type: "string" },
      scope: { type: "string" },
      output: { type: "string" },
      aggregate: { type: "string" },
    },
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (values.matrix && !values.scope && !values.output && !values.aggregate) {
    const selection = json(values.matrix);
    const { parallel, shards } = sourceCheckMatrix(selection);
    const { ciCores } = await import("./ci-core-policy.mjs");
    const plan = sourceCheckCost({
      selection,
      root: process.cwd(),
      environment: {
        platform: "linux",
        node: process.versions.node,
        core: ciCores("required")[0].head,
        fileConcurrency: 3,
      },
      timings: json("scripts/quality-test-timings.json"),
    });
    writeFileSync(".runtime/source-check-cost.json", JSON.stringify(plan, null, 2) + "\n");
    if (process.env.GITHUB_STEP_SUMMARY) {
      const e = plan.estimates;
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Source check cost before preparation\n\nSelected ${e.selectedFiles} files; Profile ${selection.runtimeFiles?.length ?? "unknown"}; shards ${plan.shards.length}. Known timings ${e.knownFiles}; unknown ${e.unknownFiles}. Historical ordering hints ${e.advisoryFiles} (advisory only). Estimated tests: ${e.estimatedMs === null ? "unknown" : e.estimatedMs + " ms"}. Preparation, scheduling and finalization are excluded. This is a cost estimate, not execution evidence.\n\n` +
          sourceSelectionMarkdown(selection, shards.length),
      );
    }
    requireValue(process.env.GITHUB_OUTPUT, "matrix output");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `parallel=${parallel}\nshards=${JSON.stringify(shards)}\ncore-sha=${ciCores("required")[0].head}\n`,
    );
  } else if (values.scope && values.output && !values.aggregate && !values.matrix) {
    const shard = sourceCheckShard();
    requireValue(shard, "worker assignment required");
    writeFileSync(
      values.output,
      JSON.stringify(
        {
          schemaVersion: 1,
          head,
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          shard,
          plan: json(values.scope),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    requireValue(values.aggregate && !values.scope && !values.output && !values.matrix, "command");
    console.log(
      JSON.stringify(
        aggregateSourceCheckShards(values.aggregate, {
          head,
          runId: process.env.GITHUB_RUN_ID,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT,
          producers: await readHostedRun({
            repository: process.env.GITHUB_REPOSITORY,
            runId: process.env.GITHUB_RUN_ID,
            runAttempt: process.env.GITHUB_RUN_ATTEMPT,
            headSha: head,
            token: process.env.GITHUB_TOKEN,
            jobFilter: "latest",
          }),
        }),
      ),
    );
  }
}

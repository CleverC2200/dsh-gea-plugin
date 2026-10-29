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
  const parallel = plan.joint && files.length > 1;
  const runtime = files.filter((file) => plan.runtimeFiles?.includes(file)).length;
  const count = Math.min(
    sourceCheckWorkerLimit,
    sourceCheckWorkerTarget,
    files.length,
    Math.max(2, Math.ceil(runtime / 3) + Math.ceil((files.length - runtime) / 40)),
  );
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

export function aggregateSourceCheckShards(directory, { head, runId, runAttempt }) {
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
        String(scope.runAttempt) === String(runAttempt) &&
        typeof scope.plan?.joint === "boolean" &&
        Array.isArray(scope.plan.files) &&
        scope.shard.id === expectedIds[index] &&
        scope.shard.count === expectedIds.length,
      "worker source or assignment",
    );
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
      String(plan.binding.runAttempt) === String(runAttempt) &&
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
  const results = records.flatMap((record) => {
    requireValue(
      same(record.plan, plan) &&
        same(record.stages.binding.executionPlan, plan) &&
        same(record.stages.binding.manifest, plan.binding.manifest) &&
        record.stages.binding.inputSha256 === plan.binding.inputSha256 &&
        executionDigest(record.stages.artifacts) === buildSha256 &&
        ["prepare", "build", "checks", "tests"].every(
          (name) => record.stages.stages[name]?.status === "passed",
        ),
      "worker preparation or build",
    );
    const receipt = record.receipt;
    requireValue(
      receipt.schemaVersion === 1 &&
        receipt.scope === "shard" &&
        receipt.terminal === true &&
        receipt.status === "passed" &&
        !receipt.error &&
        receipt.planSha256 === plan.planSha256 &&
        receipt.buildSha256 === buildSha256 &&
        receipt.results.length === 1 &&
        receipt.results[0].shardId === record.scope.shard.id,
      "worker execution",
    );
    return receipt.results;
  });
  return verifyExecutionResults({
    plan,
    buildSha256,
    receipt: {
      schemaVersion: 1,
      scope: "platform",
      status: "passed",
      terminal: true,
      executionId: "source-checks:" + plan.planSha256,
      planSha256: plan.planSha256,
      buildSha256,
      results,
    },
  });
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
        `## Source check cost before preparation\n\nSelected ${e.selectedFiles} files; Profile ${e.profileFiles}; shards ${plan.shards.length}. Known timings ${e.knownFiles}; unknown ${e.unknownFiles}. Historical ordering hints ${e.advisoryFiles} (advisory only). Estimated tests: ${e.estimatedMs === null ? "unknown" : e.estimatedMs + " ms"}. Preparation, scheduling and finalization are excluded. This is a cost estimate, not execution evidence.\n`,
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
        }),
      ),
    );
  }
}

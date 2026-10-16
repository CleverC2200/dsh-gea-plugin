import { readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { executionDigest, verifyExecutionResults } from "./quality-test-execution.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (file) => JSON.parse(readFileSync(file));
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const reject = (detail) => {
  throw Error("QUALITY_SHARDS_REJECTED: " + detail);
};
const requireValue = (condition, detail) => {
  if (!condition) reject(detail);
};
const sources = (candidate) =>
  candidate.repositories
    .map(({ repo, head }) => ({ repo, head }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
const equal = (a, b) => executionDigest(a) === executionDigest(b);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function admittedSources(receipt, inputSha256, candidate) {
  requireValue(
    receipt?.status === "passed" &&
      receipt.inputSha256 === inputSha256 &&
      Array.isArray(receipt.repositories) &&
      equal(sources(receipt), sources(candidate)) &&
      receipt.repositories.every((entry) => hash(entry.lockSha256)),
    "source admission receipt",
  );
  return receipt.repositories
    .map(({ repo, head, lockSha256 }) => ({ repo, head, lockSha256 }))
    .sort((a, b) => a.repo.localeCompare(b.repo));
}
function verifyIndex(index, expected) {
  const { plan, stages, binding, candidate, core } = index;
  requireValue(
    index.schemaVersion === 1 && expected.cores.includes(core) && candidate.core === core,
    "Core",
  );
  admittedSources(index.admission, binding.inputSha256, candidate);
  const { planSha256, ...contents } = plan;
  requireValue(hash(planSha256) && executionDigest(contents) === planSha256, "plan digest");
  requireValue(
    equal(plan.binding.manifest, candidate) &&
      equal(sources(candidate), sources({ repositories: expected.sources })),
    "source tuple",
  );
  requireValue(
    String(plan.binding.runId) === String(expected.runId) &&
      String(plan.binding.runAttempt) === String(expected.runAttempt) &&
      plan.binding.node === expected.node &&
      plan.binding.platform === "linux",
    "run or environment",
  );
  requireValue(
    equal(stages.binding.executionPlan, plan) &&
      equal(binding.manifest, candidate) &&
      binding.planSha256 === planSha256 &&
      binding.inputSha256 === plan.binding.inputSha256 &&
      stages.binding.inputSha256 === binding.inputSha256 &&
      binding.buildSha256 === executionDigest(stages.artifacts),
    "prepared binding",
  );
  requireValue(
    ["prepare", "build"].every((name) => stages.stages[name]?.status === "passed") &&
      ["passed", "failed"].includes(stages.stages.checks?.status),
    "preparation stages",
  );
  if (plan.shards.length === 1) {
    requireValue(
      index.execution === "producer" &&
        binding.producer &&
        !binding.worker &&
        stages.stages.tests?.status === "passed" &&
        index.receipt?.scope === "platform" &&
        ["bundleBytes", "bundleSha256", "manifestSha256", "bundleArtifactId"].every(
          (key) => index[key] === undefined,
        ),
      "producer execution without transport",
    );
    verifyExecutionResults({ plan, receipt: index.receipt, buildSha256: binding.buildSha256 });
  } else {
    requireValue(
      index.execution === undefined || index.execution === "workers",
      "execution location",
    );
    requireValue(
      Number.isSafeInteger(index.bundleBytes) && index.bundleBytes > 0 && hash(index.bundleSha256),
      "bundle bytes",
    );
    requireValue(
      hash(index.manifestSha256) && /^[1-9][0-9]*$/.test(index.bundleArtifactId),
      "bundle transport",
    );
  }
  requireValue(index.groupId === expected.groupId, "source group");
  requireValue(
    typeof index.bindingBytes === "string" && equal(JSON.parse(index.bindingBytes), binding),
    "original binding bytes",
  );
  requireValue(
    new Set(plan.shards.map((x) => x.id)).size === plan.shards.length &&
      plan.shards.every((x) => /^\d+$/.test(x.id) && x.files.length > 0),
    "nonempty shards",
  );
  requireValue(
    equal(plan.shards.flatMap((x) => x.files).sort(), [...plan.files].sort()) &&
      new Set(plan.files).size === plan.files.length,
    "assigned coverage",
  );
}
/** Historical weights route work; unknown files keep null estimates in the execution plan. */
export function plannedShardCount({ selection, timings }) {
  if (!(selection.runtimeFiles ?? []).length) return 1;
  const samples = new Map((timings?.files ?? []).map((entry) => [entry.file, entry.durationMs]));
  const unknownWeight = Math.max(400000, ...selection.files.map((file) => samples.get(file) ?? 0));
  const weightedMs = selection.files.reduce(
    (sum, file) => sum + (samples.get(file) ?? unknownWeight),
    0,
  );
  return Math.min(14, Math.max(1, Math.ceil(weightedMs / (2 * 400000))));
}
export function createShardCatalog({ indexes, expected }) {
  requireValue(
    expected?.cores?.length > 0 &&
      new Set(expected.cores).size === expected.cores.length &&
      indexes.length === expected.cores.length,
    "all required Cores",
  );
  requireValue(new Set(indexes.map((x) => x.core)).size === indexes.length, "duplicate Core");
  const ordered = expected.cores.map((core) => {
    const index = indexes.find((x) => x.core === core);
    requireValue(index, "missing Core");
    verifyIndex(index, expected);
    return index;
  });
  const include = ordered
    .filter((index) => index.execution !== "producer")
    .flatMap((index) =>
      index.plan.shards.map((shard) => ({
        core: index.core,
        shard: shard.id,
        shardCount: index.plan.shards.length,
        nodeVersion: expected.node,
        bindingSha256: sha(index.bindingBytes),
        manifestSha256: index.manifestSha256,
        bundleArtifactId: index.bundleArtifactId,
        planSha256: index.plan.planSha256,
        inputSha256: index.binding.inputSha256,
        buildSha256: index.binding.buildSha256,
        phase: index.plan.binding.phase,
      })),
    );
  requireValue(include.length <= 256, "GitHub matrix capacity");
  return {
    schemaVersion: 1,
    expected,
    indexes: ordered,
    matrix: { include },
    hasShards: include.length > 0,
    notApplicableJobs: ordered.every((index) => index.execution === "producer")
      ? ["test-shards"]
      : [],
    producerChecks: ordered.every((x) => x.stages.stages.checks.status === "passed")
      ? "passed"
      : "failed",
    requiredJobs: [
      "candidate-scope",
      "plan-test-shards",
      ...ordered.flatMap((index) => [
        `prepare-${index.core}`,
        ...(index.execution === "producer"
          ? []
          : index.plan.shards.map((shard) => `test-${index.core}-${shard.id}`)),
        `macos-${index.core}`,
      ]),
    ],
  };
}
export function aggregateShardResults({ catalog, workers, macos }) {
  const verified = [];
  requireValue(workers.length === catalog.matrix.include.length, "worker count");
  requireValue(macos.length === catalog.expected.cores.length, "macOS count");
  for (const index of catalog.indexes) {
    verifyIndex(index, catalog.expected);
    const matching = workers.filter((x) => x.core === index.core);
    const producer = index.execution === "producer";
    requireValue(
      matching.length === (producer ? 0 : index.plan.shards.length),
      "Core worker count",
    );
    const results = matching.flatMap((x) => {
      requireValue(
        x.preparation?.status === "worker-inputs-ready" &&
          x.preparation.quality === "not-observed" &&
          x.preparation.tests === "not-run" &&
          x.preparation.bindingSha256 === sha(index.bindingBytes) &&
          x.preparation.bundleBytes === index.bundleBytes,
        "worker preparation",
      );
      requireValue(
        x.receipt?.scope === "shard" &&
          x.receipt.terminal === true &&
          x.receipt.status === "passed" &&
          x.receipt.planSha256 === index.plan.planSha256 &&
          x.receipt.buildSha256 === index.binding.buildSha256 &&
          x.receipt.results.length === 1,
        "worker receipt",
      );
      return x.receipt.results;
    });
    verified.push({
      core: index.core,
      platform: "linux",
      ...verifyExecutionResults({
        plan: index.plan,
        receipt: producer
          ? index.receipt
          : {
              schemaVersion: 1,
              scope: "platform",
              status: "passed",
              terminal: true,
              executionId: "aggregate:" + index.plan.planSha256,
              planSha256: index.plan.planSha256,
              buildSha256: index.binding.buildSha256,
              results,
            },
        buildSha256: index.binding.buildSha256,
      }),
    });
    const mac = macos.filter((x) => x.core === index.core);
    requireValue(mac.length === 1, "unique macOS Core");
    const entry = mac[0],
      delegated = index.plan.platformTasks
        .filter((task) => task.platform === "darwin")
        .flatMap((task) => task.files);
    requireValue(
      entry.plan.binding.platform === "darwin" &&
        entry.plan.binding.node === catalog.expected.node &&
        String(entry.plan.binding.runId) === String(catalog.expected.runId) &&
        String(entry.plan.binding.runAttempt) === String(catalog.expected.runAttempt) &&
        entry.plan.binding.manifest.core === index.core &&
        equal(sources(entry.plan.binding.manifest), sources(index.candidate)) &&
        equal([...entry.plan.files].sort(), [...delegated].sort()),
      "macOS source or obligations",
    );
    requireValue(
      equal(
        admittedSources(
          entry.admission,
          entry.plan.binding.inputSha256,
          entry.plan.binding.manifest,
        ),
        admittedSources(index.admission, index.binding.inputSha256, index.candidate),
      ) && entry.groupId === catalog.expected.groupId,
      "cross-platform admission",
    );
    requireValue(entry.buildSha256 === executionDigest(entry.sdk), "macOS SDK binding");
    verified.push({
      core: index.core,
      platform: "darwin",
      ...verifyExecutionResults({
        plan: entry.plan,
        receipt: entry.receipt,
        buildSha256: entry.buildSha256,
      }),
    });
  }
  requireValue(catalog.producerChecks === "passed", "source checks failed");
  return { status: "passed", coverage: "complete-exactly-once", platforms: verified };
}
const readDirectory = (directory) =>
  readdirSync(directory, { recursive: true })
    .filter((file) => file.endsWith(".json"))
    .map((file) => json(join(directory, file)));
export async function shardCli(args) {
  const { values } = parseArgs({
    args,
    options: {
      mode: { type: "string" },
      root: { type: "string" },
      indexes: { type: "string" },
      expected: { type: "string" },
      output: { type: "string" },
      bundle: { type: "string" },
      transport: { type: "string" },
      "artifact-id": { type: "string" },
      catalog: { type: "string" },
      workers: { type: "string" },
      macos: { type: "string" },
    },
  });
  if (values.mode === "prepare-browser") {
    const { prepareSystemChrome } = await import("./quality-system-chrome.mjs");
    return prepareSystemChrome({ root: resolve(values.root) });
  }
  if (values.mode === "binding") {
    const root = resolve(values.root),
      executionPlan = json(join(root, "quality-test-execution-plan.json")),
      stages = json(join(root, "quality-stages.json"));
    const { createWorkerBinding } = await import("./quality-worker-inputs.mjs");
    const binding = createWorkerBinding({ root, executionPlan, stages });
    write(values.output, binding);
    return binding;
  }
  if (values.mode === "index") {
    const root = resolve(values.root),
      plan = json(join(root, "quality-test-execution-plan.json")),
      stages = json(join(root, "quality-stages.json"));
    if (plan.shards.length === 1) {
      requireValue(
        !values.bundle && !values.transport && !values["artifact-id"],
        "producer transport not applicable",
      );
      const { createWorkerSourceControl } = await import("./quality-worker-inputs.mjs");
      const control = createWorkerSourceControl({ root, executionPlan: plan });
      const binding = {
        ...plan.binding,
        planSha256: plan.planSha256,
        buildSha256: executionDigest(stages.artifacts),
        producer: control.metadata,
      };
      const index = {
        schemaVersion: 1,
        execution: "producer",
        core: plan.binding.manifest.core,
        groupId: JSON.parse(control.groupBytes).groupId,
        candidate: plan.binding.manifest,
        plan,
        stages,
        binding,
        bindingBytes: JSON.stringify(binding, null, 2) + "\n",
        admission: control.admission,
        receipt: json(join(root, "quality-test-execution.json")),
      };
      verifyIndex(index, {
        cores: [index.core],
        sources: index.candidate.repositories,
        node: plan.binding.node,
        runId: plan.binding.runId,
        runAttempt: plan.binding.runAttempt,
        groupId: index.groupId,
      });
      write(values.output, index);
      return index;
    }
    const bindingBytes = readFileSync(join(root, "quality-worker-binding.json"), "utf8"),
      binding = JSON.parse(bindingBytes);
    const { createWorkerBinding } = await import("./quality-worker-inputs.mjs");
    requireValue(
      equal(binding, createWorkerBinding({ root, executionPlan: plan, stages })),
      "producer binding changed",
    );
    const candidate = json(join(root, "candidate-input.json")),
      group = json(join(root, "candidate-group.json"));
    const transport = json(values.transport);
    requireValue(transport.status === "transport-exported", "transport export");
    const bytes = readFileSync(join(root, "candidate-input.json"));
    requireValue(sha(bytes) === binding.inputSha256, "original candidate bytes");
    const index = {
      schemaVersion: 1,
      execution: "workers",
      bundleBytes: statSync(values.bundle).size,
      bundleSha256: transport.bundleSha256,
      core: candidate.core,
      groupId: group.groupId,
      candidate,
      plan,
      stages,
      binding,
      bindingBytes,
      admission: json(join(root, "quality-source-admission.json")),
      manifestSha256: transport.manifestSha256,
      bundleArtifactId: values["artifact-id"],
    };
    write(values.output, index);
    return index;
  }
  if (values.mode === "plan") {
    const catalog = createShardCatalog({
      indexes: readDirectory(values.indexes),
      expected: json(values.expected),
    });
    write(values.output, catalog);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(catalog.matrix)}\nhas-shards=${catalog.hasShards}\n`,
      );
    return catalog;
  }
  if (values.mode === "aggregate") {
    const result = aggregateShardResults({
      catalog: json(values.catalog),
      workers: readDirectory(values.workers),
      macos: readDirectory(values.macos),
    });
    write(values.output, result);
    return result;
  }
  reject("mode");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await shardCli(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { skippedTestShardsJobName } from "./quality-hosted-budget.mjs";
import { windowsNativeInput } from "./ci-windows-update.mjs";
import {
  createExecutionPlan,
  executionDigest,
  runExecutionPlan,
} from "./quality-test-execution.mjs";

test("the public planner collects every Core and rejects missing, duplicate or changed indexes", async () => {
  const { createShardCatalog } = await import("./quality-shards.mjs");
  const expected = {
    cores: ["a".repeat(40), "b".repeat(40)],
    runId: "7",
    runAttempt: "2",
    node: process.versions.node,
    groupId: "group",
    sources: [{ repo: "dsh-gea-plugin", head: "c".repeat(40), lockSha256: "d".repeat(64) }],
  };
  const indexes = expected.cores.map((core) => {
    const candidate = { core, groupId: "group", repositories: expected.sources };
    const plan = createExecutionPlan({
      selection: { files: ["one.test.mjs", "two.test.mjs"], required: ["one.test.mjs"] },
      platformPlan: { files: ["one.test.mjs", "two.test.mjs"], platformTasks: [] },
      binding: {
        manifest: candidate,
        inputSha256: executionDigest(candidate),
        phase: "quality",
        dependencyReview: true,
        runId: "7",
        runAttempt: "2",
        platform: "linux",
        arch: "x64",
        node: process.versions.node,
      },
      shardCount: 2,
    });
    const stages = {
      binding: { executionPlan: plan, inputSha256: plan.binding.inputSha256 },
      artifacts: { lib: { "index.js": "hash" } },
      stages: {
        prepare: { status: "passed" },
        build: { status: "passed" },
        checks: { status: "failed" },
      },
    };
    return {
      schemaVersion: 1,
      bundleBytes: 2048,
      bundleSha256: "f".repeat(64),
      core,
      groupId: "group",
      plan,
      stages,
      candidate,
      binding: {
        ...plan.binding,
        planSha256: plan.planSha256,
        buildSha256: executionDigest(stages.artifacts),
      },
      manifestSha256: "e".repeat(64),
      bundleArtifactId: "42",
    };
  });
  for (const index of indexes) {
    index.bindingBytes = JSON.stringify(index.binding, null, 2) + "\n";
    index.admission = {
      status: "passed",
      inputSha256: index.binding.inputSha256,
      repositories: index.candidate.repositories.map((entry) => ({
        ...entry,
        lockSha256: "c".repeat(64),
      })),
    };
  }
  const catalog = createShardCatalog({ indexes, expected });
  assert.equal(catalog.matrix.include.length, 4);
  assert.ok(!catalog.notApplicableJobs.includes(skippedTestShardsJobName));
  assert.deepEqual(catalog.requiredJobs, [
    "candidate-scope",
    "plan-test-shards",
    "windows-plugin-update",
    "Dependency review",
    ...expected.cores.flatMap((core) => [
      `prepare-${core}`,
      `test-${core}-1`,
      `test-${core}-2`,
      `macos-${core}`,
    ]),
  ]);
  assert.equal(
    catalog.producerChecks,
    "failed",
    "checks failure must not suppress worker scheduling",
  );
  for (const broken of [
    indexes.slice(0, 1),
    [...indexes, indexes[0]],
    indexes.map((x, i) => (i ? x : { ...x, manifestSha256: "" })),
  ])
    assert.throws(() => createShardCatalog({ indexes: broken, expected }));
  assert.throws(() => createShardCatalog({ indexes, expected: { ...expected, node: "0.0.0" } }));
});

test("aggregation observes real child reports and rejects omitted, duplicate, stale, skipped and failed executions", async (t) => {
  const { createShardCatalog, aggregateShardResults } = await import("./quality-shards.mjs");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "quality-aggregate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["one", "two", "mac"])
    writeFileSync(
      join(root, name + ".test.mjs"),
      `import test from 'node:test'; test('${name}',()=>{});\n`,
    );
  const core = "a".repeat(40),
    candidate = {
      core,
      repositories: ["dsh-gea-plugin", "dsh-agent-manage", "dsh-agent-workbench"].map((repo) => ({
        repo,
        head: "b".repeat(40),
      })),
    };
  const binding = {
    manifest: candidate,
    inputSha256: executionDigest(candidate),
    phase: "quality",
    runId: "7",
    runAttempt: "2",
    node: process.versions.node,
    platform: "linux",
    arch: "x64",
  };
  const plan = createExecutionPlan({
    concurrency: 3,
    selection: {
      files: ["one.test.mjs", "two.test.mjs", "mac.test.mjs"],
      required: ["one.test.mjs"],
    },
    platformPlan: {
      files: ["one.test.mjs", "two.test.mjs"],
      platformTasks: [{ platform: "darwin", files: ["mac.test.mjs"] }],
    },
    binding,
    shardCount: 2,
  });
  const stages = {
    binding: { executionPlan: plan, inputSha256: binding.inputSha256 },
    artifacts: { lib: { one: "hash" } },
    stages: {
      prepare: { status: "passed" },
      build: { status: "passed" },
      checks: { status: "passed" },
    },
  };
  const admission = {
    status: "passed",
    inputSha256: binding.inputSha256,
    repositories: candidate.repositories.map((entry) => ({ ...entry, lockSha256: "c".repeat(64) })),
  };
  const index = {
    schemaVersion: 1,
    bundleBytes: 2048,
    bundleSha256: "f".repeat(64),
    core,
    groupId: "group",
    candidate,
    plan,
    stages,
    admission,
    binding: {
      ...binding,
      planSha256: plan.planSha256,
      buildSha256: executionDigest(stages.artifacts),
    },
    manifestSha256: "d".repeat(64),
    bundleArtifactId: "42",
  };
  const workerMetadata = {
    sources: [...candidate.repositories, { repo: "official-core", head: core }],
    tools: { fixture: "fixed tool bytes" },
    sdkIdentity: { fixture: "fixed SDK identity" },
  };
  index.binding.worker = { ...workerMetadata, runtime: false };
  index.bindingBytes = JSON.stringify(index.binding, null, 2) + "\n";
  const catalog = createShardCatalog({
    indexes: [index],
    expected: {
      cores: [core],
      sources: candidate.repositories,
      node: process.versions.node,
      runId: "7",
      runAttempt: "2",
      groupId: "group",
    },
  });
  const reporter = resolve("scripts/quality-test-reporter.mjs");
  const workers = plan.shards.map((shard) => ({
    core,
    receipt: runExecutionPlan({
      plan,
      root,
      reporter,
      environment: { NODE_TEST_CONTEXT: undefined },
      resultFile: join(root, "linux-" + shard.id + ".json"),
      shardId: shard.id,
      buildSha256: index.binding.buildSha256,
    }).receipt,
  }));
  for (const worker of workers)
    worker.preparation = {
      status: "worker-inputs-ready",
      quality: "not-observed",
      tests: "not-run",
      bindingSha256: catalog.matrix.include[0].bindingSha256,
      bundleBytes: 2048,
    };
  const macPlan = createExecutionPlan({
      selection: { files: ["mac.test.mjs"] },
      platformPlan: { files: ["mac.test.mjs"] },
      binding: { ...binding, platform: "darwin" },
    }),
    sdk = { identity: "original SDK" };
  const macos = [
    {
      core,
      groupId: "group",
      admission,
      plan: macPlan,
      sdk,
      buildSha256: executionDigest(sdk),
      receipt: runExecutionPlan({
        plan: macPlan,
        root,
        reporter,
        environment: { NODE_TEST_CONTEXT: undefined },
        resultFile: join(root, "mac.json"),
        buildSha256: executionDigest(sdk),
      }).receipt,
    },
  ];
  assert.equal(
    aggregateShardResults({ catalog, workers, macos }).coverage,
    "complete-exactly-once",
  );
  writeFileSync(join(root, "catalog.json"), JSON.stringify(catalog));
  mkdirSync(join(root, "workers"));
  mkdirSync(join(root, "macos"));
  mkdirSync(join(root, "windows"));
  for (const [i, worker] of workers.entries())
    writeFileSync(join(root, "workers", i + ".json"), JSON.stringify(worker));
  writeFileSync(join(root, "macos", "result.json"), JSON.stringify(macos[0]));
  writeFileSync(
    join(root, "windows", "windows-update-scope.json"),
    JSON.stringify({
      schemaVersion: 1,
      applicable: false,
      sourceHead: "b".repeat(40),
      group: { groupId: "group", repositories: candidate.repositories },
      runtime: windowsNativeInput,
    }),
  );
  let age = 30000,
    wrongHead = false,
    hostedRequiredJobs = catalog.requiredJobs,
    hostedCores = [core],
    hostedNativeConclusion = "success",
    hostedSkippedWorker = false,
    skippedConclusion = "skipped",
    skippedCopies = 1,
    hostedReads = 0,
    lagUntilRead = 0,
    hostedStepFailure = false,
    hostedHttpStatus = 200;
  const server = createServer((request, response) => {
    if (!request.url.includes("/jobs?")) hostedReads++;
    const stale = hostedReads <= lagUntilRead;
    const now = Date.now(),
      at = (ms) => new Date(now + ms).toISOString(),
      head = "b".repeat(40);
    const body = request.url.includes("/jobs?")
      ? {
          total_count: hostedRequiredJobs.length + 1 + (hostedSkippedWorker ? skippedCopies : 0),
          jobs: [
            ...[...hostedRequiredJobs, "candidate-quality"].map((name, i) => ({
              id: i + 1,
              name,
              run_id: 7,
              run_attempt: 2,
              head_sha: head,
              status: name === "candidate-quality" ? "in_progress" : "completed",
              conclusion:
                name === "candidate-quality"
                  ? null
                  : name === "windows-plugin-update"
                    ? hostedNativeConclusion
                    : "success",
              started_at: at(-1000),
              completed_at: name === "candidate-quality" ? null : at(-500),
            })),
            ...(hostedSkippedWorker
              ? Array.from({ length: skippedCopies }, (_, offset) => ({
                  id: 1000 + offset,
                  name: skippedTestShardsJobName,
                  run_id: 7,
                  run_attempt: 2,
                  head_sha: head,
                  status: "completed",
                  conclusion: skippedConclusion,
                  started_at: at(-500),
                  completed_at: at(-1500),
                }))
              : []),
          ],
        }
      : {
          id: 7,
          run_attempt: 2,
          head_sha: wrongHead ? "c".repeat(40) : head,
          status: "in_progress",
          conclusion: null,
          created_at: at(-age - 1000),
          run_started_at: at(-age),
          updated_at: at(-500),
        };
    if (stale) {
      if (body.jobs) {
        for (const job of body.jobs) {
          if (job.name === "candidate-quality" || job.name === hostedRequiredJobs.at(-1))
            Object.assign(job, {
              status: job.name === "candidate-quality" ? "queued" : "in_progress",
              conclusion: null,
              completed_at: null,
            });
        }
      } else body.status = "queued";
    }
    if (hostedStepFailure && body.jobs)
      body.jobs.find((job) => job.name === hostedRequiredJobs.at(-1)).steps = [
        { name: "actual work", status: "completed", conclusion: "failure" },
      ];
    response.statusCode = hostedHttpStatus;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const invoke = async (suffix, extra = [], withWindows = true, schedulerNeeds) => {
    const needs = {
      "candidate-scope": { result: "success" },
      "source-plan": { result: "success", outputs: { applicability: "source" } },
      gates: { result: "success" },
      "plan-test-shards": { result: "success" },
      "test-shards": {
        result: hostedRequiredJobs.some((name) => /^test-[a-f0-9]{40}-/.test(name))
          ? "success"
          : "skipped",
      },
      "macos-isolation": { result: "success" },
      "windows-plugin-update": { result: "success" },
      "dependency-review": {
        result: hostedRequiredJobs.includes("Dependency review") ? "success" : "skipped",
      },
    };
    if (schedulerNeeds) schedulerNeeds(needs);
    const child = spawn(
      process.execPath,
      [
        "scripts/run-quality-ci.mjs",
        "--phase",
        "final",
        "--catalog",
        join(root, "catalog.json"),
        "--worker-results",
        join(root, "workers"),
        "--macos-results",
        join(root, "macos"),
        ...(withWindows ? ["--windows-results", join(root, "windows")] : []),
        "--final-output",
        join(root, suffix),
        ...extra,
      ],
      {
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_TOKEN: "fixture-read-token",
          GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
          GITHUB_RUN_ID: "7",
          GITHUB_RUN_ATTEMPT: "2",
          QUALITY_EXPECTED_WORKFLOW_SHA: "b".repeat(40),
          QUALITY_FINAL_NEEDS: JSON.stringify(schedulerNeeds === null ? null : needs),
          QUALITY_FINAL_CORES: JSON.stringify(hostedCores),
          QUALITY_FINAL_GROUP_ID: "group",
          QUALITY_FINAL_MANAGE_SHA: "b".repeat(40),
          QUALITY_FINAL_WORKBENCH_SHA: "b".repeat(40),
          QUALITY_HOSTED_API_BASE: "http://127.0.0.1:" + server.address().port,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.resume();
    const [status] = await once(child, "exit");
    return {
      status,
      stderr,
      coverage: existsSync(join(root, suffix, "coverage.json"))
        ? JSON.parse(readFileSync(join(root, suffix, "coverage.json")))
        : null,
      functionalGate: existsSync(join(root, suffix, "final-dependencies.json"))
        ? JSON.parse(readFileSync(join(root, suffix, "final-dependencies.json")))
        : null,
      hosted: existsSync(join(root, suffix, "hosted-budget.json"))
        ? JSON.parse(readFileSync(join(root, suffix, "hosted-budget.json")))
        : null,
    };
  };
  const green = await invoke("final-green");
  assert.equal(green.status, 0, green.stderr);
  assert.equal(green.hosted.completedMeasurement, false, "in-gate is not completed acceptance");
  const noNeeds = await invoke("final-without-needs", [], true, null);
  assert.equal(noNeeds.status, 1, "without scheduler results the functional gate must reject");
  const readsBeforeLag = hostedReads;
  lagUntilRead = Number.MAX_SAFE_INTEGER;
  const stale = await invoke("final-rest-stale");
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.coverage.status, "passed");
  assert.equal(stale.functionalGate.status, "passed");
  assert.equal(stale.hosted.functional.status, "failed");
  assert.equal(stale.hosted.performance.status, "unknown");
  assert.equal(hostedReads, readsBeforeLag + 1);
  const savedSnapshot = JSON.parse(
    readFileSync(join(root, "final-rest-stale", "hosted-snapshot.json")),
  );
  assert.equal(savedSnapshot.run.status, "queued");
  assert.equal(savedSnapshot.jobs.at(-1).status, "queued");
  hostedStepFailure = true;
  const failedStep = await invoke("stale-with-real-step-failure");
  assert.equal(failedStep.status, 1, "a visible failed step cannot borrow a pending summary");
  hostedStepFailure = false;

  lagUntilRead = 0;
  hostedHttpStatus = 503;
  const httpFailure = await invoke("hosted-http-error");
  assert.equal(httpFailure.status, 1);
  assert.equal(httpFailure.functionalGate.status, "failed");
  assert.match(httpFailure.functionalGate.reasons.join(""), /HOSTED_API_READ_FAILED/);
  hostedHttpStatus = 200;
  for (const [job, result] of [
    ["gates", "failure"],
    ["test-shards", "cancelled"],
    ["macos-isolation", "skipped"],
  ]) {
    const rejected = await invoke(
      `needs-${job}-${result}`,
      [],
      true,
      (needs) => (needs[job].result = result),
    );
    assert.equal(rejected.status, 1, `${job}:${result}`);
    assert.equal(rejected.functionalGate.status, "failed");
  }
  for (const change of [
    (needs) => delete needs["candidate-scope"],
    (needs) => (needs.extra = { result: "success" }),
    (needs) => (needs["source-plan"].outputs.applicability = "docs"),
    (needs) => (needs["dependency-review"].result = "success"),
  ])
    assert.equal((await invoke("needs-shape", [], true, change)).status, 1);
  const missingWindows = await invoke("final-missing-windows", [], false);
  assert.equal(missingWindows.status, 1, missingWindows.stderr);
  assert.equal(missingWindows.coverage.error, "QUALITY_WINDOWS_RECEIPT_REQUIRED");
  for (const conclusion of ["failure", "cancelled", "skipped"]) {
    hostedNativeConclusion = conclusion;
    const failed = await invoke("native-" + conclusion);
    assert.equal(failed.status, 1, failed.stderr);
    assert.notEqual(failed.hosted.functional.status, "passed");
  }
  hostedNativeConclusion = "success";
  const { createEarlyAllocation, createWorkerCatalog } =
    await import("./quality-worker-control.mjs");
  const controlBytes = JSON.stringify({
    schemaVersion: 1,
    scope: "source-plan-only",
    repository: "CleverC2200/dsh-gea-plugin",
    candidateBytes: JSON.stringify(candidate),
    groupBytes: JSON.stringify({ groupId: "group" }),
    plan,
    metadata: workerMetadata,
    admission,
    runtime: false,
  });
  const { createHash } = await import("node:crypto");
  const controls = [
    {
      control: JSON.parse(controlBytes),
      sha256: createHash("sha256").update(controlBytes).digest("hex"),
    },
  ];
  const earlyExpected = { ...catalog.expected, repository: "CleverC2200/dsh-gea-plugin" };
  const allocation = createEarlyAllocation({ controls, expected: earlyExpected });
  mkdirSync(join(root, "early-controls"));
  writeFileSync(join(root, "early-controls/control.json"), controlBytes);
  writeFileSync(join(root, "allocation.json"), JSON.stringify(allocation));
  const earlyCatalog = await createWorkerCatalog({
    controls,
    indexes: [index],
    allocation,
    expected: earlyExpected,
  });
  writeFileSync(join(root, "catalog.json"), JSON.stringify(earlyCatalog));
  hostedRequiredJobs = earlyCatalog.requiredJobs;
  const earlyFlags = [
    "--early-controls",
    join(root, "early-controls"),
    "--early-allocation",
    join(root, "allocation.json"),
  ];
  const earlyGreen = await invoke("final-early-green", earlyFlags);
  assert.equal(earlyGreen.status, 0, JSON.stringify(earlyGreen));
  assert.equal(earlyGreen.coverage.status, "passed");
  assert.equal((await invoke("final-early-missing-flags")).status, 1);
  assert.equal((await invoke("final-early-one-flag", earlyFlags.slice(0, 2))).status, 1);
  writeFileSync(
    join(root, "catalog.json"),
    JSON.stringify({ ...earlyCatalog, requiredJobs: catalog.requiredJobs }),
  );
  assert.equal((await invoke("final-early-required-jobs", earlyFlags)).status, 1);
  writeFileSync(join(root, "catalog.json"), JSON.stringify(earlyCatalog));
  writeFileSync(
    join(root, "allocation.json"),
    JSON.stringify({ ...allocation, expected: { ...earlyExpected, runAttempt: "1" } }),
  );
  assert.equal((await invoke("final-early-wrong-attempt", earlyFlags)).status, 1);
  writeFileSync(join(root, "allocation.json"), JSON.stringify(allocation));
  writeFileSync(join(root, "early-controls/extra.txt"), "unexpected extra control");
  assert.equal((await invoke("final-early-extra", earlyFlags)).status, 1);
  rmSync(join(root, "early-controls/extra.txt"));
  stages.stages.checks.status = "failed";
  const failedChecksCatalog = await createWorkerCatalog({
    controls,
    indexes: [index],
    allocation,
    expected: earlyExpected,
  });
  assert.equal(failedChecksCatalog.producerChecks, "failed");
  writeFileSync(join(root, "catalog.json"), JSON.stringify(failedChecksCatalog));
  const failedChecks = await invoke("final-early-failed-checks", earlyFlags);
  assert.equal(failedChecks.status, 1);
  assert.match(failedChecks.coverage.error, /source checks failed/);
  stages.stages.checks.status = "passed";
  writeFileSync(join(root, "catalog.json"), JSON.stringify(catalog));
  hostedRequiredJobs = catalog.requiredJobs;

  age = 601000;
  const over = await invoke("final-over");
  assert.equal(over.status, 0);
  assert.equal(over.hosted.functional.status, "passed");
  assert.equal(over.hosted.passed, false);
  assert.equal(over.coverage.status, "passed");
  assert.equal(over.hosted.performance.status, "failed");
  age = 30000;
  wrongHead = true;
  const mismatch = await invoke("final-head");
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.hosted.performance.status, "unknown");
  wrongHead = false;
  const changed = structuredClone(workers[0]);
  changed.receipt.results[0].exitCode = 1;
  writeFileSync(join(root, "workers", "0.json"), JSON.stringify(changed));
  const failed = await invoke("final-coverage");
  assert.equal(failed.status, 1);
  assert.equal(failed.coverage.status, "failed");
  assert.equal(
    failed.hosted.performance.status,
    "passed",
    "performance and functional evidence stay separate",
  );
  const bad = [
    workers.slice(0, 1),
    [workers[0], workers[0]],
    structuredClone(workers),
    structuredClone(workers),
    structuredClone(workers),
  ];
  bad[2][0].receipt.results[0].report.context.planSha256 = "old";
  bad[3][0].receipt.results[0].report.summary.counts.skipped = 1;
  bad[4][0].receipt.results[0].exitCode = 1;
  for (const entries of bad)
    assert.throws(() => aggregateShardResults({ catalog, workers: entries, macos }));
  assert.throws(
    () =>
      aggregateShardResults({
        catalog,
        workers: workers.map(({ core, receipt }) => ({ core, receipt })),
        macos,
      }),
    "missing worker preparation cannot pass",
  );
  const wrongLock = structuredClone(macos);
  wrongLock[0].admission.repositories[0].lockSha256 = "0".repeat(64);
  assert.throws(() => aggregateShardResults({ catalog, workers, macos: wrongLock }));
  assert.throws(() => aggregateShardResults({ catalog, workers, macos: [] }));
  assert.throws(() =>
    aggregateShardResults({ catalog: { ...catalog, producerChecks: "failed" }, workers, macos }),
  );

  await t.test(
    "a single producer shard reaches the public final CLI without transport or worker readiness",
    async () => {
      const producerCore = "e".repeat(40);
      const producerCandidate = { ...candidate, core: producerCore };
      const producerBinding = {
        ...binding,
        manifest: producerCandidate,
        inputSha256: executionDigest(producerCandidate),
      };
      const producerPlan = createExecutionPlan({
        concurrency: 3,
        selection: {
          files: ["one.test.mjs", "two.test.mjs", "mac.test.mjs"],
          required: ["one.test.mjs"],
        },
        platformPlan: {
          files: ["one.test.mjs", "two.test.mjs"],
          platformTasks: [{ platform: "darwin", files: ["mac.test.mjs"] }],
        },
        binding: producerBinding,
      });
      const producerStages = structuredClone(stages);
      producerStages.binding = {
        executionPlan: producerPlan,
        inputSha256: producerBinding.inputSha256,
      };
      producerStages.stages.tests = { status: "passed" };
      const producerMetadata = {
        ...workerMetadata,
        sources: [...candidate.repositories, { repo: "official-core", head: producerCore }],
      };
      const producerAdmission = { ...admission, inputSha256: producerBinding.inputSha256 };
      const producerIndex = {
        schemaVersion: 1,
        execution: "producer",
        core: producerCore,
        groupId: "group",
        candidate: producerCandidate,
        plan: producerPlan,
        stages: producerStages,
        admission: producerAdmission,
        binding: {
          ...producerBinding,
          planSha256: producerPlan.planSha256,
          buildSha256: index.binding.buildSha256,
          producer: producerMetadata,
        },
        receipt: runExecutionPlan({
          plan: producerPlan,
          root,
          reporter,
          environment: { NODE_TEST_CONTEXT: undefined },
          resultFile: join(root, "producer.json"),
          buildSha256: index.binding.buildSha256,
        }).receipt,
      };
      producerIndex.bindingBytes = JSON.stringify(producerIndex.binding, null, 2) + "\n";
      const producerExpected = { ...earlyExpected, cores: [producerCore] };
      const producerControlBytes = JSON.stringify({
        ...controls[0].control,
        candidateBytes: JSON.stringify(producerCandidate),
        plan: producerPlan,
        metadata: producerMetadata,
        admission: producerAdmission,
      });
      const producerControls = [
        {
          control: JSON.parse(producerControlBytes),
          sha256: createHash("sha256").update(producerControlBytes).digest("hex"),
        },
      ];
      const producerAllocation = createEarlyAllocation({
        controls: producerControls,
        expected: producerExpected,
      });
      assert.deepEqual(producerAllocation.matrix.include, []);
      assert.equal(producerAllocation.hasShards, false);
      const producerCatalog = await createWorkerCatalog({
        controls: producerControls,
        indexes: [producerIndex],
        allocation: producerAllocation,
        expected: producerExpected,
      });
      assert.equal(
        producerCatalog.requiredJobs.some((name) => name.startsWith("test-")),
        false,
      );
      const producerMacPlan = createExecutionPlan({
        selection: { files: ["mac.test.mjs"] },
        platformPlan: { files: ["mac.test.mjs"] },
        binding: { ...producerBinding, platform: "darwin" },
      });
      const producerMac = {
        ...macos[0],
        core: producerCore,
        admission: producerAdmission,
        plan: producerMacPlan,
        receipt: runExecutionPlan({
          plan: producerMacPlan,
          root,
          reporter,
          environment: { NODE_TEST_CONTEXT: undefined },
          resultFile: join(root, "producer-mac.json"),
          buildSha256: executionDigest(sdk),
        }).receipt,
      };
      for (const i of [0, 1]) rmSync(join(root, "workers", i + ".json"));
      writeFileSync(join(root, "catalog.json"), JSON.stringify(producerCatalog));
      writeFileSync(join(root, "early-controls/control.json"), producerControlBytes);
      writeFileSync(join(root, "allocation.json"), JSON.stringify(producerAllocation));
      writeFileSync(join(root, "macos/result.json"), JSON.stringify(producerMac));
      hostedRequiredJobs = producerCatalog.requiredJobs;
      hostedCores = [producerCore];
      hostedSkippedWorker = true;
      const green = await invoke("single-producer-green", earlyFlags);
      assert.equal(green.status, 0, JSON.stringify(green));
      assert.equal(green.coverage.coverage, "complete-exactly-once");
      assert.equal(green.hosted.performance.status, "passed");
      assert.ok(producerCatalog.notApplicableJobs.includes(skippedTestShardsJobName));
      assert.ok(
        !green.hosted.performance.jobs.some((job) => job.name === skippedTestShardsJobName),
      );
      for (const conclusion of ["failure", "cancelled", "success", null]) {
        skippedConclusion = conclusion;
        assert.equal(
          (await invoke("single-invalid-inapplicable-" + conclusion, earlyFlags)).status,
          1,
        );
      }
      skippedConclusion = "skipped";
      skippedCopies = 2;
      assert.equal((await invoke("single-duplicate-inapplicable", earlyFlags)).status, 1);
      skippedCopies = 1;
      hostedSkippedWorker = false;
      assert.equal((await invoke("single-absent-inapplicable", earlyFlags)).status, 0);
      hostedSkippedWorker = true;
      for (const [scenario, change] of [
        [
          "missing",
          (index) => {
            delete index.receipt;
          },
        ],
        [
          "duplicate",
          (index) => {
            index.receipt.results.push(index.receipt.results[0]);
          },
        ],
        [
          "skip",
          (index) => {
            index.receipt.results[0].report.summary.counts.skipped = 1;
          },
        ],
        [
          "failed",
          (index) => {
            index.receipt.results[0].exitCode = 1;
          },
        ],
        [
          "cancelled",
          (index) => {
            index.receipt.results[0].signal = "SIGTERM";
          },
        ],
        [
          "plan",
          (index) => {
            index.receipt.planSha256 = "old";
          },
        ],
        [
          "build",
          (index) => {
            index.receipt.buildSha256 = "old";
          },
        ],
        [
          "tuple",
          (index) => {
            index.candidate.repositories[0].head = "f".repeat(40);
          },
        ],
        [
          "stage",
          (index) => {
            index.stages.stages.tests.status = "skipped";
          },
        ],
        [
          "source-metadata",
          (index) => {
            index.binding.producer.tools.fixture = "changed";
            index.bindingBytes = JSON.stringify(index.binding);
          },
        ],
        [
          "sdk-identity",
          (index) => {
            index.binding.producer.sdkIdentity.fixture = "changed";
            index.bindingBytes = JSON.stringify(index.binding);
          },
        ],
        [
          "scope",
          (index) => {
            index.receipt.scope = "shard";
          },
        ],
      ]) {
        const broken = structuredClone(producerIndex);
        change(broken);
        writeFileSync(
          join(root, "catalog.json"),
          JSON.stringify({ ...producerCatalog, indexes: [broken] }),
        );
        assert.equal((await invoke("single-reject-" + scenario, earlyFlags)).status, 1, scenario);
      }
      writeFileSync(join(root, "catalog.json"), JSON.stringify(producerCatalog));
      writeFileSync(join(root, "workers/extra.json"), JSON.stringify(workers[0]));
      assert.equal((await invoke("single-extra-worker", earlyFlags)).status, 1);
      rmSync(join(root, "workers/extra.json"));

      const mixedExpected = { ...earlyExpected, cores: [core, producerCore] };
      const mixedControls = [...controls, ...producerControls];
      const mixedAllocation = createEarlyAllocation({
        controls: mixedControls,
        expected: mixedExpected,
      });
      assert.deepEqual(
        mixedAllocation.matrix.include.map((entry) => entry.core),
        [core, core],
      );
      const mixedCatalog = await createWorkerCatalog({
        controls: mixedControls,
        indexes: [producerIndex, index],
        allocation: mixedAllocation,
        expected: mixedExpected,
      });
      assert.equal(mixedCatalog.matrix.include.length, 2);
      assert.equal(mixedCatalog.requiredJobs.includes(`test-${producerCore}-1`), false);
      hostedCores = [core, producerCore];
      hostedSkippedWorker = false;
      hostedRequiredJobs = mixedCatalog.requiredJobs;
      mkdirSync(join(root, "early-controls/producer"));
      writeFileSync(join(root, "early-controls/control.json"), controlBytes);
      writeFileSync(join(root, "early-controls/producer/control.json"), producerControlBytes);
      writeFileSync(join(root, "allocation.json"), JSON.stringify(mixedAllocation));
      writeFileSync(join(root, "catalog.json"), JSON.stringify(mixedCatalog));
      for (const [i, worker] of workers.entries())
        writeFileSync(join(root, "workers", i + ".json"), JSON.stringify(worker));
      writeFileSync(join(root, "macos/worker-core.json"), JSON.stringify(macos[0]));
      const mixed = await invoke("mixed-producer-workers", earlyFlags);
      assert.equal(mixed.status, 0, JSON.stringify(mixed));
      assert.equal(mixed.coverage.platforms.length, 4);
      writeFileSync(
        join(root, "catalog.json"),
        JSON.stringify({ ...mixedCatalog, notApplicableJobs: ["test-shards"] }),
      );
      assert.equal((await invoke("mixed-invalid-inapplicable", earlyFlags)).status, 1);
      writeFileSync(join(root, "catalog.json"), JSON.stringify(mixedCatalog));
      rmSync(join(root, "workers/0.json"));
      assert.equal((await invoke("mixed-missing-worker", earlyFlags)).status, 1);
    },
  );
});

test("historical scheduling weights retain their measured source and leave new tests unknown", async () => {
  const timings = JSON.parse(readFileSync(new URL("./quality-test-timings.json", import.meta.url)));
  assert.equal(timings.source.kind, "historical-reference-only");
  assert.equal(timings.source.fileConcurrency, 3);
  assert.equal(timings.source.acceptance, "not-acceptance");
  assert.match(timings.source.head, /^[a-f0-9]{40}$/);
  const measuredFile = timings.files[0].file;
  const files = [measuredFile, "tests/future-profile.test.mjs", "scripts/future.test.mjs"];
  const plan = createExecutionPlan({
    selection: { files },
    platformPlan: { files },
    binding: {},
    shardCount: 14,
    concurrency: 3,
    timings,
  });
  assert.equal(plan.shards.length, 3);
  assert.equal(plan.estimates.unknownFiles, 2);
  assert.equal(plan.estimates.estimatedMs, null);
  assert.equal(plan.timingSource.runId, timings.source.runId);
  const { plannedShardCount } = await import("./quality-shards.mjs");
  assert.equal(
    plannedShardCount({
      selection: {
        files: [
          ...timings.files.map((entry) => entry.file),
          "scripts/isolated-validation.test.mjs",
        ],
        runtimeFiles: ["tests/source-update-web.test.mjs"],
      },
      timings,
    }),
    8,
  );
  assert.equal(plan.shards.filter((x) => x.estimatedMs === null).length, 2);
});

test("routing uses one shard without Profiles and bounds fixed heavy work at eight", async () => {
  const { plannedShardCount } = await import("./quality-shards.mjs");
  const files = Array.from({ length: 30 }, (_, index) => `tests/heavy-${index}.test.mjs`);
  const timings = { files: files.map((file) => ({ file, durationMs: 400000 })) };
  assert.equal(plannedShardCount({ selection: { files, runtimeFiles: [] }, timings }), 1);
  assert.equal(plannedShardCount({ selection: { files, runtimeFiles: files }, timings }), 8);
  assert.equal(
    plannedShardCount({
      selection: { files: ["new.test.mjs"], runtimeFiles: ["new.test.mjs"] },
      timings,
    }),
    1,
  );
});

test("auto routing reserves setup and finalization time for measured work", async () => {
  const { plannedShardCount } = await import("./quality-shards.mjs");
  const files = ["first.test.mjs", "second.test.mjs", "third.test.mjs"];
  assert.equal(
    plannedShardCount({
      selection: { files, runtimeFiles: files },
      timings: { files: files.map((file) => ({ file, durationMs: 180000 })) },
    }),
    2,
  );
});

test("auto routing keeps leaf, unknown and empty selections bounded without dropping files", async () => {
  const { plannedShardCount } = await import("./quality-shards.mjs");
  for (const [durations, expectedShards] of [
    [[120000, 20000], 1],
    [[90000, 90000, 90000], 1],
    [[120000, 120000, 120000, 120000, 120000, 120000, 120000, 120000], 3],
    [[null, 20000], 1],
    [[null, null, 20000], 2],
    [[600000, null], 3],
    [[600000], 2],
    [Array(30).fill(null), 8],
    [[], 1],
  ]) {
    const files = durations.map((_, index) => `tests/leaf-${index}.test.mjs`);
    const selection = { files, required: files.slice(0, 1), runtimeFiles: files };
    const timings = {
      source: { kind: "test-fixture" },
      files: durations.flatMap((durationMs, index) =>
        durationMs === null ? [] : [{ file: files[index], durationMs }],
      ),
    };
    const shardCount = plannedShardCount({ selection, timings });
    assert.equal(shardCount, expectedShards);
    const plan = createExecutionPlan({
      selection,
      platformPlan: { files },
      binding: {},
      timings,
      shardCount,
      concurrency: 3,
    });
    assert.equal(plan.shards.length, Math.min(expectedShards, files.length));
    assert.ok(plan.shards.every((shard) => shard.files.length > 0));
    assert.deepEqual(plan.shards.flatMap((shard) => shard.files).sort(), [...files].sort());
    assert.deepEqual(plan.required, selection.required);
    assert.equal(plan.estimates.unknownFiles, durations.filter((value) => value === null).length);
    if (durations.includes(null)) assert.equal(plan.estimates.estimatedMs, null);
  }
});

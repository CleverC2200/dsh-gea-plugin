import { createRequire } from "node:module";
import {
  qualityStageRun,
  qualityBuildOutputs,
  verifyQualityBuildInventory,
  observeQualityStages,
} from "./quality-ci-stages.mjs";
import {
  createExecutionPlan,
  executionDigest,
  runExecutionPlan,
  verifyExecutionResults,
} from "./quality-test-execution.mjs";
import { runQualityChecks } from "./run-quality-checks.mjs";
import { sourceCheckShard } from "./source-check-shards.mjs";
import { installCommands, browserPreparationBudget } from "./quality-worker-inputs.mjs";
/** Public source-event admission and fail-closed workflow aggregation. */
import { parseArgs, isDeepStrictEqual } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  realpathSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  symlinkSync,
} from "node:fs";
import { resolve, dirname, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  prepareQualityUpstreams,
  verifyQualityUpstreams,
  bindQualityUpstreamInputs,
} from "./quality-upstreams.mjs";
import {
  readPreparedWorkbench,
  verifyPreparedWorkbench,
  prepareWorkbenchGeaAuthority,
  prepareWorkbenchAssets,
} from "./quality-workbench.mjs";
import { resolveSourceInputs } from "./source-profile.mjs";
import { resourceDigests } from "./source-combination-integrity.mjs";
import { supportedCores } from "./supported-cores.mjs";
import {
  macosIsolationTests,
  selectPlatformTests,
  requiresDependencyReview,
} from "./ci-platform-tests.mjs";
const candidatePhases = new Set(["quality", "prepare", "verify-input", "macos-isolation"]);
let finalGroup;
let stages;
let profileTestsSelected = false;
function refuse(code, detail = "") {
  throw Error(code + (detail ? ": " + detail : ""));
}
function admittedCore(head) {
  const core = supportedCores.find((entry) => entry.head === head);
  if (!core) refuse("CANDIDATE_CORE_UNSUPPORTED", head);
  return core;
}
function run(command, args, cwd = process.cwd(), environment = {}) {
  const release =
    ["npm", "corepack"].includes(command) && (args.includes("ci") || args.includes("install"))
      ? createRequire(import.meta.url)("./build-admission.mjs").acquireBuild({
          operation: "prepare",
          cwd,
        })
      : () => {};
  try {
    finalGroup?.verifyUnchanged();
    const windows = process.platform === "win32" && ["npm", "corepack"].includes(command);
    const result = spawnSync(windows ? command + ".cmd" : command, args, {
      cwd,
      stdio: "inherit",
      shell: windows,
      env: { ...process.env, ...environment },
    });
    if (result.error || result.signal || result.status !== 0)
      refuse(
        "QUALITY_COMMAND_FAILED",
        command + ": " + (result.error?.message ?? result.signal ?? result.status),
      );
  } finally {
    release();
  }
}
function writeSourceWindow(candidate, core, windowInputs) {
  const history = resolve("scripts/fixtures/delivery-history/navigation-r7-setup-failure.json.raw");

  writeFileSync(
    windowInputs,
    JSON.stringify(
      {
        ...candidate,
        corePath: core,
        historicalFailure: {
          file: history,
          sha256: createHash("sha256").update(readFileSync(history)).digest("hex"),
        },
      },
      null,
      2,
    ) + "\n",
  );

  process.env.GEA_TEST_CANDIDATE_INPUTS = windowInputs;
}
try {
  const { values } = parseArgs({
    options: {
      phase: { type: "string", default: "quality" },
      stage: { type: "string", default: "full" },
      input: { type: "string" },
      root: { type: "string" },
      sha: { type: "string" },
      "prepare-sdk": { type: "boolean" },
      "core-source": { type: "string" },
      "core-head": { type: "string" },
      "prepare-inputs": { type: "boolean" },
      "browser-preparation-timeout-ms": { type: "string" },
      "source-only": { type: "boolean" },
      "final-group-sha256": { type: "string" },
      "final-group-workbench": { type: "string" },
      "test-shards": { type: "string", default: "1" },
      "test-file-concurrency": { type: "string", default: "2" },
      "test-timings": { type: "string" },
      "source-check-receipt": { type: "string" },
      "test-results": { type: "string" },
      "execution-plan": { type: "string" },
      "test-shard": { type: "string" },
      catalog: { type: "string" },
      "early-controls": { type: "string" },
      "early-allocation": { type: "string" },
      "worker-results": { type: "string" },
      "macos-results": { type: "string" },
      "final-output": { type: "string" },
      "docs-results": { type: "string" },
      "windows-results": { type: "string" },
    },
  });
  if (values.stage === "observe") {
    if (values.phase !== "quality") refuse("QUALITY_STAGE_PHASE", values.phase);
    const root = values.root ?? dirname(dirname(process.cwd()));
    console.log(JSON.stringify(observeQualityStages(resolve(root, "quality-stages.json"))));
    process.exit(0);
  }
  if (
    (values["early-controls"] !== undefined || values["early-allocation"] !== undefined) &&
    (values.phase !== "final" || !values["early-controls"] || !values["early-allocation"])
  )
    refuse("QUALITY_EARLY_FINAL_INPUT_REQUIRED");
  if (!/^(2|3|4)$/.test(values["test-file-concurrency"]))
    refuse("QUALITY_TEST_CONCURRENCY_REQUIRED");
  const testFileConcurrency = Number(values["test-file-concurrency"]);
  const sourceShard = sourceCheckShard();
  delete process.env.GEA_SOURCE_CHECK_SHARD;
  if (sourceShard) {
    if (
      !values["source-only"] ||
      values.phase !== "quality" ||
      values.stage !== "full" ||
      values["test-shards"] !== "1" ||
      values["test-shard"] !== undefined ||
      values["execution-plan"] !== undefined
    )
      refuse("SOURCE_CHECK_SHARDS_REJECTED", "source worker full stage required");
    values["test-shards"] = String(sourceShard.count);
    values["test-shard"] = sourceShard.id;
  }
  if (
    ![
      "full",
      "plan",
      "docs",
      "verify-tests",
      "prepare",
      "build",
      "checks",
      "tests",
      "summary",
    ].includes(values.stage)
  )
    refuse("QUALITY_STAGE_REQUIRED", values.stage);
  if (values.stage !== "full" && values.phase !== "quality")
    refuse("QUALITY_STAGE_PHASE", values.phase);
  if (
    candidatePhases.has(values.phase) ||
    values["final-group-sha256"] !== undefined ||
    values["final-group-workbench"] !== undefined
  ) {
    if (
      !values.input ||
      values["final-group-sha256"]?.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(values["final-group-sha256"] ?? "") ||
      !isAbsolute(values["final-group-workbench"] ?? "")
    )
      refuse(
        "CANDIDATE_FINAL_GROUP_REQUIRED",
        "--input, original bytes --final-group-sha256 and absolute clean source --final-group-workbench required",
      );
    if (!candidatePhases.has(values.phase)) refuse("CANDIDATE_FINAL_GROUP_PHASE", values.phase);
  }
  if (values.phase === "scope") {
    if (process.env.QUALITY_SCOPE_ALLOWED !== "true") throw Error("CANDIDATE_SCOPE_REQUIRED");
  } else if (values.phase === "compatibility-final") {
    for (const key of ["QUALITY_SCOPE_RESULT", "QUALITY_GATE_RESULT", "QUALITY_ISOLATION_RESULT"])
      if (process.env[key] !== "success") refuse("QUALITY_COMPATIBILITY_REQUIRED", key);
  } else if (values.phase === "docs-final") {
    const { verifyDocsResults, docsHostedJobScope } = await import("./quality-docs.mjs");
    const { readHostedRun, assessHostedBudget, assessFinalDependencies } =
      await import("./quality-hosted-budget.mjs");
    const expected = {
      cores: JSON.parse(process.env.QUALITY_FINAL_CORES),
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      node: process.versions.node,
      groupId: process.env.QUALITY_FINAL_GROUP_ID,
      sources: [
        { repo: "dsh-gea-plugin", head: process.env.QUALITY_EXPECTED_WORKFLOW_SHA },
        { repo: "dsh-agent-manage", head: process.env.QUALITY_FINAL_MANAGE_SHA },
        { repo: "dsh-agent-workbench", head: process.env.QUALITY_FINAL_WORKBENCH_SHA },
      ],
    };
    const windows = await import("./ci-windows-update.mjs");
    windows.verifyWindowsUpdateResult({ directory: values["windows-results"], expected });
    const result = verifyDocsResults({ directory: values["docs-results"], expected });
    const snapshot = await readHostedRun({
      repository: process.env.GITHUB_REPOSITORY,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      headSha: process.env.QUALITY_EXPECTED_WORKFLOW_SHA,
      token: process.env.GITHUB_TOKEN,
      ...(process.env.QUALITY_HOSTED_API_BASE
        ? { apiBase: process.env.QUALITY_HOSTED_API_BASE }
        : {}),
    });
    const { requiredJobs, notApplicableJobs } = docsHostedJobScope({
      snapshot,
      cores: expected.cores,
      finalJobName: process.env.QUALITY_FINAL_JOB_NAME ?? "candidate-quality",
    });
    const hosted = assessHostedBudget({
      snapshot,
      requiredJobs,
      notApplicableJobs,
      finalJobName: process.env.QUALITY_FINAL_JOB_NAME ?? "candidate-quality",
      mode: "in-gate",
    });
    let functionalGate;
    try {
      functionalGate = assessFinalDependencies({
        snapshot,
        requiredJobs,
        notApplicableJobs,
        finalJobName: process.env.QUALITY_FINAL_JOB_NAME ?? "candidate-quality",
        needs: JSON.parse(process.env.QUALITY_FINAL_NEEDS ?? "null"),
        applicability: result.applicability,
        hasShards: false,
        dependencyReview: false,
      });
    } catch (error) {
      functionalGate = { status: "failed", reasons: [error.message] };
    }
    const output = resolve(values["final-output"]);
    mkdirSync(output, { recursive: true });
    for (const [name, data] of Object.entries({
      coverage: result,
      "hosted-budget": hosted,
      "hosted-snapshot": snapshot,
      "final-dependencies": functionalGate,
    }))
      writeFileSync(resolve(output, name + ".json"), JSON.stringify(data, null, 2) + "\n");
    if (functionalGate.status !== "passed") refuse("QUALITY_DOCS_FINAL_REJECTED");
  } else if (values.phase === "final") {
    if (
      !values.catalog ||
      !values["worker-results"] ||
      !values["macos-results"] ||
      !values["final-output"]
    )
      refuse("QUALITY_FINAL_INPUT_REQUIRED");
    const { shardCli, createShardCatalog } = await import("./quality-shards.mjs");
    const { readHostedRun, assessHostedBudget, assessFinalDependencies } =
      await import("./quality-hosted-budget.mjs");
    const output = resolve(values["final-output"]);
    mkdirSync(output, { recursive: true });
    let coverage, catalog;
    try {
      const candidateCatalog = JSON.parse(readFileSync(values.catalog));
      const expected = {
        cores: JSON.parse(process.env.QUALITY_FINAL_CORES),
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        node: process.versions.node,
        groupId: process.env.QUALITY_FINAL_GROUP_ID,
        sources: [
          { repo: "dsh-gea-plugin", head: process.env.QUALITY_EXPECTED_WORKFLOW_SHA },
          { repo: "dsh-agent-manage", head: process.env.QUALITY_FINAL_MANAGE_SHA },
          { repo: "dsh-agent-workbench", head: process.env.QUALITY_FINAL_WORKBENCH_SHA },
        ],
      };
      if (values["windows-results"]) {
        const windows = await import("./ci-windows-update.mjs");
        windows.verifyWindowsUpdateResult({ directory: values["windows-results"], expected });
      } else if (process.env.GITHUB_ACTIONS === "true") refuse("QUALITY_WINDOWS_RECEIPT_REQUIRED");
      const frozenCatalog = values["early-controls"]
        ? await (
            await import("./quality-worker-control.mjs")
          ).readWorkerCatalog({
            controls: values["early-controls"],
            allocation: values["early-allocation"],
            indexes: candidateCatalog.indexes,
            expected: { ...expected, repository: process.env.GITHUB_REPOSITORY },
          })
        : createShardCatalog({ indexes: candidateCatalog.indexes, expected });
      if (!isDeepStrictEqual(candidateCatalog, frozenCatalog))
        refuse("QUALITY_FINAL_SCOPE_MISMATCH");
      catalog = frozenCatalog;
      coverage = await shardCli([
        "--mode",
        "aggregate",
        "--catalog",
        values.catalog,
        "--workers",
        values["worker-results"],
        "--macos",
        values["macos-results"],
        "--output",
        resolve(output, "coverage.json"),
      ]);
    } catch (error) {
      coverage = { status: "failed", error: error.message };
      writeFileSync(resolve(output, "coverage.json"), JSON.stringify(coverage, null, 2) + "\n");
    }
    let hosted, functionalGate;
    try {
      const snapshot = await readHostedRun({
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        headSha: process.env.QUALITY_EXPECTED_WORKFLOW_SHA,
        token: process.env.GITHUB_TOKEN,
        ...(process.env.QUALITY_HOSTED_API_BASE
          ? { apiBase: process.env.QUALITY_HOSTED_API_BASE }
          : {}),
      });
      writeFileSync(
        resolve(output, "hosted-snapshot.json"),
        JSON.stringify(snapshot, null, 2) + "\n",
      );
      const scope = {
        requiredJobs: catalog?.requiredJobs ?? ["candidate-scope", "plan-test-shards"],
        notApplicableJobs: catalog?.notApplicableJobs ?? [],
        finalJobName: process.env.QUALITY_FINAL_JOB_NAME ?? "candidate-quality",
      };
      hosted = assessHostedBudget({ snapshot, ...scope, mode: "in-gate" });
      functionalGate = assessFinalDependencies({
        snapshot,
        ...scope,
        needs: JSON.parse(process.env.QUALITY_FINAL_NEEDS ?? "null"),
        applicability: "source",
        hasShards: catalog?.hasShards === true,
        dependencyReview: scope.requiredJobs.includes("Dependency review"),
      });
    } catch (error) {
      functionalGate = { status: "failed", reasons: [error.message] };
      hosted ??= {
        passed: false,
        functional: { status: "unknown", error: error.message },
        performance: { status: "unknown", error: error.message },
        completedMeasurement: false,
      };
    }
    if (!catalog) {
      hosted.functional = { status: "unknown", reasons: ["QUALITY_CATALOG_REQUIRED"] };
      hosted.passed = false;
    }
    functionalGate ??= {
      status: "failed",
      reasons: [hosted.functional.error ?? "QUALITY_CATALOG_REQUIRED"],
    };
    if (!catalog) functionalGate = { status: "failed", reasons: ["QUALITY_CATALOG_REQUIRED"] };
    writeFileSync(
      resolve(output, "final-dependencies.json"),
      JSON.stringify(functionalGate, null, 2) + "\n",
    );
    writeFileSync(resolve(output, "hosted-budget.json"), JSON.stringify(hosted, null, 2) + "\n");
    console.log(JSON.stringify({ coverage, hosted, functionalGate }));
    if (coverage.status !== "passed" || functionalGate.status !== "passed")
      refuse("QUALITY_FINAL_REJECTED");
  } else if (values.phase === "input") {
    refuse(
      "CANDIDATE_INPUT_REQUIRED",
      "use the shared hosted group writer and explicit hashed admission",
    );
  } else {
    if (!candidatePhases.has(values.phase)) refuse("QUALITY_PHASE_REQUIRED", values.phase);
    const input = values.input;
    // The public Workbench reader owns exact source, identity, lock and Core admission.
    const { readFinalGroup } = await import(
      pathToFileURL(resolve(values["final-group-workbench"], "scripts/candidate-input.mjs"))
    );
    finalGroup = await readFinalGroup({
      input,
      sha256: values["final-group-sha256"],
      checkout: process.cwd(),
      repo: "dsh-gea-plugin",
      coreSource: values["core-source"],
      expectedSha: process.env.QUALITY_EXPECTED_SHA,
      ci: process.env.CI,
    });
    if (values["core-head"] !== undefined && values["core-head"] !== finalGroup.manifest.core)
      refuse("CANDIDATE_CORE_MISMATCH");
    if (values.phase === "verify-input") {
      console.log(JSON.stringify(finalGroup.receipt));
      process.exit(0);
    }
    const candidate = finalGroup.manifest;
    if (values.root)
      writeFileSync(
        resolve(values.root, "quality-source-admission.json"),
        JSON.stringify(finalGroup.receipt, null, 2) + "\n",
      );
    const coreBaseline = admittedCore(candidate.core);
    if (candidate.repositories?.length !== 3)
      refuse("CANDIDATE_PEER_REQUIRED", "fixed Core and exactly three sources");
    const own = candidate.repositories.find((entry) => entry.repo === "dsh-gea-plugin");
    if (!own || resolve(own.path) !== process.cwd())
      refuse("CANDIDATE_CHECKOUT", "registered GEA checkout required");
    if (process.env.CI && !process.env.QUALITY_EXPECTED_SHA) refuse("CANDIDATE_EVENT_REQUIRED");
    if (process.env.QUALITY_EXPECTED_SHA && own.head !== process.env.QUALITY_EXPECTED_SHA)
      refuse("CANDIDATE_EVENT_MISMATCH");
    if (values["prepare-inputs"])
      for (const entry of candidate.repositories)
        if (realpathSync(entry.path) !== resolve(entry.path))
          refuse("QUALITY_PRIVATE_PEER_REQUIRED", entry.repo);
    const workbench = candidate.repositories.find((entry) => entry.repo === "dsh-agent-workbench"),
      manage = candidate.repositories.find((entry) => entry.repo === "dsh-agent-manage");
    if (values.phase === "macos-isolation" && process.platform !== "darwin")
      refuse("QUALITY_MACOS_ISOLATION_REQUIRED");
    const { selectCiTests } = await import(
      pathToFileURL(resolve(workbench.path, "scripts/ci-test-plan.mjs"))
    );
    const baseline = JSON.parse(readFileSync("scripts/quality-peer-baseline.json"));
    const selectedPlan =
      values.phase === "macos-isolation"
        ? {
            lane: "macos-isolation",
            runtime: false,
            browser: false,
            files: [...macosIsolationTests],
          }
        : selectCiTests({
            repositories: candidate.repositories,
            sourceOnly: values["source-only"],
            repo: "dsh-gea-plugin",
            testOwners: JSON.parse(readFileSync("scripts/ci-test-policy.json")).testOwners,
            base:
              process.env.QUALITY_BASE_SHA ||
              baseline.repositories.find((entry) => entry.repo === "dsh-gea-plugin").head,
          });
    const plan =
      values.phase === "macos-isolation"
        ? { ...selectedPlan, platformTasks: [] }
        : selectedPlan.applicability === "docs"
          ? { ...selectedPlan, platformTasks: [] }
          : selectPlatformTests(selectedPlan);
    const timings = values["test-timings"]
      ? (await import("./quality-test-timings.mjs")).currentTestTimings({
          timings: JSON.parse(readFileSync(values["test-timings"])),
          root: process.cwd(),
          environment: {
            platform: process.platform,
            node: process.versions.node,
            core: candidate.core,
            fileConcurrency: testFileConcurrency,
          },
        })
      : undefined;
    const shardCount =
      values["test-shards"] === "auto"
        ? (await import("./quality-shards.mjs")).plannedShardCount({
            selection: selectedPlan,
            timings,
          })
        : Number(values["test-shards"]);
    const computedExecutionPlan = createExecutionPlan({
      selection: selectedPlan,
      platformPlan: plan,
      shardCount,
      concurrency: testFileConcurrency,
      timings,
      binding: {
        inputSha256: finalGroup.receipt.inputSha256,
        manifest: candidate,
        phase: values.phase,
        coreSource: values["core-source"] ? resolve(values["core-source"]) : null,
        runId: process.env.GITHUB_RUN_ID ?? null,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        platform: process.platform,
        arch: process.arch,
        node: process.versions.node,
        dependencyReview: requiresDependencyReview(
          selectedPlan.changes ?? [],
          process.env.GITHUB_EVENT_NAME,
        ),
      },
    });
    let executionPlan = computedExecutionPlan;
    if (values["execution-plan"]) {
      executionPlan = JSON.parse(readFileSync(values["execution-plan"]));
      if (JSON.stringify(executionPlan) !== JSON.stringify(computedExecutionPlan))
        refuse("QUALITY_TEST_PLAN_CHANGED");
    }
    if (
      values["test-shard"] !== undefined &&
      !sourceShard &&
      (values.stage !== "tests" || !values["execution-plan"])
    )
      refuse("QUALITY_TEST_FROZEN_SHARD_REQUIRED");
    if (values.stage === "plan") {
      finalGroup.verifyUnchanged();
      if (process.env.GITHUB_OUTPUT)
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `browser=${plan.browser === true}\napplicability=${selectedPlan.applicability ?? "source"}\ndependency-review-applicable=${executionPlan.binding.dependencyReview}\n`,
        );
      console.log(JSON.stringify(executionPlan));
      process.exit(0);
    }
    if (values.stage === "docs") {
      if (
        selectedPlan.applicability !== "docs" ||
        plan.files.length ||
        plan.runtime ||
        plan.browser
      )
        refuse("QUALITY_DOCS_SCOPE_REQUIRED");
      for (const [canonical, source] of [
        [resolve(values.root, "official-latest-standard"), values["core-source"]],
        [resolve(values.root, "candidate/dsh-agent-workbench"), workbench.path],
      ]) {
        const admittedSource = realpathSync(source);
        if (existsSync(canonical)) {
          if (realpathSync(canonical) !== admittedSource)
            refuse("QUALITY_DOCS_SOURCE_CHANGED", canonical);
        } else symlinkSync(admittedSource, canonical, "dir");
      }
      const checks = runQualityChecks([
        {
          name: "whitespace",
          execute: () => run("git", ["diff", "--check", selectedPlan.diffBase, own.head]),
        },
        {
          name: "knowledge",
          execute: () =>
            run(process.execPath, [
              resolve(workbench.path, "scripts/check-agent-knowledge.mjs"),
              "--root",
              process.cwd(),
              "--config",
              "docs/agent-knowledge.json",
            ]),
        },
      ]);
      finalGroup.verifyUnchanged();
      const group = JSON.parse(readFileSync(resolve(values.root, "candidate-group.json")));
      const result = {
        schemaVersion: 1,
        status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
        applicability: "docs",
        groupId: group.groupId,
        plan: executionPlan,
        admission: finalGroup.receipt,
        checks,
      };
      const file = resolve(values["docs-results"]);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
      if (result.status !== "passed") refuse("QUALITY_DOCS_CHECKS_FAILED");
      process.exit(0);
    }
    const executionResultFile =
      values["test-results"] ??
      resolve(dirname(dirname(process.cwd())), "quality-test-execution.json");
    if (values.stage === "verify-tests") {
      const recorded = JSON.parse(
        readFileSync(resolve(dirname(dirname(process.cwd())), "quality-stages.json")),
      );
      if (recorded.binding?.executionPlan?.planSha256 !== executionPlan.planSha256)
        refuse("QUALITY_STAGE_INPUT_CHANGED");
      const verified = verifyExecutionResults({
        plan: executionPlan,
        receipt: JSON.parse(readFileSync(executionResultFile)),
        buildSha256: executionDigest(recorded.artifacts),
      });
      finalGroup.verifyUnchanged();
      console.log(JSON.stringify(verified));
      process.exit(0);
    }
    console.log(
      JSON.stringify({
        stage: "test-plan",
        planSha256: executionPlan.planSha256,
        ...executionPlan.estimates,
      }),
    );
    if (
      (values["prepare-inputs"] && ["full", "prepare"].includes(values.stage)) ||
      values.phase === "macos-isolation"
    )
      await prepareWorkbenchGeaAuthority({ workbench: workbench.path, gea: own.path });
    profileTestsSelected = plan.runtime;
    // The window contract traverses Core's complete dependency tree, including Web assets.
    const needsCoreWeb =
      values.phase === "macos-isolation" ||
      plan.runtime ||
      plan.files.includes("tests/window-launch-admission.test.mjs");
    const preparedWorkbench = resolve(dirname(process.cwd()), "dsh-agent-workbench");
    const workbenchReceipt = resolve(dirname(dirname(process.cwd())), "prepared-workbench.json");
    const workbenchAssetRoot = resolve(
      dirname(dirname(process.cwd())),
      "prepared-workbench-assets",
    );
    const core = resolve(dirname(dirname(process.cwd())), "official-latest-standard"),
      upstream = resolve(dirname(dirname(process.cwd())), "quality-upstreams");
    const jobRoot = dirname(dirname(process.cwd()));
    const stagedPhase = values.phase === "quality";
    if (stagedPhase) {
      stages = qualityStageRun({
        file: resolve(jobRoot, "quality-stages.json"),
        requested: values.stage,
        binding: {
          input: resolve(input),
          inputSha256: finalGroup.receipt.inputSha256,
          phase: values.phase,
          manifest: candidate,
          plan,
          executionPlan,
          coreSource: values["core-source"] ? resolve(values["core-source"]) : null,
        },
      });
      if (values.stage === "summary") {
        if (
          ["prepare", "build", "checks", "tests"].some(
            (name) => stages.record.stages[name]?.status !== "passed",
          )
        )
          stages.summarize({ workflowResults: process.env.CI === "true" });
      } else stages.start(values.stage === "full" ? "prepare" : values.stage);
    }
    const preparing = values.stage === "full" || values.stage === "prepare";
    const building = values.stage === "full" || values.stage === "build";
    const prepareInputs = preparing && values["prepare-inputs"];
    if (!values["execution-plan"])
      writeFileSync(
        resolve(jobRoot, "quality-test-execution-plan.json"),
        JSON.stringify(executionPlan, null, 2) + "\n",
      );
    // Stage processes reconstruct these values from the admitted tuple, never a prior shell.
    for (const key of [
      "GEA_TEST_SOURCE_INPUTS",
      "GEA_TEST_CANDIDATE",
      "GEA_TEST_CANDIDATE_SHA256",
      "GEA_TEST_SOURCE_CORE",
      "GEA_TEST_CANDIDATE_INPUTS",
      "GEA_PACKAGE_PNPM",
    ])
      delete process.env[key];
    run(process.execPath, [
      resolve(manage.path, "scripts/prepare-official-sdk.mjs"),
      "--core",
      core,
      "--core-head",
      coreBaseline.head,
      "--consumer",
      process.cwd(),
      ...(needsCoreWeb ? ["--with-web"] : []),
      ...((plan.runtime || plan.files.some((file) => file.endsWith(".contract.mjs"))) &&
      process.platform !== "win32"
        ? ["--with-flock"]
        : []),
      ...(preparing && values["prepare-sdk"]
        ? [
            "--prepare",
            ...(process.env.QUALITY_REUSE_SDK === "true" ? ["--reuse-prepared"] : []),
            "--source",
            values["core-source"] ?? "https://github.com/deepseek-ai/deepseek-harness.git",
          ]
        : []),
    ]);
    if (needsCoreWeb && !existsSync(resolve(core, "apps/web/dist/index.html")))
      refuse("QUALITY_CORE_WEB_REQUIRED");
    finalGroup?.verifyUnchanged();
    process.env.GEA_PLUGIN_UPDATE_SDK = core;
    process.env.GEA_PLUGIN_UPDATE_CANDIDATE_CORE = core;
    if (values.phase === "macos-isolation") {
      if (existsSync(preparedWorkbench))
        refuse("QUALITY_PREPARED_ALREADY_EXISTS", preparedWorkbench);
      run("git", [
        "-C",
        workbench.path,
        "worktree",
        "add",
        "--detach",
        preparedWorkbench,
        workbench.head,
      ]);
      run(
        "npm",
        ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        preparedWorkbench,
      );
      run("corepack", [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
      ]);
      run(process.execPath, ["scripts/build.mjs", "--target", "host"]);
      finalGroup.verifyUnchanged();
      const output = resolve(".runtime/quality-isolation");
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
      writeSourceWindow(candidate, core, resolve(output, "source-window-inputs.json"));
      const sdk = {};
      for (const name of ["artifacts", "web", "flock"]) {
        const file = resolve(core, `.git/dsh-sdk-${name}.json`);
        if (existsSync(file)) sdk[name] = JSON.parse(readFileSync(file));
      }
      if (!sdk.artifacts || !sdk.web) refuse("QUALITY_MACOS_SDK_RECEIPT_REQUIRED");
      sdk.host = {
        file: "lib/host.js",
        sha256: createHash("sha256").update(readFileSync("lib/host.js")).digest("hex"),
      };
      const buildSha256 = executionDigest(sdk);
      let receipt;
      const checks = runQualityChecks([
        {
          name: "macos-kernel-isolation",
          execute: () => {
            receipt = runExecutionPlan({
              plan: executionPlan,
              root: process.cwd(),
              resultFile: executionResultFile,
              reporter: resolve("scripts/quality-test-reporter.mjs"),
              buildSha256,
              verifyUnchanged: () => finalGroup.verifyUnchanged(),
            }).receipt;
          },
        },
      ]);
      const group = JSON.parse(readFileSync(resolve(jobRoot, "candidate-group.json")));
      writeFileSync(
        resolve(jobRoot, "quality-macos-result.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            core: candidate.core,
            groupId: group.groupId,
            plan: executionPlan,
            sdk,
            buildSha256,
            admission: finalGroup.receipt,
            receipt: receipt ?? JSON.parse(readFileSync(executionResultFile)),
          },
          null,
          2,
        ) + "\n",
      );
      finalGroup.verifyUnchanged();
      writeFileSync(
        resolve(output, "checks.json"),
        JSON.stringify({ admission: finalGroup.receipt, checks }, null, 2) + "\n",
      );
      if (checks.some((check) => check.status !== "passed"))
        refuse("QUALITY_CHECKS_FAILED", JSON.stringify(checks));
      console.log(
        JSON.stringify({
          status: "passed",
          phase: values.phase,
          runtime: "macos-kernel-isolation",
        }),
      );
      process.exit(0);
    }
    writeFileSync(
      resolve(dirname(dirname(process.cwd())), "quality-test-plan.json"),
      JSON.stringify(plan, null, 2) + "\n",
    );
    if (prepareInputs)
      await prepareQualityUpstreams(existsSync(upstream) ? realpathSync(upstream) : upstream);
    await bindQualityUpstreamInputs(upstream, resolve("../../upstream-inputs"), {
      prepare: prepareInputs === true,
    });
    run(process.execPath, [
      resolve(workbench.path, "scripts/verify-candidate-input.mjs"),
      "--input",
      resolve(input),
      "--checkout",
      process.cwd(),
      "--final-group-sha256",
      values["final-group-sha256"],
    ]);
    if (
      Number(process.versions.node.split(".")[0]) !== 24 ||
      execFileSync("corepack", ["pnpm", "--version"], {
        encoding: "utf8",
      }).trim() !== "11.27.0"
    )
      refuse("QUALITY_TOOLCHAIN_REQUIRED", "Node 24 / pnpm 11.27.0");
    for (const entry of candidate.repositories) {
      const source = spawnSync("git", ["-C", entry.path, "remote", "get-url", "source"], {
        encoding: "utf8",
      });
      if (source.status !== 0 && !prepareInputs)
        refuse("QUALITY_SOURCE_REMOTE_REQUIRED", entry.repo);
      if (source.status !== 0)
        run("git", [
          "-C",
          entry.path,
          "remote",
          "add",
          "source",
          "https://github.com/CleverC2200/" + entry.repo + ".git",
        ]);
    }
    if (prepareInputs) {
      if (existsSync(preparedWorkbench))
        refuse(
          "QUALITY_PREPARED_ALREADY_EXISTS",
          "use a fresh owned job directory or verify the existing frozen assets",
        );
      const npmManager = JSON.parse(
        readFileSync(resolve(workbench.path, "package.json")),
      ).packageManager;
      if (
        npmManager !== "npm@11.11.0" ||
        execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() !== npmManager.slice(4)
      )
        refuse("QUALITY_TOOLCHAIN_REQUIRED", "Workbench npm@11.11.0");
      run("git", [
        "-C",
        workbench.path,
        "worktree",
        "add",
        "--detach",
        preparedWorkbench,
        workbench.head,
      ]);
      run(
        "npm",
        ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
        preparedWorkbench,
      );
      if (plan.runtime)
        run(
          "npm",
          ["ci", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund"],
          resolve(preparedWorkbench, "business/inventory-apsplan/source"),
        );
      run(
        "corepack",
        ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
        manage.path,
      );
      run("corepack", [
        "pnpm",
        "install",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--prefer-offline",
      ]);
    }
    if (stagedPhase) {
      if (preparing) stages.finish();
      if (values.stage === "prepare") process.exit(0);
      if (values.stage === "full") stages.start("build");
    }
    if (building && values["prepare-inputs"]) {
      if (plan.runtime)
        run("npm", ["run", "build:core"], preparedWorkbench, {
          DSH_TYPECHECK_PROJECT: "tsconfig.official.json",
          APS_BUILD_MODE: "mock",
        });
      else {
        // Static GEA checks consume Workbench's public declarations too. Emit them
        // from the admitted source instead of trusting checked-in build outputs.
        run(
          process.execPath,
          [
            "node_modules/typescript/bin/tsc",
            "-p",
            "tsconfig.official.json",
            "--noEmit",
            "false",
            "--emitDeclarationOnly",
            "true",
          ],
          preparedWorkbench,
        );
        // Node-only Host tests import this public pure-model entry at runtime.
        // Keep it on the same source as the declarations without building the UI.
        run(
          process.execPath,
          [
            "node_modules/esbuild/bin/esbuild",
            "src/sales-plan.ts",
            "--bundle",
            "--format=esm",
            "--platform=node",
            "--packages=external",
            "--outfile=lib/sales-plan.js",
          ],
          preparedWorkbench,
        );
      }
      run("corepack", ["pnpm", "build"], manage.path);
      run("corepack", ["pnpm", "build:plugin"]);
      if (plan.runtime) {
        const prepared = await readPreparedWorkbench({
          source: workbench.path,
          prepared: preparedWorkbench,
          head: workbench.head,
          manage,
        });
        finalGroup?.verifyUnchanged();
        writeFileSync(workbenchReceipt, JSON.stringify(prepared, null, 2) + "\n");
        await prepareWorkbenchAssets({
          source: workbench.path,
          prepared: preparedWorkbench,
          head: workbench.head,
          manage,
          receipt: workbenchReceipt,
          assets: workbenchAssetRoot,
        });
      }
    }
    if (plan.runtime) {
      const workbenchAssets = await verifyPreparedWorkbench({
        source: workbench.path,
        prepared: preparedWorkbench,
        head: workbench.head,
        manage,
        receipt: workbenchReceipt,
      });
      const upstreamRecord = await verifyQualityUpstreams(upstream);
      const sourcesFile = resolve(dirname(dirname(process.cwd())), "profile-source-inputs.json");
      const records = candidate.repositories.map((entry) => ({
        repo: entry.repo,
        source: entry.path,
        commit: entry.head,
        dependencies: resolve(entry.path, "node_modules"),
      }));
      Object.assign(
        records.find((entry) => entry.repo === "dsh-agent-workbench"),
        {
          assets: workbenchAssetRoot,
          files: workbenchAssets.files,
          dependencies: resolve(preparedWorkbench, "node_modules"),
        },
      );
      records.push(
        {
          repo: "dsh-genui",
          source: resolve(upstream, "upstream-reference/dsh-genui"),
          commit: upstreamRecord.genui.head,
          assets: resolve(upstream, "upstream-assets/genui-0.11.3"),
          files: upstreamRecord.genui.files,
          dependencies: resolve(process.cwd(), "node_modules"),
        },
        {
          repo: "dsh-better-sidebar",
          source: resolve(upstream, "upstream-reference/dsh-better-sidebar"),
          commit: upstreamRecord.sidebar.head,
          dependencies: resolve(upstream, "upstream-reference/dsh-better-sidebar/node_modules"),
        },
      );
      await resolveSourceInputs(records, { requireEntries: true });
      finalGroup?.verifyUnchanged();
      writeFileSync(sourcesFile, JSON.stringify(records, null, 2) + "\n");
      process.env.GEA_TEST_SOURCE_INPUTS = sourcesFile;
      process.env.GEA_TEST_CANDIDATE = resolve(input);
      process.env.GEA_TEST_CANDIDATE_SHA256 = finalGroup.receipt.inputSha256;
      process.env.GEA_TEST_SOURCE_CORE = "1";
    }
    writeSourceWindow(
      candidate,
      core,
      resolve(dirname(dirname(process.cwd())), "source-window-inputs.json"),
    );
    process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(
      dirname(dirname(process.cwd())),
      ".quality-browser",
    );
    if (building && plan.browser && values["prepare-inputs"]) {
      const budgetMs = browserPreparationBudget(values["browser-preparation-timeout-ms"]);
      const args = [
        "pnpm",
        "exec",
        "playwright",
        "install",
        ...(process.platform === "linux" ? ["--with-deps"] : []),
        "chromium",
      ];
      const browserInstall = installCommands({ errorCode: "QUALITY_BROWSER_PREPARATION_FAILED" });
      const release = createRequire(import.meta.url)("./build-admission.mjs").acquireBuild({
        operation: "prepare",
        cwd: process.cwd(),
      });
      try {
        finalGroup?.verifyUnchanged();
        const execute = () =>
          browserInstall.run("corepack", args, process.cwd(), {
            timeoutMs: budgetMs,
            forwardOutput: true,
          });
        if (stages)
          await stages.step(
            "browser-install",
            { command: ["corepack", ...args], budgetMs },
            execute,
          );
        else await execute();
        finalGroup?.verifyUnchanged();
      } finally {
        await browserInstall.close();
        release();
      }
    }
    if (plan.browser) {
      const { chromium } = await import("@playwright/test");
      const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
      const executable = chromium.executablePath();
      if (!existsSync(executable)) refuse("QUALITY_BROWSER_REQUIRED", executable);
      const dryRun = execFileSync(
        "corepack",
        ["pnpm", "exec", "playwright", "install", "--dry-run", "chromium"],
        {
          encoding: "utf8",
        },
      );
      const browserDirectories = [
        ...new Set(
          [...dryRun.matchAll(/Install location:\s+(.+)/g)].map((match) => match[1].trim()),
        ),
      ];
      if (browserDirectories.length !== 3)
        refuse("QUALITY_BROWSER_REQUIRED", "Chromium, headless shell and FFmpeg");
      const browserFiles = {};
      for (const directory of browserDirectories) {
        if (!existsSync(directory)) refuse("QUALITY_BROWSER_REQUIRED", directory);
        const location = relative(realpathSync(browserRoot), realpathSync(directory));
        if (location.startsWith(".." + sep) || isAbsolute(location))
          refuse("QUALITY_BROWSER_REQUIRED", directory);
        const files = await resourceDigests(directory);
        if (Object.keys(files).length === 0) refuse("QUALITY_BROWSER_REQUIRED", directory);
        for (const [file, digest] of Object.entries(files))
          browserFiles[resolve(directory, file)] = digest;
      }
      finalGroup?.verifyUnchanged();
      const browserReceipt = resolve(jobRoot, "browser-preparation.json");
      const preparedBrowser = {
        root: browserRoot,
        executable,
        directories: browserDirectories,
        playwright: JSON.parse(readFileSync(resolve("node_modules/@playwright/test/package.json")))
          .version,
        lockSha256: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
        files: browserFiles,
      };
      if (building) writeFileSync(browserReceipt, JSON.stringify(preparedBrowser, null, 2) + "\n");
      else if (
        JSON.stringify(JSON.parse(readFileSync(browserReceipt))) !== JSON.stringify(preparedBrowser)
      )
        refuse("QUALITY_BROWSER_PREPARATION_CHANGED");
    }
    if (building && plan.files.includes("scripts/package-desktop.test.mjs"))
      run(process.execPath, ["scripts/build-desktop-tools.mjs"]);
    if (
      plan.files.some((file) =>
        ["scripts/package-smoke.test.mjs", "scripts/page-interaction-package.test.mjs"].includes(
          file,
        ),
      )
    ) {
      const pnpm = resolve(core, "apps/desktop/node_modules/pnpm/bin/pnpm.mjs");
      if (!existsSync(pnpm)) refuse("QUALITY_PACKAGE_PNPM_REQUIRED", pnpm);
      process.env.GEA_PACKAGE_PNPM = pnpm;
    }
    if (stagedPhase) {
      if (building) {
        // Freeze the prepared package outputs before later processes can execute checks.
        stages.record.artifacts = {};
        for (const { root } of qualityBuildOutputs(jobRoot))
          stages.record.artifacts[root] = await resourceDigests(root);
        verifyQualityBuildInventory(jobRoot, stages.record.artifacts);
        stages.finish();
        if (values.stage === "build") process.exit(0);
      } else {
        verifyQualityBuildInventory(jobRoot, stages.record.artifacts);
        for (const [root, expected] of Object.entries(stages.record.artifacts ?? {}))
          if (JSON.stringify(await resourceDigests(root)) !== JSON.stringify(expected))
            refuse("QUALITY_STAGE_ARTIFACT_CHANGED", root);
      }
      if (values.stage === "summary") {
        verifyExecutionResults({
          plan: executionPlan,
          receipt: JSON.parse(readFileSync(executionResultFile)),
          buildSha256: executionDigest(stages.record.artifacts),
        });
        stages.summarize({ workflowResults: process.env.CI === "true" });
        process.exit(0);
      }
      if (["full", "checks"].includes(values.stage)) {
        if (values.stage === "full") stages.start("checks");
        const checks = runQualityChecks([
          {
            name: "final-group",
            execute: () =>
              run("corepack", ["pnpm", "test:final-group"], process.cwd(), {
                GEA_FINAL_GROUP_WORKBENCH_SOURCE: workbench.path,
                GEA_FINAL_GROUP_MANAGE_SOURCE: manage.path,
                GEA_FINAL_GROUP_CORE_SOURCE: core,
              }),
          },
          {
            name: "fast",
            execute: () =>
              run("corepack", [
                "pnpm",
                "quality:fast",
                "--checks-only",
                ...(values["source-check-receipt"]
                  ? [
                      "--source-receipt-in",
                      values["source-check-receipt"],
                      "--input-sha256",
                      finalGroup.receipt.inputSha256,
                    ]
                  : []),
              ]),
          },
        ]);
        stages.record.checks.push(...checks);
        const failed = checks.some((check) => check.status !== "passed");
        stages.finish(failed ? Error("QUALITY_CHECKS_FAILED") : undefined);
        if (failed) refuse("QUALITY_CHECKS_FAILED", JSON.stringify(checks));
        if (values.stage === "checks") {
          process.exit(0);
        }
      }
      if (["full", "tests"].includes(values.stage)) {
        if (values.stage === "full") stages.start("tests");
        const checks = runQualityChecks([
          {
            name: "required-and-affected",
            execute: () =>
              runExecutionPlan({
                plan: executionPlan,
                shardId: values["test-shard"],
                root: process.cwd(),
                resultFile: executionResultFile,
                reporter: resolve("scripts/quality-test-reporter.mjs"),
                buildSha256: executionDigest(stages.record.artifacts),
                verifyUnchanged: () => finalGroup.verifyUnchanged(),
                nodeArgs: plan.files.some((file) => file.endsWith(".contract.mjs"))
                  ? ["--expose-internals"]
                  : [],
              }),
          },
        ]);
        stages.record.checks.push(...checks);
        stages.finish(
          checks.some((check) => check.status !== "passed")
            ? Error("QUALITY_CHECKS_FAILED")
            : undefined,
        );
        if (values.stage === "tests") {
          if (checks.some((check) => check.status !== "passed"))
            refuse("QUALITY_CHECKS_FAILED", JSON.stringify(checks));
          process.exit(0);
        }
      }
      stages.summarize();
    }
  }
  console.log(
    JSON.stringify({
      status: "passed",
      phase: values.phase,
      runtime:
        values.phase === "quality" && profileTestsSelected
          ? "loopback-source-profile-tests"
          : "not-observed",
    }),
  );
} catch (error) {
  stages?.finish(error);
  console.error(error.message);
  process.exitCode = 1;
}

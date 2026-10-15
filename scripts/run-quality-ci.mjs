import { qualityStageRun } from "./quality-ci-stages.mjs";
import { runQualityChecks } from "./run-quality-checks.mjs";
/** Public source-event admission and fail-closed workflow aggregation. */
import { parseArgs } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync, existsSync, mkdirSync } from "node:fs";
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
import { macosIsolationTests, selectPlatformTests } from "./ci-platform-tests.mjs";
const candidatePhases = new Set([
  "quality",
  "business-profile",
  "mcp-client-repair",
  "knowledge-merge",
  "prepare",
  "verify-input",
  "macos-isolation",
]);
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
      "final-group-sha256": { type: "string" },
      "final-group-workbench": { type: "string" },
    },
  });
  if (!["full", "prepare", "build", "checks", "tests", "summary"].includes(values.stage))
    refuse("QUALITY_STAGE_REQUIRED", values.stage);
  if (
    values.stage !== "full" &&
    !["quality", "business-profile", "mcp-client-repair", "knowledge-merge"].includes(values.phase)
  )
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
  } else if (values.phase === "final") {
    for (const key of ["QUALITY_SCOPE_RESULT", "QUALITY_GATE_RESULT", "QUALITY_ISOLATION_RESULT"])
      if (process.env[key] !== "success")
        throw Error("QUALITY_REQUIRED: " + key + "=" + (process.env[key] ?? "missing"));
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
    process.env.QUALITY_POLICY_WORKBENCH = workbench.path;
    if (
      (values["prepare-inputs"] && ["full", "prepare"].includes(values.stage)) ||
      values.phase === "macos-isolation"
    )
      await prepareWorkbenchGeaAuthority({
        workbench: workbench.path,
        gea: own.path,
      });

    let knowledgePlan;
    if (values.phase === "knowledge-merge") {
      const {
        knowledgeMergeLane,
        validateKnowledgeMergeGroup,
        knowledgeMergeTests,
        knowledgeMergeAuthorization,
      } = await import("./knowledge-merge-ci.mjs");
      if (!knowledgeMergeLane(process.cwd())) refuse("KNOWLEDGE_MERGE_EVENT_REQUIRED");
      validateKnowledgeMergeGroup(candidate.repositories);
      knowledgePlan = {
        lane: "knowledge-merge",
        runtime: false,
        browser: false,
        acceptance: "targeted; 205-file selection not run",
        authorization: knowledgeMergeAuthorization,
        files: knowledgeMergeTests,
      };
    }
    if (values.phase === "business-profile" || values.phase === "mcp-client-repair") {
      const { loadBusinessProfilePolicy } = await import("./business-profile-ci.mjs");
      const policy = await loadBusinessProfilePolicy(workbench.path);
      if (values.phase === "business-profile")
        policy.validateBusinessProfileGroup(candidate.repositories);
      else policy.validateMcpClientGroup(candidate.repositories);
    }
    if (values.phase === "macos-isolation" && process.platform !== "darwin")
      refuse("QUALITY_MACOS_ISOLATION_REQUIRED");
    const { selectCiTests } = await import(
      pathToFileURL(resolve(workbench.path, "scripts/ci-test-plan.mjs"))
    );
    const baseline = JSON.parse(readFileSync("scripts/quality-peer-baseline.json"));
    const selectedPlan =
      knowledgePlan ??
      (values.phase === "macos-isolation"
        ? {
            lane: "macos-isolation",
            runtime: false,
            browser: false,
            files: [...macosIsolationTests],
          }
        : values.phase === "mcp-client-repair"
          ? {
              lane: "mcp-client-repair",
              runtime: false,
              browser: false,
              files: [
                "tests/cube-direct-mcp.test.mjs",
                "tests/cube-new.test.mjs",
                "tests/mcp-response.test.mjs",
                "tests/gateway-mcp.test.mjs",
                "tests/gateway-handshake.test.mjs",
                "tests/host-config.test.mjs",
                "tests/business-identity-client.test.mjs",
                "tests/controlled-execution.test.mjs",
                "tests/plugin-sql-cancel.test.mjs",
                "scripts/business-profile-ci.test.mjs",
                "scripts/run-quality-ci.test.mjs",
                "scripts/run-quality-checks.test.mjs",
              ],
            }
          : values.phase === "business-profile"
            ? {
                lane: "business-profile",
                runtime: false,
                browser: false,
                files: [
                  "tests/api-log.test.mjs",
                  "tests/gea-messages.test.mjs",
                  "tests/gea-reasoning.test.mjs",
                  "tests/gea-stream.test.mjs",
                  "tests/prompt-runtime.test.mjs",
                  "tests/controlled-execution.test.mjs",
                  "tests/cube-new.test.mjs",
                  "tests/cube-direct-mcp.test.mjs",
                  "tests/model-http.test.mjs",
                  "tests/gateway-mcp.test.mjs",
                  "scripts/business-profile-ci.test.mjs",
                  "tests/plugin-update-controller.contract.mjs",
                  "tests/plugin-update-integration.contract.mjs",
                  "scripts/build.test.mjs",
                  "scripts/deliver-packages.test.mjs",
                  "scripts/package-version-gate.test.mjs",
                  "scripts/plugin-package-version.test.mjs",
                  "tests/plugin-release.test.mjs",
                  "tests/plugin-release-source.test.mjs",
                  "tests/optional-companion-manifest.test.mjs",
                ],
              }
            : selectCiTests({
                repositories: candidate.repositories,
                repo: "dsh-gea-plugin",
                base:
                  process.env.QUALITY_BASE_SHA ||
                  baseline.repositories.find((entry) => entry.repo === "dsh-gea-plugin").head,
              }));
    const plan = selectPlatformTests(selectedPlan);
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
    const stagedPhase = [
      "quality",
      "business-profile",
      "mcp-client-repair",
      "knowledge-merge",
    ].includes(values.phase);
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
    if (building && values.phase === "business-profile" && process.platform !== "win32")
      run(process.execPath, ["native/system/scripts/build.ts", "--host-addon-only"], core);
    finalGroup?.verifyUnchanged();
    process.env.GEA_PLUGIN_UPDATE_SDK = core;
    process.env.GEA_PLUGIN_UPDATE_CANDIDATE_CORE = core;
    if (values.phase === "macos-isolation") {
      const output = resolve(".runtime/quality-isolation");
      mkdirSync(output, { recursive: true });
      writeFileSync(resolve(output, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
      writeSourceWindow(candidate, core, resolve(output, "source-window-inputs.json"));
      const checks = runQualityChecks([
        {
          name: "macos-kernel-isolation",
          execute: () =>
            run(process.execPath, [
              "--test",
              "--test-reporter=./scripts/quality-test-reporter.mjs",
              ...macosIsolationTests,
            ]),
        },
      ]);
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
      run("corepack", ["pnpm", "build"], manage.path);
      run("corepack", ["pnpm", "build:plugin"]);
      if (plan.runtime) {
        const prepared = await readPreparedWorkbench({
          source: workbench.path,
          prepared: preparedWorkbench,
          head: workbench.head,
        });
        finalGroup?.verifyUnchanged();
        writeFileSync(workbenchReceipt, JSON.stringify(prepared, null, 2) + "\n");
        await prepareWorkbenchAssets({
          source: workbench.path,
          prepared: preparedWorkbench,
          head: workbench.head,
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
    if (building && plan.browser && values["prepare-inputs"])
      run("corepack", [
        "pnpm",
        "exec",
        "playwright",
        "install",
        ...(process.platform === "linux" ? ["--with-deps"] : []),
        "chromium",
      ]);
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
        for (const root of [resolve("lib"), resolve(manage.path, "lib")])
          stages.record.artifacts[root] = await resourceDigests(root);
        stages.finish();
        if (values.stage === "build") process.exit(0);
      } else {
        for (const [root, expected] of Object.entries(stages.record.artifacts ?? {}))
          if (JSON.stringify(await resourceDigests(root)) !== JSON.stringify(expected))
            refuse("QUALITY_STAGE_ARTIFACT_CHANGED", root);
        if (Object.keys(stages.record.artifacts ?? {}).length !== 2)
          refuse("QUALITY_STAGE_ARTIFACT_REQUIRED");
      }
      if (values.stage === "summary") {
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
            execute: () => run("corepack", ["pnpm", "quality:fast", "--checks-only"]),
          },
        ]);
        stages.record.checks.push(...checks);
        const failed = checks.some((check) => check.status !== "passed");
        stages.finish(failed ? Error("QUALITY_CHECKS_FAILED") : undefined);
        if (values.stage === "checks") {
          if (failed) refuse("QUALITY_CHECKS_FAILED", JSON.stringify(checks));
          process.exit(0);
        }
      }
      if (["full", "tests"].includes(values.stage)) {
        if (values.stage === "full") stages.start("tests");
        const checks = runQualityChecks([
          {
            name: "required-and-affected",
            execute: () =>
              run(process.execPath, [
                ...(values.phase === "business-profile" ? ["--expose-internals"] : []),
                ...(values.phase === "mcp-client-repair" ? ["--experimental-transform-types"] : []),
                "--test",
                // Files have separate processes; fixtures allocate unique Homes and loopback ports.
                "--test-concurrency=2",
                "--test-reporter=./scripts/quality-test-reporter.mjs",
                ...plan.files,
              ]),
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

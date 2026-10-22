import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  macosIsolationTests,
  selectPlatformTests,
  requiresDependencyReview,
} from "./ci-platform-tests.mjs";
import { parse } from "yaml";

test("all admitted quality lanes reuse the same fixed SDK cache without weakening source admission", () => {
  const workflow = parse(readFileSync(".github/workflows/quality.yml", "utf8"));
  const producer = workflow.jobs.gates;
  const steps = producer.steps;
  const paths = steps.find((step) => step.id === "sdk-paths");
  const restore = steps.find((step) => step.id === "sdk-cache");
  const save = steps.find((step) => step.name?.startsWith("Save verified SDK cache"));
  assert.equal(paths.if, undefined);
  assert.equal(restore.if, undefined);
  assert.doesNotMatch(save.if, /business-lane/);
  assert.match(save.if, /steps\.quality-build\.outcome == 'success'/);
  assert.match(save.if, /steps\.sdk-cache\.outputs\.cache-hit != 'true'/);
  assert.equal(save.with.key, "${{ steps.sdk-cache.outputs.cache-primary-key }}");
  assert.equal(restore.with.path, "${{ steps.sdk-paths.outputs.paths }}");
  assert.equal(restore.with["restore-keys"], undefined);
  for (const input of [
    "github.repository",
    "runner.os",
    "runner.arch",
    "steps.node.outputs.node-version",
    "matrix.core",
  ])
    assert.ok(restore.with.key.includes(input), input);
  for (const input of [
    "prepare-official-sdk.mjs",
    "sdk-artifact-cache.mjs",
    "supported-cores.json",
    "pnpm-lock.yaml",
  ])
    assert.ok(restore.with.key.includes(input), input);
  const admission = steps.findIndex((step) => step.run?.includes("--phase verify-input"));
  const plan = steps.findIndex((step) => step.id === "quality-plan");
  const preparation = steps.findIndex((step) => step.id === "quality-prepare");
  assert.ok(admission >= 0 && admission < plan && plan < steps.indexOf(paths));
  assert.ok(steps.indexOf(paths) < steps.indexOf(restore) && steps.indexOf(restore) < preparation);
  assert.equal(producer.env.QUALITY_REUSE_SDK, "true");
  assert.match(steps[preparation].run, /--prepare-sdk.*--stage prepare/);
});

const run = (args, environment = {}) => {
  const env = { ...process.env };
  for (const name of [
    "QUALITY_SCOPE_ALLOWED",
    "QUALITY_SCOPE_RESULT",
    "QUALITY_GATE_RESULT",
    "QUALITY_ISOLATION_RESULT",
    "QUALITY_CANDIDATE",
    "QUALITY_EXPECTED_SHA",
    "CI",
  ])
    delete env[name];
  return spawnSync(process.execPath, ["scripts/run-quality-ci.mjs", ...args], {
    encoding: "utf8",
    env: { ...env, ...environment },
  });
};
test("the public CI scope/final entry rejects missing, failed, skipped and cancelled gates", () => {
  assert.equal(run(["--phase", "scope"], { QUALITY_SCOPE_ALLOWED: "true" }).status, 0);
  for (const scope of ["", "false"])
    assert.equal(run(["--phase", "scope"], { QUALITY_SCOPE_ALLOWED: scope }).status, 1);
  const good = {
    QUALITY_SCOPE_RESULT: "success",
    QUALITY_GATE_RESULT: "success",
    QUALITY_ISOLATION_RESULT: "success",
  };
  assert.equal(run(["--phase", "final"], good).status, 1);
  for (const key of Object.keys(good))
    for (const result of ["", "skipped", "cancelled", "failure"])
      assert.equal(run(["--phase", "final"], { ...good, [key]: result }).status, 1);
});
test("candidate execution requires the one explicit hashed public admission and input phase cannot write legacy peers", () => {
  for (const phase of ["quality", "prepare", "verify-input", "macos-isolation"])
    assert.match(run(["--phase", phase]).stderr, /CANDIDATE_FINAL_GROUP_REQUIRED/);
  const directory = mkdtempSync(join(tmpdir(), "gea-quality-input-"));
  try {
    const created = run(["--phase", "input", "--root", directory, "--sha", "a".repeat(40)]);
    assert.equal(created.status, 1);
    assert.match(created.stderr, /CANDIDATE_INPUT_REQUIRED/);
    assert.equal(existsSync(join(directory, "candidate-input.json")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the workflow binds full source history and the same public quality command", () => {
  const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
  assert.doesNotMatch(workflow, /self-hosted|pull_request_target/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(
    workflow,
    /QUALITY_EXPECTED_SHA: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/,
  );
  const checkouts = (workflow.match(/uses: actions\/checkout@v7/g) ?? []).length;
  assert.equal((workflow.match(/fetch-depth: 0/g) ?? []).length, checkouts);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, checkouts);
  assert.match(workflow, /node scripts\/run-quality-ci.mjs --prepare-sdk.*--prepare-inputs/);
  assert.match(readFileSync("scripts/run-quality-ci.mjs", "utf8"), /APS_BUILD_MODE: ["']mock["']/);
  assert.match(workflow, /if: always\(\)/);
  assert.deepEqual(parse(workflow).jobs["candidate-quality"].needs, [
    "candidate-scope",
    "source-plan",
    "gates",
    "plan-test-shards",
    "test-shards",
    "macos-isolation",
    "windows-plugin-update",
    "dependency-review",
  ]);
  assert.match(workflow, /node scripts\/run-quality-ci.mjs --phase final/);
  assert.match(workflow, /PLUGIN_SPLIT_READ_TOKEN/);
  assert.match(workflow, /npm install --global npm@11\.11\.0/);
  assert.match(workflow, /ciCores\(["']required["']\)\.map\(core => core\.head\)/);
  assert.doesNotMatch(workflow, /ciCores\(["']compatibility["']\)/);
  const compatibility = readFileSync(".github/workflows/compatibility.yml", "utf8");
  assert.match(compatibility, /^name: candidate-compatibility$/m);
  assert.match(compatibility, /ciCores\(["']compatibility["']\)\.map\(core => core\.head\)/);
  assert.doesNotMatch(compatibility, /^ {2}(push|pull_request):/m);
  assert.match(workflow, /fromJSON\(needs\.candidate-scope\.outputs\.cores\)/);
  assert.match(workflow, /CORE_HEAD: \$\{\{ matrix\.core \}\}/);
  assert.match(workflow, /--core-head "\$CORE_HEAD"/);
  const scripts = JSON.parse(readFileSync("package.json")).scripts;
  assert.doesNotMatch(scripts["quality:fast"], /candidate:verify|run-quality-ci/);
  assert.equal(scripts["quality:ci"], "node scripts/run-quality-ci.mjs");
});

test("all candidate entry modes reject absent or forged hash admission before source effects", () => {
  for (const phase of ["quality", "prepare", "verify-input", "macos-isolation"])
    for (const hash of [undefined, "", "main", "A".repeat(64), "a".repeat(64) + "\n"])
      assert.match(
        run([
          "--phase",
          phase,
          "--input",
          "/declared/input",
          "--final-group-workbench",
          "/declared/workbench",
          ...(hash === undefined ? [] : ["--final-group-sha256", hash]),
        ]).stderr,
        /CANDIDATE_FINAL_GROUP_REQUIRED/,
      );
  const source = readFileSync("scripts/run-quality-ci.mjs", "utf8");
  assert.doesNotMatch(
    source,
    /c5a5bc64fade154bf5b468f0d848974ac308823a|cdd2d6520a7790ca1a1c658d1fa71e07c651cd3f|finalGroup\?\.manifest/,
  );
  assert.match(source, /GEA_TEST_CANDIDATE_SHA256 = finalGroup.receipt.inputSha256/);
});

test("hosted refs consume the public reader outputs and raw history remains readable", () => {
  const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
  for (const key of ["workbench-sha", "manage-sha"])
    assert.ok(workflow.includes("ref: ${{ needs.candidate-scope.outputs." + key + " }}"));
  const source = readFileSync("scripts/run-quality-ci.mjs", "utf8");
  const history = source.match(/const history = resolve\(\s*"([^"\n]+)",?\s*\)/)?.[1];
  assert.ok(history?.endsWith("navigation-r7-setup-failure.json.raw"));
  const bytes = readFileSync(history);
  const original = execFileSync("git", [
    "show",
    "87e53cbff32aba61318a666f41d0272b4f55c008:" + history.replace(/\.raw$/, ""),
  ]);
  assert.deepEqual(
    bytes,
    original,
    "raw historical evidence retains exact original accepted bytes",
  );
});

test("reader bootstrap binds the actual event and refuses mutable, malformed or absent Workbench input", () => {
  const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
  const inline = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(inline, "bootstrap must execute before fixed repository checkout");
  const code = inline[1].replace(/^          /gm, "");
  const directory = mkdtempSync(join(tmpdir(), "gea-reader-bootstrap-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    writeFileSync(join(directory, "fixture"), "own event\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync(
      "git",
      ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "event"],
      { cwd: directory },
    );
    const own = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    const valid = {
      QUALITY_OWN_REPO: "dsh-gea-plugin",
      GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
      QUALITY_SCOPE_ALLOWED: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      QUALITY_EXPECTED_SHA: own,
      QUALITY_GROUP_WORKBENCH: "b".repeat(40),
    };
    const output = join(directory, "output");
    const execute = (env) =>
      spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: directory,
        encoding: "utf8",
        env: { ...process.env, ...env, GITHUB_OUTPUT: output },
      });
    for (const value of [
      "",
      "main",
      "A".repeat(40),
      "a".repeat(39),
      "$(touch injected)",
      "a".repeat(40) + "\n",
    ]) {
      const result = execute({ ...valid, QUALITY_GROUP_WORKBENCH: value });
      assert.equal(result.status, 1, JSON.stringify(value));
      assert.match(result.stderr, /CANDIDATE_BASELINE_REQUIRED/);
    }
    const mismatch = execute({
      ...valid,
      QUALITY_EXPECTED_SHA: "d".repeat(40),
    });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /CANDIDATE_EVENT_MISMATCH/);
    const absent = execute({ ...valid, GITHUB_EVENT_NAME: "push" });
    assert.equal(absent.status, 1, "source events require committed baseline");
    assert.equal(execute(valid).status, 0);
    assert.equal(readFileSync(output, "utf8"), `workbench-sha=${valid.QUALITY_GROUP_WORKBENCH}\n`);
    assert.match(workflow, /scope-peer\/dsh-agent-workbench\/scripts\/read-hosted-peer-input\.mjs/);
    for (const name of ["source-kind", "baseline-id"])
      assert.ok(workflow.includes("steps.group.outputs." + name));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dispatch retains its frozen run while a new source event cancels its obsolete branch run", () => {
  const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
  assert.match(workflow, /github\.ref \}\}/);
  for (const input of ["gea_sha", "workbench_sha", "manage_sha"]) {
    assert.match(
      workflow,
      new RegExp(
        input + ":\\n        description: [^\\n]+\\n        required: true\\n        type: string",
      ),
    );
  }
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.run_id/);
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/,
  );
  assert.match(
    workflow,
    /repository: CleverC2200\/deepseek-harness\n          ref: \$\{\{ matrix\.core \}\}\n          fetch-depth: 0\n          path: source\/official-core/,
  );
  assert.match(
    workflow,
    /--repo dsh-gea-plugin --root "\$GITHUB_WORKSPACE" --core-head "\$CORE_HEAD" --workbench-source/,
  );
  assert.match(
    workflow,
    /--prepare-sdk --core-source "\$GITHUB_WORKSPACE\/source\/official-core" --prepare-inputs --core-head "\$CORE_HEAD" --input "\$QUALITY_CANDIDATE" --final-group-sha256 "\$INPUT_SHA256" --final-group-workbench/,
  );
  assert.match(workflow, /candidate-group\.json/);
  assert.match(
    workflow,
    /QUALITY_SOURCE_KIND: \$\{\{ needs\.candidate-scope\.outputs\.source-kind \}\}/,
  );
  assert.doesNotMatch(workflow, /needs\.candidate-scope\.outputs\.[a-z-]+ \|\|/);
  for (const run of workflow.split(/\n      - /).filter((step) => step.includes("run:"))) {
    const shell = run.slice(run.indexOf("run:"));
    assert.doesNotMatch(
      shell,
      /\$\{\{ inputs\./,
      "dispatch input must be passed through environment variables",
    );
  }
});

test("selected package contracts prepare current desktop outputs and bind the admitted Core pnpm", () => {
  const source = readFileSync("scripts/run-quality-ci.mjs", "utf8");
  assert.match(source, /plan\.files\.includes\("scripts\/package-desktop\.test\.mjs"\)/);
  assert.match(source, /run\(process\.execPath, \["scripts\/build-desktop-tools\.mjs"\]\)/);
  assert.match(
    source,
    /const pnpm = resolve\(core, "apps\/desktop\/node_modules\/pnpm\/bin\/pnpm\.mjs"\)/,
  );
  assert.match(source, /process\.env\.GEA_PACKAGE_PNPM = pnpm/);
  assert.ok(
    source.indexOf("process.env.GEA_PACKAGE_PNPM = pnpm") <
      source.indexOf('name: "required-and-affected"'),
  );
});

test("Linux and Windows retain Host schema coverage and delegate keychain and sandbox execution to macOS", () => {
  const files = [
    "tests/gateway-handshake.test.mjs",
    "tests/host-config.test.mjs",
    "scripts/isolated-validation.test.mjs",
    "tests/host-config-keychain.test.mjs",
    "tests/controlled-execution.test.mjs",
  ];
  assert.deepEqual(macosIsolationTests, [
    "scripts/isolated-validation.test.mjs",
    "tests/host-config-keychain.test.mjs",
  ]);
  const plan = {
    files,
    runtime: true,
    browser: false,
    reasons: { required: [...files] },
  };
  for (const platform of ["linux", "win32"]) {
    const selected = selectPlatformTests(plan, platform);
    assert.deepEqual(selected.files, [files[0], files[1], files[4]]);
    assert.deepEqual(selected.reasons, plan.reasons);
    assert.deepEqual(selected.platformTasks, [
      {
        platform: "darwin",
        phase: "macos-isolation",
        files: [...macosIsolationTests],
      },
    ]);
    assert.equal(selected.runtime, true);
  }
  assert.deepEqual(selectPlatformTests(plan, "darwin").files, files);
  assert.deepEqual(plan.files, files, "selection does not mutate the authoritative required pool");
  assert.deepEqual(
    selectPlatformTests({ files: [files[0]], runtime: false }, "linux").platformTasks[0].files,
    macosIsolationTests,
    "even a narrow source lane retains the mandatory platform gate",
  );
});

test("both source and compatibility workflows require actual same-tuple macOS execution", () => {
  for (const file of ["quality", "compatibility"]) {
    const source = readFileSync(`.github/workflows/${file}.yml`, "utf8");
    const macos = source.slice(
      source.indexOf("  macos-isolation:\n"),
      source.indexOf("  candidate-", source.indexOf("  macos-isolation:\n")),
    );
    assert.match(macos, /runs-on: macos-latest/);
    assert.match(macos, /needs: (?:\[)?candidate-scope/);
    for (const entry of ["gea", "manage", "workbench"])
      assert.ok(macos.includes(`needs.candidate-scope.outputs.${entry}-sha`));
    assert.match(macos, /fromJSON\(needs.candidate-scope.outputs.cores\)/);
    assert.match(macos, /--phase macos-isolation --prepare-sdk/);
    assert.match(macos, /--final-group-sha256 "\$INPUT_SHA256"/);
    assert.match(macos, /write-hosted-group.mjs.*--root "\$GITHUB_WORKSPACE"/);
    const execute = macos
      .split(/\n      - /)
      .find((step) => step.includes("Execute mandatory macOS"));
    assert.doesNotMatch(execute, /continue-on-error|if:/, "native execution remains mandatory");
    if (file === "quality") {
      assert.match(macos, /sdk-artifact-cache\.mjs.*--github-paths/);
      assert.match(macos, /path: quality-macos-result\.json/);
      assert.ok(parse(source).jobs["candidate-quality"].needs.includes("macos-isolation"));
    } else {
      assert.match(source, /QUALITY_ISOLATION_RESULT: \$\{\{ needs\.macos-isolation\.result \}\}/);
      assert.match(source, /--phase compatibility-final/);
    }
  }
  for (const file of macosIsolationTests) assert.doesNotMatch(readFileSync(file, "utf8"), /skip:/);
});

test("Linux preparation exports once and failed checks block executable worker inputs", () => {
  const source = readFileSync(".github/workflows/quality.yml", "utf8");
  const linux = source.slice(source.indexOf("  gates:\n"), source.indexOf("  plan-test-shards:\n"));
  const sourcePlan = source.slice(source.indexOf("  source-plan:\n"), source.indexOf("  gates:\n"));
  assert.match(sourcePlan, /--stage plan.*--test-file-concurrency 3/);
  assert.doesNotMatch(
    sourcePlan,
    /npm install|corepack enable|--prepare-sdk|--stage (?:prepare|build)/,
  );
  assert.match(sourcePlan, /quality-worker-control\.mjs --mode freeze/);
  const steps = linux.split(/\n      - /);
  for (const stage of ["prepare", "build", "checks", "tests"]) {
    const step = steps.find((entry) => entry.includes(`id: quality-${stage}\n`));
    assert.ok(step, stage);
    assert.match(step, new RegExp(`--stage ${stage}(?:\\s|$)`));
    assert.match(step, /--final-group-sha256 "\$INPUT_SHA256"/);
    assert.doesNotMatch(step, /continue-on-error/);
  }
  for (const name of [
    "Freeze the actual system Chrome distribution",
    "Freeze worker preparation binding",
    "Export prepared bytes once",
    "Publish the small Core index",
  ]) {
    const step = steps.find((entry) => entry.includes(name));
    assert.ok(step, name);
    assert.match(step, /!cancelled\(\).*steps\.(?:quality-build|bundle)\.outcome == 'success'/);
    if (!name.startsWith("Publish")) assert.match(step, /quality-checks\.outcome == 'success'/);
  }
  assert.ok(linux.indexOf("id: quality-plan") < linux.indexOf("id: cache-path"));
  assert.ok(linux.indexOf("id: quality-source") < linux.indexOf("id: quality-build"));
  assert.match(linux, /quality:fast --source-only/);
  assert.match(
    linux,
    /--source-receipt-out \.runtime\/quality-source-checks\.json --input-sha256 "\$INPUT_SHA256"/,
  );
  assert.match(
    linux,
    /--stage checks --source-check-receipt \.runtime\/quality-source-checks\.json/,
  );
  assert.match(sourcePlan, /GITHUB_STEP_SUMMARY/);
  assert.ok(linux.indexOf("id: quality-plan") < linux.indexOf("id: sdk-paths"));
  assert.match(sourcePlan, /--stage plan.*--test-shards auto/);
  assert.match(linux, /const plan=control\.plan/);
  assert.doesNotMatch(linux, /--stage plan/);
  assert.match(linux, /QUALITY_TEST_SHARDS: \$\{\{ steps\.quality-plan\.outputs\.shards \}\}/);
  assert.match(linux, /--stage tests/);
  const localTests = steps.find((step) => step.includes("id: quality-tests"));
  assert.match(localTests, /quality-plan\.outputs\.shards == '1'/);
  const browserCache = steps.find((step) => step.includes("path: .quality-browser"));
  assert.match(browserCache, /quality-plan\.outputs\.browser == 'true'/);
  const chromeSnapshot = steps.find((step) => step.includes("--mode prepare-browser"));
  assert.match(chromeSnapshot, /quality-plan\.outputs\.shards != '1'/);
  assert.match(chromeSnapshot, /quality-plan\.outputs\.browser == 'true'/);
  assert.doesNotMatch(linux, /--stage summary/);
  assert.equal((linux.match(/quality-prepared-inputs\.mjs export/g) ?? []).length, 1);
  const planner = source.slice(
    source.indexOf("  plan-test-shards:\n"),
    source.indexOf("  test-shards:\n"),
  );
  assert.match(planner, /always\(\).*needs\.candidate-scope\.result == 'success'/);
  assert.match(planner, /pattern: quality-a\$\{\{ github\.run_attempt \}\}-source-\*/);
  assert.doesNotMatch(planner, /quality-bundle|needs\.gates\.outputs/);
  const worker = source.slice(
    source.indexOf("  test-shards:\n"),
    source.indexOf("  macos-isolation:\n"),
  );
  assert.match(worker, /always\(\).*needs\.plan-test-shards\.result == 'success'/);
  assert.match(worker, /has-shards == 'true'/);
  assert.match(worker, /max-parallel: 8/);
  assert.match(worker, /quality-worker-inputs\.mjs --root.*--early-control.*--early-sha256/);
  assert.match(worker, /--stage tests --execution-plan.*--test-shard/);
  assert.ok(linux.indexOf("--mode prepare-browser") < linux.indexOf("--mode binding"));
  const cleanup = worker
    .split(/\n      - /)
    .find((step) => step.includes("Verify and unmount this job's fixed system Chrome"));
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /quality-system-chrome\.mjs cleanup --root/);
  assert.doesNotMatch(cleanup, /continue-on-error/);
  assert.ok(worker.indexOf("--stage tests") < worker.indexOf("quality-system-chrome.mjs cleanup"));
  assert.ok(
    worker.indexOf("quality-system-chrome.mjs cleanup") <
      worker.indexOf("Preserve actual execution"),
  );
  assert.doesNotMatch(
    worker,
    /--prepare-sdk|--prepare-inputs|--stage build|actions\/cache|id: cache-path/,
  );
  assert.match(worker, /needs:.*gates/);
  assert.match(worker, /always\(\).*needs\.gates\.result == 'success'/);
  assert.match(worker, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(
    source,
    /QUALITY_EXPECTED_WORKFLOW_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
});

test("the current source impact maps changed paths without feature history and still rejects unknown scripts", async (t) => {
  const source = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "gea-current-source-impact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd, message) => {
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--quiet",
      "-m",
      message,
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  // Keep fixture paths from creating a false source-graph consumer of the contract under test.
  const contract = ["scripts/final-group-input", "contract", "mjs"].join(".");
  const changedPaths = [
    ".github/workflows/quality.yml",
    "docs/local-development.md",
    "package.json",
    "scripts/ci-test-policy.json",
    contract,
    "scripts/fixtures/quality-ci-commands.mjs",
    "scripts/quality-ci-stages.mjs",
    "scripts/quality-test-timings.json",
    "scripts/quality-system-chrome.mjs",
    "scripts/quality-worker-control.mjs",
    "scripts/quality-worker-control.test.mjs",
    "scripts/fixtures/quality-system-chrome-commands.mjs",
    "scripts/run-quality-ci-stages.test.mjs",
    "scripts/run-quality-ci.mjs",
    "scripts/run-quality-ci.test.mjs",
  ].sort();
  const repositories = [];
  for (const [repo, input] of [
    [
      "dsh-agent-workbench",
      process.env.GEA_FINAL_GROUP_WORKBENCH_SOURCE ?? resolve(source, "../dsh-agent-workbench"),
    ],
    [
      "dsh-agent-manage",
      process.env.GEA_FINAL_GROUP_MANAGE_SOURCE ?? resolve(source, "../dsh-agent-manage"),
    ],
    ["dsh-gea-plugin", source],
  ]) {
    const path = join(directory, repo);
    for (const file of git(input, "ls-files", "--cached", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean)) {
      if (
        !existsSync(join(input, file)) ||
        file.startsWith("lib/") ||
        (!/\.(?:[cm]?[jt]sx?|css|html|json|ya?ml)$/.test(file) && !changedPaths.includes(file))
      )
        continue;
      const target = join(path, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(input, file)));
    }
    git(path, "init", "--quiet");
    repositories.push({
      repo,
      path,
      head: repo === "dsh-gea-plugin" ? null : commit(path, "current peer snapshot"),
    });
  }
  const gea = repositories.find((entry) => entry.repo === "dsh-gea-plugin");
  writeFileSync(
    join(gea.path, "scripts/quality-peer-baseline.json"),
    JSON.stringify({
      schemaVersion: 1,
      repositories: repositories.map((entry) => ({
        repo: entry.repo,
        head: entry.head ?? "0".repeat(40),
      })),
    }),
  );
  const base = commit(gea.path, "current authored source snapshot");
  // Make the known paths differ without changing the current code graph or policy semantics.
  for (const file of changedPaths) appendFileSync(join(gea.path, file), "\n");
  gea.head = commit(gea.path, "source impact fixture changes");
  assert.equal(git(gea.path, "rev-list", "--count", "HEAD"), "2");
  const { selectCiTests } = await import(
    pathToFileURL(join(directory, "dsh-agent-workbench/scripts/ci-test-plan.mjs"))
  );
  const testOwners = JSON.parse(
    readFileSync(join(gea.path, "scripts/ci-test-policy.json")),
  ).testOwners;
  const request = { repositories, repo: "dsh-gea-plugin", base, testOwners };
  const plan = selectCiTests(request);
  assert.deepEqual(plan.changes.map((entry) => entry.file).sort(), changedPaths);
  for (const entry of plan.changes.filter((entry) => !entry.file.endsWith(".md")))
    assert.ok(plan.reasons[`${entry.repo}/${entry.file}`].length > 0, entry.file);
  for (const file of ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"])
    assert.ok(plan.reasons[`dsh-gea-plugin/${contract}`].includes(file));
  for (const file of plan.required) assert.ok(plan.files.includes(file));
  for (const file of Object.keys(testOwners)) assert.ok(!plan.files.includes(file), file);
  assert.equal(new Set(plan.files).size, plan.files.length);
  t.diagnostic(
    JSON.stringify({
      base,
      head: gea.head,
      repositories,
      changes: plan.changes,
      reasons: plan.reasons,
      required: plan.required,
      files: plan.files,
    }),
  );
  const unmapped = `scripts/unmapped-${directory.split(/[\\/]/).at(-1)}.mjs`;
  writeFileSync(join(gea.path, unmapped), "export const unmatched = true;\n");
  gea.head = commit(gea.path, "unmapped source must still refuse");
  assert.throws(
    () => selectCiTests(request),
    /CI_TEST_IMPACT_UNMAPPED: dsh-gea-plugin\/scripts\/unmapped-/,
  );
});

test("final cannot pass from job result environment flags without machine coverage and hosted clocks", () => {
  const result = spawnSync(process.execPath, ["scripts/run-quality-ci.mjs", "--phase", "final"], {
    encoding: "utf8",
    env: {
      ...process.env,
      QUALITY_SCOPE_RESULT: "success",
      QUALITY_GATE_RESULT: "success",
      QUALITY_ISOLATION_RESULT: "success",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_FINAL_INPUT_REQUIRED/);
});

test("compatibility keeps its own status summary while required final still demands complete receipts", () => {
  const good = {
    QUALITY_SCOPE_RESULT: "success",
    QUALITY_GATE_RESULT: "success",
    QUALITY_ISOLATION_RESULT: "success",
  };
  assert.equal(run(["--phase", "compatibility-final"], good).status, 0);
  for (const key of Object.keys(good))
    for (const result of ["failure", "skipped", "cancelled", ""])
      assert.equal(run(["--phase", "compatibility-final"], { ...good, [key]: result }).status, 1);
  assert.equal(run(["--phase", "final"], good).status, 1);
});

test("dependency review applies only to consumed GEA dependency inputs on PRs and remains required when selected", () => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "npm-shrinkwrap.json",
    "desktop/package.json",
    "desktop/diagnostic-package.json",
    "desktop/tools/package.json",
    "desktop/tools/package-lock.json",
  ]) {
    const changes = [{ repo: "dsh-gea-plugin", file }];
    assert.equal(requiresDependencyReview(changes, "pull_request"), true, file);
    assert.equal(requiresDependencyReview(changes, "push"), false, file);
  }
  for (const file of ["docs/README.md", "src/style.css", "tests/fixtures/package.json"])
    assert.equal(
      requiresDependencyReview([{ repo: "dsh-gea-plugin", file }], "pull_request"),
      false,
      file,
    );
  assert.equal(
    requiresDependencyReview([{ repo: "dsh-agent-manage", file: "package.json" }], "pull_request"),
    false,
  );
  const job = parse(readFileSync(".github/workflows/quality.yml", "utf8")).jobs[
    "dependency-review"
  ];
  assert.match(job.if, /pull_request.*dependency-review-applicable/);
  assert.equal(job.needs, "source-plan");
  const action = job.steps.find((step) => step.uses === "actions/dependency-review-action@v5");
  assert.equal(action.with["fail-on-severity"], "high");
  assert.equal(action["continue-on-error"], undefined);
});

test("tool knowledge uses the immutable Core command manifest and refuses unavailable or malformed metadata", (t) => {
  const workflow = parse(readFileSync(".github/workflows/source-quality.yml", "utf8"));
  const step = workflow.jobs["source-checks"].steps.find(
    (step) => step.name === "Read fixed Core command metadata for knowledge checks",
  );
  assert.equal(step.if, "steps.affected.outputs.tooling == 'true'");
  const code = step.run
    .match(/<<'NODE'\n([\s\S]*?)\nNODE/)[1]
    .replace(
      /from '[^']+source-tools\.mjs';/,
      "from " +
        JSON.stringify(
          pathToFileURL(resolve("../dsh-agent-workbench/scripts/source-tools.mjs")).href,
        ) +
        ";",
    );
  for (const mode of ["valid", "http", "malformed"]) {
    const directory = mkdtempSync(join(tmpdir(), "source-core-metadata-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "scripts"));
    writeFileSync(
      join(directory, "scripts/ci-core-policy.mjs"),
      `export function ciCores(lane) { if(lane !== 'required') throw Error('WRONG_LANE'); return [{head:'${"a".repeat(40)}'}]; }`,
    );
    const fake = `globalThis.fetch=async url => { if(url !== 'https://raw.githubusercontent.com/CleverC2200/deepseek-harness/${"a".repeat(40)}/package.json') throw Error('MUTABLE_SOURCE'); return new Response(JSON.stringify(${mode === "malformed" ? "{}" : '{scripts:{"dev:desktop":"unchanged"}}'}), {status:${mode === "http" ? 503 : 200}}); };`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", fake + code], {
      cwd: directory,
      env: { ...process.env, GITHUB_WORKSPACE: directory },
      encoding: "utf8",
    });
    if (mode === "valid") {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(
        JSON.parse(readFileSync(join(directory, "official-latest-standard/package.json"))).scripts[
          "dev:desktop"
        ],
        "unchanged",
      );
      assert.equal(existsSync(join(directory, "official-latest-standard/node_modules")), false);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        mode === "http" ? /SOURCE_CORE_METADATA_HTTP/ : /SOURCE_CORE_COMMANDS_REQUIRED/,
      );
      assert.equal(existsSync(join(directory, "official-latest-standard")), false);
    }
  }
});

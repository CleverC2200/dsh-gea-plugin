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
import { macosIsolationTests, selectPlatformTests } from "./ci-platform-tests.mjs";

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
  assert.match(
    workflow,
    /needs: \[candidate-scope, source-plan, gates, plan-test-shards, test-shards, macos-isolation\]/,
  );
  assert.match(workflow, /run: node scripts\/run-quality-ci.mjs --phase final/);
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
    /repository: deepseek-ai\/deepseek-harness\n          ref: \$\{\{ matrix\.core \}\}\n          fetch-depth: 0\n          path: source\/official-core/,
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

test("the Linux plan delegates only the kernel sandbox file to mandatory macOS execution", () => {
  const files = [
    "tests/gateway-handshake.test.mjs",
    ...macosIsolationTests,
    "tests/controlled-execution.test.mjs",
  ];
  const plan = {
    files,
    runtime: true,
    browser: false,
    reasons: { required: [...files] },
  };
  for (const platform of ["linux", "win32"]) {
    const selected = selectPlatformTests(plan, platform);
    assert.deepEqual(selected.files, [files[0], files[2]]);
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
    assert.match(macos, /needs: candidate-scope/);
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
      assert.match(
        source,
        /needs: \[candidate-scope, source-plan, gates, plan-test-shards, test-shards, macos-isolation\]/,
      );
    } else {
      assert.match(source, /QUALITY_ISOLATION_RESULT: \$\{\{ needs\.macos-isolation\.result \}\}/);
      assert.match(source, /--phase compatibility-final/);
    }
  }
  assert.doesNotMatch(readFileSync("scripts/isolated-validation.test.mjs", "utf8"), /skip:/);
});

test("Linux preparation exports once and workers retain independent tests after failed checks", () => {
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
  for (const stage of ["prepare", "build", "checks"]) {
    const step = steps.find((entry) => entry.includes(`id: quality-${stage}\n`));
    assert.ok(step, stage);
    assert.match(step, new RegExp(`--stage ${stage}(?:\n|$)`));
    assert.match(step, /--final-group-sha256 "\$INPUT_SHA256"/);
    if (stage === "checks") assert.match(step, /continue-on-error: true/);
    else assert.doesNotMatch(step, /continue-on-error/);
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
    assert.doesNotMatch(step, /quality-checks\.outcome|if: success/);
  }
  assert.ok(linux.indexOf("id: quality-plan") < linux.indexOf("id: cache-path"));
  assert.ok(linux.indexOf("id: quality-plan") < linux.indexOf("id: sdk-paths"));
  assert.match(linux, /--stage plan.*--test-shards auto/);
  assert.match(linux, /QUALITY_TEST_SHARDS: \$\{\{ steps\.quality-plan\.outputs\.shards \}\}/);
  assert.doesNotMatch(linux, /--stage tests|--stage summary/);
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
  assert.match(worker, /max-parallel: 14/);
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
  assert.doesNotMatch(worker, /needs:.*gates/);
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
    // Use current authored bytes, excluding writable builds and untracked concurrent fixtures.
    for (const file of git(input, "ls-files", "-z").split("\0").filter(Boolean)) {
      if (
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
  const request = { repositories, repo: "dsh-gea-plugin", base };
  const plan = selectCiTests(request);
  assert.deepEqual(plan.changes.map((entry) => entry.file).sort(), changedPaths);
  for (const entry of plan.changes.filter((entry) => !entry.file.endsWith(".md")))
    assert.ok(plan.reasons[`${entry.repo}/${entry.file}`].length > 0, entry.file);
  for (const file of ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"])
    assert.ok(plan.reasons[`dsh-gea-plugin/${contract}`].includes(file));
  for (const file of plan.required) assert.ok(plan.files.includes(file));
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

test("public final keeps unaccepted timing enforcement out while retaining mandatory functional rejection", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gea-final-acceptance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const scenario of [
    "timing-only",
    "coverage-failed",
    "upstream-failed",
    "identity-unknown",
  ]) {
    const output = join(directory, scenario);
    mkdirSync(output);
    const head = "a".repeat(40),
      now = Date.now(),
      at = (offset) => new Date(now + offset).toISOString();
    const job = (id, name, status = "completed", conclusion = "success") => ({
      id,
      name,
      run_id: 123,
      run_attempt: 1,
      head_sha: head,
      status,
      conclusion,
      started_at: at(-649000 + id * 1000),
      completed_at: status === "completed" ? at(-2000) : null,
    });
    const jobs = [
      job(1, "scope"),
      job(2, "gates"),
      { ...job(3, "candidate-quality", "in_progress", null), started_at: at(-1000) },
    ];
    if (scenario === "upstream-failed") jobs[1].conclusion = "failure";
    const apiRun = {
      id: 123,
      run_attempt: 1,
      head_sha: scenario === "identity-unknown" ? "b".repeat(40) : head,
      status: "in_progress",
      conclusion: null,
      created_at: at(-650000),
      run_started_at: at(-650000),
      updated_at: at(0),
    };
    const coverage = { status: scenario === "coverage-failed" ? "failed" : "passed" };
    const catalog = { requiredJobs: ["scope", "gates"] },
      file = join(output, "catalog.json"),
      preload = join(output, "boundaries.mjs");
    writeFileSync(file, JSON.stringify(catalog));
    const shardModule = `import {writeFileSync} from 'node:fs'; export const createShardCatalog=()=>(${JSON.stringify(catalog)}); export const shardCli=async args=>{const value=${JSON.stringify(coverage)};writeFileSync(args.at(-1),JSON.stringify(value));return value};`;
    // Control only the coverage-module and REST boundaries. The public CLI and actual hosted
    // reader/assessment compose their real status, identity and timing decisions.
    writeFileSync(
      preload,
      `import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,context,next){if(specifier==='./quality-shards.mjs'&&context.parentURL?.endsWith('/scripts/run-quality-ci.mjs'))return{url:${JSON.stringify("data:text/javascript," + encodeURIComponent(shardModule))},shortCircuit:true};return next(specifier,context)}});
globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes('/jobs?')?${JSON.stringify({ total_count: jobs.length, jobs })}:${JSON.stringify(apiRun)}),{status:200});`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/run-quality-ci.mjs",
        "--phase",
        "final",
        "--catalog",
        file,
        "--worker-results",
        output,
        "--macos-results",
        output,
        "--final-output",
        output,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          QUALITY_EXPECTED_WORKFLOW_SHA: head,
          QUALITY_FINAL_CORES: JSON.stringify([head]),
          QUALITY_FINAL_GROUP_ID: "fixture",
          QUALITY_FINAL_MANAGE_SHA: head,
          QUALITY_FINAL_WORKBENCH_SHA: head,
        },
      },
    );
    assert.equal(
      result.status,
      scenario === "timing-only" ? 0 : 1,
      scenario + ": " + result.stdout + result.stderr,
    );
    const measured = JSON.parse(readFileSync(join(output, "hosted-budget.json")));
    if (scenario === "timing-only") {
      assert.equal(measured.functional.status, "passed");
      assert.equal(measured.performance.status, "failed");
      assert.ok(measured.performance.reasons.includes("HOSTED_BUDGET_EXCEEDED"));
      assert.equal(measured.passed, false);
    }
  }
});

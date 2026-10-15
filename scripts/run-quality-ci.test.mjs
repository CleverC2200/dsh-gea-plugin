import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
  assert.equal(run(["--phase", "final"], good).status, 0);
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
  assert.match(workflow, /needs: \[candidate-scope, gates, macos-isolation\]/);
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
    assert.doesNotMatch(macos, /continue-on-error|if: needs|if: success/);
    assert.match(source, /needs: \[candidate-scope, gates, macos-isolation\]/);
    assert.match(source, /QUALITY_ISOLATION_RESULT: \$\{\{ needs\.macos-isolation\.result \}\}/);
  }
  assert.doesNotMatch(readFileSync("scripts/isolated-validation.test.mjs", "utf8"), /skip:/);
});

test("Linux stage wiring preserves independent tests and always summarizes and uploads receipts", () => {
  const source = readFileSync(".github/workflows/quality.yml", "utf8");
  const linux = source.slice(source.indexOf("  gates:\n"), source.indexOf("  macos-isolation:\n"));
  const steps = linux.split(/\n      - /);
  for (const stage of ["prepare", "build", "checks", "tests", "summary"]) {
    const step = steps.find((entry) => entry.includes(`id: quality-${stage}\n`));
    assert.ok(step, stage);
    assert.match(step, new RegExp(`--stage ${stage}(?:\\n|$)`));
    assert.match(step, /--final-group-sha256 "\$INPUT_SHA256"/);
    assert.doesNotMatch(step, /continue-on-error/);
    if (stage === "tests") {
      assert.match(
        step,
        /!cancelled\(\).*steps\.quality-prepare\.outcome == 'success'.*steps\.quality-build\.outcome == 'success'/,
      );
      assert.doesNotMatch(step, /success\(\)|quality-checks\.outcome/);
    }
    if (stage === "summary") {
      assert.match(step, /if: always\(\)/);
      for (const required of ["prepare", "build", "checks", "tests"])
        assert.ok(step.includes(`steps.quality-${required}.outcome`));
    }
  }
  assert.match(linux, /quality-stages\.json/);
  assert.match(linux, /if: always\(\)\n        uses: actions\/upload-artifact@v7/);
});

test("the real C1 PR impact maps every changed source and still rejects an unknown script", async (t) => {
  const source = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "gea-c1-source-impact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const base = "d35011eca8752a1fabff896c9d78dc60b27243a6";
  const head = "1a5ec9552b710917376d56c82ebaf143b326219e";
  const baseline = JSON.parse(git(source, "show", `${head}:scripts/quality-peer-baseline.json`));
  const repositories = [];
  for (const [repo, input, commit] of [
    [
      "dsh-agent-workbench",
      process.env.GEA_FINAL_GROUP_WORKBENCH_SOURCE ?? resolve(source, "../dsh-agent-workbench"),
      baseline.repositories.find((entry) => entry.repo === "dsh-agent-workbench").head,
    ],
    [
      "dsh-agent-manage",
      process.env.GEA_FINAL_GROUP_MANAGE_SOURCE ?? resolve(source, "../dsh-agent-manage"),
      baseline.repositories.find((entry) => entry.repo === "dsh-agent-manage").head,
    ],
    ["dsh-gea-plugin", source, head],
  ]) {
    const path = join(directory, repo);
    git(directory, "clone", "--quiet", "--shared", "--no-checkout", input, path);
    git(path, "checkout", "--quiet", "--detach", commit);
    repositories.push({ repo, path, head: commit });
  }
  const gea = repositories.find((entry) => entry.repo === "dsh-gea-plugin");
  // Overlay only the policy under review onto the PR's exact frozen source group.
  writeFileSync(
    join(gea.path, "scripts/ci-test-policy.json"),
    readFileSync(join(source, "scripts/ci-test-policy.json")),
  );
  const { selectCiTests } = await import(
    pathToFileURL(join(directory, "dsh-agent-workbench/scripts/ci-test-plan.mjs"))
  );
  const request = { repositories, repo: "dsh-gea-plugin", base };
  const plan = selectCiTests(request);
  assert.deepEqual(plan.changes.map((entry) => entry.file).sort(), [
    ".github/workflows/quality.yml",
    "docs/local-development.md",
    "package.json",
    "scripts/ci-test-policy.json",
    "scripts/final-group-input.contract.mjs",
    "scripts/fixtures/quality-ci-commands.mjs",
    "scripts/quality-ci-stages.mjs",
    "scripts/run-quality-ci-stages.test.mjs",
    "scripts/run-quality-ci.mjs",
    "scripts/run-quality-ci.test.mjs",
  ]);
  for (const entry of plan.changes.filter((entry) => !entry.file.endsWith(".md")))
    assert.ok(plan.reasons[`${entry.repo}/${entry.file}`].length > 0, entry.file);
  for (const file of ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"])
    assert.ok(plan.reasons["dsh-gea-plugin/scripts/final-group-input.contract.mjs"].includes(file));
  for (const file of plan.required) assert.ok(plan.files.includes(file));
  t.diagnostic(
    JSON.stringify({
      base,
      head,
      repositories,
      changes: plan.changes,
      reasons: plan.reasons,
      required: plan.required,
      files: plan.files,
    }),
  );
  const unmapped = `scripts/unmapped-${directory.split(/[\\/]/).at(-1)}.mjs`;
  writeFileSync(join(gea.path, unmapped), "export const unmatched = true;\n");
  git(gea.path, "add", unmapped);
  git(
    gea.path,
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "--quiet",
    "-m",
    "unmapped source must still refuse",
  );
  gea.head = git(gea.path, "rev-parse", "HEAD");
  assert.throws(
    () => selectCiTests(request),
    /CI_TEST_IMPACT_UNMAPPED: dsh-gea-plugin\/scripts\/unmapped-/,
  );
});

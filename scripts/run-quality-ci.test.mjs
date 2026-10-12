import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const run = (args, environment = {}) => {
  const env = { ...process.env };
  for (const name of [
    "QUALITY_SCOPE_ALLOWED",
    "QUALITY_SCOPE_RESULT",
    "QUALITY_GATE_RESULT",
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
  const good = { QUALITY_SCOPE_RESULT: "success", QUALITY_GATE_RESULT: "success" };
  assert.equal(run(["--phase", "final"], good).status, 0);
  for (const key of Object.keys(good))
    for (const result of ["", "skipped", "cancelled", "failure"])
      assert.equal(run(["--phase", "final"], { ...good, [key]: result }).status, 1);
});
test("the public input phase binds the actual event and quality refuses missing or mismatched admission", () => {
  assert.match(run([]).stderr, /CANDIDATE_INPUT_REQUIRED/);
  const directory = mkdtempSync(join(tmpdir(), "gea-quality-input-"));
  try {
    const created = run(["--phase", "input", "--root", directory, "--sha", "a".repeat(40)]);
    assert.equal(created.status, 0, created.stderr);
    const file = join(directory, "candidate-input.json"),
      candidate = JSON.parse(readFileSync(file));
    assert.equal(candidate.repositories.length, 3);
    const gea = candidate.repositories.find((entry) => entry.repo === "dsh-gea-plugin");
    assert.equal(gea.head, "a".repeat(40));
    gea.path = process.cwd();
    writeFileSync(file, JSON.stringify(candidate));
    assert.match(run(["--input", file], { CI: "true" }).stderr, /CANDIDATE_EVENT_REQUIRED/);
    assert.match(
      run(["--input", file], { CI: "true", QUALITY_EXPECTED_SHA: "b".repeat(40) }).stderr,
      /CANDIDATE_EVENT_MISMATCH/,
    );
    assert.match(
      run(["--phase", "input", "--root", directory, "--sha", "main"]).stderr,
      /CANDIDATE_EVENT_REQUIRED/,
    );
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
  assert.match(workflow, /needs: \[candidate-scope, gates\]/);
  assert.match(workflow, /run: node scripts\/run-quality-ci.mjs --phase final/);
  assert.match(workflow, /PLUGIN_SPLIT_READ_TOKEN/);
  assert.match(workflow, /npm install --global npm@11\.11\.0/);
  assert.match(workflow, /supportedCores\.filter\(core => !core\.id\)\.map\(core => core\.head\)/);
  assert.match(workflow, /fromJSON\(needs\.candidate-scope\.outputs\.cores\)/);
  assert.match(workflow, /CORE_HEAD: \$\{\{ matrix\.core \}\}/);
  assert.match(workflow, /--core-head "\$CORE_HEAD"/);
  const scripts = JSON.parse(readFileSync("package.json")).scripts;
  assert.doesNotMatch(scripts["quality:fast"], /candidate:verify|run-quality-ci/);
  assert.equal(scripts["quality:ci"], "node scripts/run-quality-ci.mjs");
});

for (const head of [
  "639ed015397290b3745d163aafe02ffee4aa3f84",
  "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
]) {
  test(`public input selects registered Core ${head} and rejects an unregistered Core`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "gea-dual-quality-input-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const created = run([
      "--phase",
      "input",
      "--root",
      directory,
      "--sha",
      "a".repeat(40),
      "--core-head",
      head,
    ]);
    assert.equal(created.status, 0, created.stderr);
    assert.equal(JSON.parse(readFileSync(join(directory, "candidate-input.json"))).core, head);
    assert.match(
      run([
        "--phase",
        "input",
        "--root",
        directory,
        "--sha",
        "a".repeat(40),
        "--core-head",
        "0".repeat(40),
      ]).stderr,
      /CANDIDATE_CORE_UNSUPPORTED/,
    );
  });
}

test("local default admission keeps historical fixed peers and hosted refs consume public reader outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "hosted-peer-pins-"));
  try {
    const core = "639ed015397290b3745d163aafe02ffee4aa3f84";
    const created = spawnSync(
      process.execPath,
      [
        "scripts/run-quality-ci.mjs",
        "--phase",
        "input",
        "--root",
        directory,
        "--sha",
        "a".repeat(40),
        "--core-head",
        core,
      ],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr);
    const input = JSON.parse(readFileSync(join(directory, "candidate-input.json"), "utf8"));
    const expected = {
      "dsh-agent-workbench": "c5a5bc64fade154bf5b468f0d848974ac308823a",
      "dsh-agent-manage": "cdd2d6520a7790ca1a1c658d1fa71e07c651cd3f",
    };
    const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
    for (const [repo, head] of Object.entries(expected)) {
      assert.equal(input.repositories.find((entry) => entry.repo === repo)?.head, head);
      const key = repo === "dsh-agent-workbench" ? "workbench-sha" : "manage-sha";
      assert.ok(
        workflow.includes("ref: ${{ needs.candidate-scope.outputs." + key + " }}"),
        repo + " consumes the admitted public reader output",
      );
      assert.ok(
        !workflow.includes("|| '" + head + "'"),
        "hosted source event must not silently use historical peers",
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
    const mismatch = execute({ ...valid, QUALITY_EXPECTED_SHA: "d".repeat(40) });
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

test("dispatch freezes the group without cancelling runs or replacing the original gates", () => {
  const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
  assert.match(
    workflow,
    /github\.ref \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
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

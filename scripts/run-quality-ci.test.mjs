import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  assert.equal((workflow.match(/fetch-depth: 0/g) ?? []).length, 5);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 5);
  assert.match(workflow, /node scripts\/run-quality-ci.mjs --prepare-sdk.*--prepare-inputs/);
  assert.match(readFileSync("scripts/run-quality-ci.mjs", "utf8"), /APS_BUILD_MODE: ["']mock["']/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /needs: \[candidate-scope, gates\]/);
  assert.match(workflow, /run: node scripts\/run-quality-ci.mjs --phase final/);
  assert.match(workflow, /PLUGIN_SPLIT_READ_TOKEN/);
  assert.match(workflow, /npm install --global npm@11\.11\.0/);
  assert.match(workflow, /supportedCores\.map\(core => core\.head\)/);
  assert.match(workflow, /fromJSON\(needs\.candidate-scope\.outputs\.cores\)/);
  assert.match(workflow, /--core-head "\$\{\{ matrix\.core \}\}"/);
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

test("hosted checkout refs and public admission use the reviewed immutable peer commits", () => {
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
      "dsh-agent-workbench": "8f58ed601ab048d57f44794658009105407b6ae6",
      "dsh-agent-manage": "6f08567a6e032b867464b0cfc55c967942ce2b93",
    };
    const workflow = readFileSync(".github/workflows/quality.yml", "utf8");
    for (const [repo, head] of Object.entries(expected)) {
      assert.equal(input.repositories.find((entry) => entry.repo === repo)?.head, head);
      const checkoutRefs = [
        ...workflow.matchAll(
          new RegExp("repository: CleverC2200/" + repo + "\\s+ref: ([a-f0-9]{40})", "g"),
        ),
      ].map((match) => match[1]);
      assert.ok(checkoutRefs.length > 0, repo + " must be checked out");
      assert.deepEqual([...new Set(checkoutRefs)], [head], repo + " checkout and input must agree");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

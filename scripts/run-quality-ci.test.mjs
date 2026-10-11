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
  assert.match(workflow, /corepack pnpm quality:ci --prepare-sdk.*--prepare-inputs/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /needs: \[candidate-scope, gates\]/);
  assert.match(workflow, /run: node scripts\/run-quality-ci.mjs --phase final/);
  assert.match(workflow, /PLUGIN_SPLIT_READ_TOKEN/);
  const scripts = JSON.parse(readFileSync("package.json")).scripts;
  assert.doesNotMatch(scripts["quality:fast"], /candidate:verify|run-quality-ci/);
  assert.equal(scripts["quality:ci"], "node scripts/run-quality-ci.mjs");
});

// Execute the runner's actual command boundary with a real successful child that changes the input.
test("a successful final child cannot change frozen input unnoticed", async (t) => {
  const fs = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runInNewContext } = await import("node:vm");
  const root = fs.mkdtempSync(join(tmpdir(), "quality-final-child-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = join(root, "group.json");
  const bytes = Buffer.from('{"frozen":true}\n');
  fs.writeFileSync(input, bytes);
  const source = fs.readFileSync("scripts/run-quality-ci.mjs", "utf8");
  const commands = source.slice(source.indexOf("function refuse("), source.indexOf("\ntry {"));
  const finalGroup = {
    verifyUnchanged() {
      if (!bytes.equals(fs.readFileSync(input))) throw Error("CANDIDATE_INPUT_CHANGED");
    },
  };
  const invoke =
    "run(process.execPath, ['-e', \"require('node:fs').appendFileSync(process.argv[1], 'changed')\", input]);";
  assert.throws(
    () => runInNewContext(commands + "\n" + invoke, { process, spawnSync, finalGroup, input }),
    /CANDIDATE_INPUT_CHANGED/,
  );
  assert.notDeepEqual(fs.readFileSync(input), bytes, "the real child must have changed the bytes");
});

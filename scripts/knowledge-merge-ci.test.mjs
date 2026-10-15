import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  matchesFrozenSource,
  selectKnowledgeMergeLane,
  knowledgeMergeAuthorization as a,
  knowledgeMergeTests,
  validateKnowledgeMergeGroup,
} from "./knowledge-merge-ci.mjs";
const input = {
  event: "pull_request",
  repository: a.repository,
  pullRequest: 75,
  branch: a.branch,
  headRepository: a.repository,
  matches: true,
};
test("only this PR and reviewed product source receive targeted acceptance", () => {
  assert.equal(selectKnowledgeMergeLane(input), true);
  for (const changes of [
    { pullRequest: 76 },
    { branch: "other" },
    { repository: "someone/fork" },
    { event: "workflow_dispatch" },
  ])
    assert.equal(selectKnowledgeMergeLane({ ...input, ...changes }), false);
  for (const changes of [{ headRepository: "someone/fork" }, { matches: false }])
    assert.throws(() => selectKnowledgeMergeLane({ ...input, ...changes }), /SCOPE_REJECTED/);
});
test("only the immediate merge can retain this exception on main", () => {
  const merged = {
    event: "push",
    repository: a.repository,
    ref: "refs/heads/main",
    matches: true,
    parents: [a.base, "a".repeat(40)],
  };
  assert.equal(selectKnowledgeMergeLane(merged), true);
  for (const changes of [
    { matches: false },
    { ref: "refs/heads/other" },
    { parents: ["b".repeat(40), "a".repeat(40)] },
    { parents: [a.base] },
  ])
    assert.equal(selectKnowledgeMergeLane({ ...merged, ...changes }), false);
});
test("real Git source rejects product changes, another HEAD and unrelated history", (t) => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-ci-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-q"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git(["config", "user.name", "CI fixture"]);
  writeFileSync(join(root, "product.ts"), "original\n");
  git(["add", "."]);
  git(["commit", "-qm", "baseline"]);
  const baseline = git(["rev-parse", "HEAD"]);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/ci.mjs"), "reviewed CI\n");
  git(["add", "."]);
  git(["commit", "-qm", "CI supplement"]);
  let entry = { path: root, head: git(["rev-parse", "HEAD"]) };
  assert.equal(matchesFrozenSource(entry, baseline, ["scripts/ci.mjs"]), true);
  assert.equal(matchesFrozenSource(entry, baseline), false);
  assert.equal(
    matchesFrozenSource({ ...entry, head: baseline }, baseline, ["scripts/ci.mjs"]),
    false,
  );
  assert.equal(matchesFrozenSource(entry, "f".repeat(40), ["scripts/ci.mjs"]), false);
  writeFileSync(join(root, "product.ts"), "changed\n");
  git(["add", "."]);
  git(["commit", "-qm", "product change"]);
  entry = { path: root, head: git(["rev-parse", "HEAD"]) };
  assert.equal(matchesFrozenSource(entry, baseline, ["scripts/ci.mjs"]), false);
});
test("partial, duplicate and forged peer groups reject", () => {
  for (const rows of [
    [],
    [{ repo: "dsh-gea-plugin" }],
    Array(3).fill({ repo: "dsh-gea-plugin" }),
    ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map((repo) => ({
      repo,
      path: "/missing",
      head: "f".repeat(40),
    })),
  ])
    assert.throws(() => validateKnowledgeMergeGroup(rows), /GROUP_REJECTED/);
});
test("targeted knowledge acceptance keeps real tests and ordinary aggregation", () => {
  for (const path of knowledgeMergeTests) assert.ok(readFileSync(path).length > 0);
  assert.ok(knowledgeMergeTests.includes("tests/knowledge-mcp.test.mjs"));
  assert.ok(knowledgeMergeTests.includes("tests/prompt-execution-tools.test.mjs"));
  const runner = readFileSync("scripts/run-quality-ci.mjs", "utf8");
  assert.match(runner, /validateKnowledgeMergeGroup\(candidate.repositories\)/);
  assert.match(runner, /acceptance: "targeted; 205-file selection not run"/);
  assert.match(runner, /QUALITY_ISOLATION_RESULT/);
});

test("the actual targeted CLI rejects an unapproved event after admission without entering preparation", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-ci-entry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const checkout = process.cwd();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = {
    core: "639ed015397290b3745d163aafe02ffee4aa3f84",
    repositories: [
      { repo: "dsh-gea-plugin", path: checkout, head },
      {
        repo: "dsh-agent-workbench",
        path: resolve("../dsh-agent-workbench"),
        head: "29d851d71bdbe4c490a246ab20447c76c19ae957",
      },
      {
        repo: "dsh-agent-manage",
        path: resolve("../dsh-agent-manage"),
        head: "307303d5532f4250879008573b329cf4bb202ff3",
      },
    ],
  };
  mkdirSync(join(directory, "scripts"));
  // Public raw-byte admission is tested independently. This seam reaches the real
  // stage CLI with an admitted group, but no authorization to execute its stage.
  writeFileSync(
    join(directory, "scripts/candidate-input.mjs"),
    "export async function readFinalGroup() { return {manifest: " +
      JSON.stringify(manifest) +
      "}; }\n",
  );
  const env = { ...process.env };
  for (const key of [
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "QUALITY_EXPECTED_SHA",
    "CI",
  ])
    delete env[key];
  const run = spawnSync(
    process.execPath,
    [
      "scripts/run-quality-ci.mjs",
      "--phase",
      "knowledge-merge",
      "--stage",
      "tests",
      "--input",
      join(directory, "input.json"),
      "--final-group-workbench",
      directory,
      "--final-group-sha256",
      "a".repeat(64),
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /KNOWLEDGE_MERGE_EVENT_REQUIRED/);
  assert.doesNotMatch(run.stderr, /ReferenceError/);
});

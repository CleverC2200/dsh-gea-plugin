import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { selectCiTests } from "../../dsh-agent-workbench/scripts/ci-test-plan.mjs";

test("a dynamic Workbench source-policy change selects the GEA adapter contract", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gea-ci-impact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (path, ...args) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  const put = (root, file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const commit = (path) => {
    git(path, "add", ".");
    git(
      path,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "Input",
    );
    return git(path, "rev-parse", "HEAD");
  };
  const repositories = ["dsh-agent-workbench", "dsh-agent-manage", "dsh-gea-plugin"].map((repo) => {
    const path = join(directory, repo);
    mkdirSync(path);
    git(path, "init", "-q");
    put(path, "scripts/ci-source-policy.mjs", "export const revision = 1;");
    return { repo, path, head: commit(path) };
  });
  const own = repositories[2];
  const policy = JSON.parse(readFileSync(new URL("./ci-test-policy.json", import.meta.url)));
  policy.required = ["tests/required.test.mjs"];
  put(own.path, "scripts/ci-test-policy.json", JSON.stringify(policy));
  put(own.path, "scripts/quality-peer-baseline.json", JSON.stringify({ repositories }));
  for (const file of [
    "tests/required.test.mjs",
    "scripts/run-quality-ci.test.mjs",
    "tests/window-launch-admission.test.mjs",
    "scripts/business-profile-ci.test.mjs",
    "tests/unrelated.test.mjs",
    "tests/unrelated.contract.mjs",
  ])
    put(own.path, file, "export const fixture = true;");
  own.head = commit(own.path);
  const base = own.head;
  const peer = repositories[0];
  put(peer.path, "scripts/ci-source-policy.mjs", "export const revision = 2;");
  peer.head = commit(peer.path);
  const plan = selectCiTests({ repositories, repo: own.repo, base });
  assert.deepEqual(plan.changes, [{ repo: peer.repo, file: "scripts/ci-source-policy.mjs" }]);
  assert.ok(
    plan.reasons[peer.repo + "/scripts/ci-source-policy.mjs"].includes(
      "scripts/business-profile-ci.test.mjs",
    ),
    JSON.stringify(plan),
  );
  assert.ok(plan.files.includes("tests/required.test.mjs"));
  assert.ok(plan.files.includes("scripts/run-quality-ci.test.mjs"));
  assert.ok(!plan.files.includes("tests/unrelated.test.mjs"));
});

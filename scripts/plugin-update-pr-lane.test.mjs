import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  pluginUpdateAuthorization as a,
  selectPluginUpdateLane,
  validatePluginUpdateGroup,
  pluginUpdatePlan,
  desktopBootstrapAuthorization,
  pluginUpdatePlanFor,
} from "./plugin-update-pr-lane.mjs";
const event = {
  event: "pull_request",
  repository: a.repository,
  pullRequest: a.pullRequest,
  branch: a.branch,
  headRepository: a.repository,
  matches: true,
};
test("targeted update acceptance belongs only to PR 78's frozen product and peers", () => {
  assert.equal(selectPluginUpdateLane(event), true);
  for (const change of [
    { branch: "another" },
    { repository: "other/fork" },
    { event: "workflow_dispatch" },
  ])
    assert.equal(selectPluginUpdateLane({ ...event, ...change }), false);
  for (const change of [{ pullRequest: 75 }, { matches: false }, { headRepository: "other/fork" }])
    assert.throws(
      () => selectPluginUpdateLane({ ...event, ...change }),
      /PLUGIN_UPDATE_SCOPE_REJECTED/,
    );
  for (const entries of [
    [],
    Array(3).fill({ repo: "dsh-gea-plugin" }),
    ["dsh-gea-plugin", "dsh-agent-manage", "dsh-agent-workbench"].map((repo) => ({
      repo,
      path: "/missing",
      head: "a".repeat(40),
    })),
  ])
    assert.throws(() => validatePluginUpdateGroup(entries), /PLUGIN_UPDATE_GROUP_REJECTED/);
});
test("only the immediate ordinary merge retains targeted acceptance", () => {
  const merge = {
    event: "push",
    repository: a.repository,
    ref: "refs/heads/main",
    matches: true,
    parents: [a.base, "a".repeat(40)],
  };
  assert.equal(selectPluginUpdateLane(merge), true);
  for (const change of [
    { matches: false },
    { parents: ["b".repeat(40), "a".repeat(40)] },
    { parents: [a.base] },
    { ref: "refs/heads/other" },
  ])
    assert.equal(selectPluginUpdateLane({ ...merge, ...change }), false);
});
test("the fixed plan runs update safety and browser contracts without the broad profile graph", () => {
  const plan = pluginUpdatePlan;
  assert.equal(plan.runtime, false);
  assert.equal(plan.browser, true);
  assert.ok(plan.files.length < 20);
  for (const file of plan.files) assert.ok(readFileSync(file).length > 0, file);
  for (const file of [
    "tests/plugin-update-install.contract.mjs",
    "tests/plugin-update-detail.browser.mjs",
    "tests/plugin-release-source.test.mjs",
    "tests/knowledge-mcp.test.mjs",
  ])
    assert.ok(plan.files.includes(file), file);
  const runner = readFileSync("scripts/run-quality-ci.mjs", "utf8");
  assert.match(runner, /validatePluginUpdateGroup\(candidate.repositories\)/);
  assert.match(runner, /QUALITY_ISOLATION_RESULT/);
});

test("every targeted stage requires public hash admission before preparation", () => {
  for (const stage of ["prepare", "build", "checks", "tests", "summary"]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/run-quality-ci.mjs", "--phase", "plugin-update-pr", "--stage", stage],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CANDIDATE_FINAL_GROUP_REQUIRED/);
  }
});

test("desktop first-install scope is bound to its own PR and frozen packaging source", () => {
  const a = desktopBootstrapAuthorization;
  const input = {
    event: "pull_request",
    repository: a.repository,
    headRepository: a.repository,
    pullRequest: a.pullRequest,
    branch: a.branch,
    matches: true,
  };
  assert.equal(selectPluginUpdateLane(input, a), true);
  assert.throws(() => selectPluginUpdateLane({ ...input, matches: false }, a), /SCOPE_REJECTED/);
  assert.throws(
    () => selectPluginUpdateLane({ ...input, pullRequest: a.pullRequest + 1 }, a),
    /SCOPE_REJECTED/,
  );
  assert.throws(
    () => selectPluginUpdateLane({ ...input, headRepository: "other/fork" }, a),
    /SCOPE_REJECTED/,
  );
  assert.equal(selectPluginUpdateLane({ ...input, branch: "unrelated" }, a), false);
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  const plan = pluginUpdatePlanFor([{ repo: "dsh-gea-plugin", path: process.cwd(), head }]);
  assert.deepEqual(plan.files, [
    "scripts/plugin-update-pr-lane.test.mjs",
    "desktop/company-bootstrap.test.mjs",
    "desktop/official-branding.test.mjs",
    "tests/client-account.test.mjs",
    "tests/base-inventory-resources.test.mjs",
  ]);
  assert.equal(plan.authorization, a);
  assert.equal(plan.browser, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubReader, runSerialMerge } from "./serial-merge-controller.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const request = {
  id: "request-1",
  repository: "owner/repo",
  pr: 1,
  head,
  base: "main",
  actor: "maintainer",
  enqueuedAt: 100,
};
const policy = { approvals: [request], capacity: 2, budgetMs: 1000 };
const pull = {
  number: 1,
  state: "open",
  draft: false,
  merged: false,
  head: { sha: head, repo: { full_name: "owner/repo" } },
  base: { ref: "main", sha: base, repo: { full_name: "owner/repo" } },
  mergeable_state: "behind",
};
const api = {
  readPullRequest: async () => structuredClone(pull),
  readBranch: async () => ({ commit: { sha: base } }),
  readProtection: async () => ({
    enforce_admins: { enabled: true },
    required_status_checks: {
      strict: true,
      checks: [{ context: "candidate-quality", app_id: 15368 }],
    },
  }),
  readChecks: async () => ({
    check_runs: [
      {
        id: 10,
        name: "candidate-quality",
        head_sha: head,
        status: "completed",
        conclusion: "success",
        app: { id: 15368 },
      },
    ],
  }),
};
const active = (phase, overrides = {}) => ({
  request,
  phase,
  startedAt: 200,
  head,
  base,
  ...overrides,
});

test("an approved request binds actor, repository, PR and full head before proposing an update", async () => {
  const result = await runSerialMerge({ queue: [request] }, policy, api, 200);
  assert.equal(result.mode, "dry-run");
  assert.deepEqual(result.decision, {
    action: "would_update",
    requestId: request.id,
    expected_head_sha: head,
    base,
  });
  assert.equal(result.state.active.phase, "updating");
  assert.equal(result.state.active.request.actor, "maintainer");
});

test("the fixture command emits a dry-run decision and rejects unsupported execution modes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "serial-merge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "input.json");
  writeFileSync(
    file,
    JSON.stringify({
      state: { queue: [request] },
      policy,
      responses: {
        [`repos/owner/repo/pulls/1`]: pull,
        "repos/owner/repo/branches/main": { commit: { sha: base } },
      },
    }),
  );
  const run = (mode) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./serial-merge-controller.mjs", import.meta.url)), mode, file],
      { encoding: "utf8" },
    );
  const result = run("--fixture");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision.action, "would_update");
  const write = run("--execute");
  assert.notEqual(write.status, 0);
  assert.match(write.stderr, /fixture.*github/);
});

test("GitHub reader accepts only bound read endpoints and collects every check page", async () => {
  const endpoints = [];
  const reader = createGitHubReader(async (endpoint) => {
    endpoints.push(endpoint);
    if (endpoint.includes("check-runs"))
      return { total_count: 2, check_runs: [{ id: endpoints.length }] };
    return {};
  });
  await reader.readPullRequest(request);
  await reader.readBranch(request);
  await reader.readProtection(request);
  await reader.readCommit(request, head);
  const checks = await reader.readChecks(request, head);
  assert.equal(checks.check_runs.length, 2);
  assert.deepEqual(endpoints, [
    "repos/owner/repo/pulls/1",
    "repos/owner/repo/branches/main",
    "repos/owner/repo/branches/main/protection",
    `repos/owner/repo/commits/${head}`,
    `repos/owner/repo/commits/${head}/check-runs?per_page=100&filter=all&page=1`,
    `repos/owner/repo/commits/${head}/check-runs?per_page=100&filter=all&page=2`,
  ]);
  await assert.rejects(reader.readCommit(request, "../../private"), /invalid/);
});

test("ordinary failures release the slot while uncertain writes keep later requests queued until reconciliation", async () => {
  const second = { ...request, id: "request-2", pr: 2 };
  const configured = { ...policy, approvals: [request, second] };
  for (const [value, reason] of [
    [active("checking", { outcome: "failed" }), "operation_failed"],
    [active("checking", { request: { ...request, cancelled: true } }), "cancelled"],
    [active("checking", { startedAt: 0 }), "timeout"],
  ]) {
    const failed = await runSerialMerge({ active: value, queue: [second] }, configured, api, 1100);
    assert.equal(failed.state.active, null);
    assert.equal(failed.state.finished[0].reason, reason);
    const next = await runSerialMerge(
      failed.state,
      configured,
      { ...api, readPullRequest: async () => ({ ...pull, number: 2 }) },
      1101,
    );
    assert.equal(next.decision.requestId, second.id);
    assert.equal(next.decision.action, "would_update");
  }
  const uncertain = await runSerialMerge(
    { active: active("reconciling"), queue: [second] },
    configured,
    api,
    2000,
  );
  assert.equal(uncertain.decision.action, "paused");
  assert.equal(uncertain.decision.reason, "merge_outcome_unknown");
  assert.equal(uncertain.state.queue[0].id, second.id);
  const unavailable = await runSerialMerge(
    uncertain.state,
    configured,
    {
      ...api,
      readPullRequest: async () => {
        throw new Error("private response");
      },
    },
    2100,
  );
  assert.equal(unavailable.decision.action, "paused");
  assert.equal(JSON.stringify(unavailable).includes("private response"), false);
  const reconciled = await runSerialMerge(
    uncertain.state,
    configured,
    {
      ...api,
      readPullRequest: async () => ({
        ...pull,
        state: "closed",
        merged: true,
        merge_commit_sha: "e".repeat(40),
      }),
    },
    2200,
  );
  assert.equal(reconciled.state.finished[0].reason, "merged");
  assert.equal(reconciled.state.active, null);
  const updateTimeout = await runSerialMerge({ active: active("updating") }, policy, api, 2000);
  assert.equal(updateTimeout.decision.action, "paused");
  assert.equal(updateTimeout.decision.reason, "update_outcome_unknown");
  const cancelledUpdate = await runSerialMerge(
    {
      active: active("updating", {
        request: { ...request, cancelled: true },
      }),
    },
    policy,
    api,
    300,
  );
  assert.equal(cancelledUpdate.decision.action, "paused");
  const changedWhileUnknown = await runSerialMerge(
    { active: active("updating", { outcome: "unknown" }) },
    policy,
    {
      ...api,
      readPullRequest: async () => ({ ...pull, head: { ...pull.head, sha: "c".repeat(40) } }),
      readCommit: async () => ({ parents: [{ sha: "d".repeat(40) }] }),
    },
    300,
  );
  assert.equal(changedWhileUnknown.decision.action, "paused");
  const draftWhileUnknown = await runSerialMerge(
    { active: active("updating", { outcome: "unknown" }) },
    policy,
    { ...api, readPullRequest: async () => ({ ...pull, draft: true }) },
    300,
  );
  assert.equal(draftWhileUnknown.decision.action, "paused");
});

test("an already current PR waits for checks without requesting an unnecessary branch update", async () => {
  const output = await runSerialMerge(
    { queue: [request] },
    policy,
    { ...api, readPullRequest: async () => ({ ...pull, mergeable_state: "clean" }) },
    200,
  );
  assert.equal(output.decision.action, "wait_checks");
  assert.equal(output.state.active.phase, "checking");
});

test("only fresh successful checks from the required app and strict main protection propose merge", async () => {
  const state = { active: active("checking") };
  const cleanApi = { ...api, readPullRequest: async () => ({ ...pull, mergeable_state: "clean" }) };
  const ready = await runSerialMerge(state, policy, cleanApi, 300);
  assert.deepEqual(ready.decision, {
    action: "would_merge",
    requestId: request.id,
    sha: head,
    base,
  });
  assert.equal(ready.state.active.phase, "reconciling");
  const good = (await api.readChecks()).check_runs[0];
  for (const changed of [
    { ...good, head_sha: "c".repeat(40) },
    { ...good, app: { id: 999 } },
    { ...good, status: "queued", conclusion: null },
    { ...good, status: "completed", conclusion: "skipped" },
  ]) {
    const output = await runSerialMerge(
      state,
      policy,
      { ...cleanApi, readChecks: async () => ({ check_runs: [changed] }) },
      300,
    );
    assert.equal(output.decision.action, "wait_checks");
  }
  const retryFailed = await runSerialMerge(
    state,
    policy,
    {
      ...cleanApi,
      readChecks: async () => ({ check_runs: [good, { ...good, id: 11, conclusion: "failure" }] }),
    },
    300,
  );
  assert.equal(retryFailed.state.finished[0].reason, "checks_failed");
  const noStrict = await runSerialMerge(
    state,
    policy,
    {
      ...cleanApi,
      readProtection: async () => ({ required_status_checks: { strict: false, checks: [] } }),
    },
    300,
  );
  assert.equal(noStrict.state.finished[0].reason, "protection_unverified");
  const advanced = await runSerialMerge(
    state,
    policy,
    { ...cleanApi, readBranch: async () => ({ commit: { sha: "d".repeat(40) } }) },
    300,
  );
  assert.equal(advanced.state.finished[0].reason, "base_advanced");
  const unapprovedHead = "c".repeat(40);
  const revoked = await runSerialMerge(
    { active: active("checking", { head: unapprovedHead }) },
    policy,
    {
      ...cleanApi,
      readPullRequest: async () => ({
        ...pull,
        head: { ...pull.head, sha: unapprovedHead },
        mergeable_state: "clean",
      }),
    },
    300,
  );
  assert.equal(revoked.state.finished[0].reason, "updated_head_not_approved");
});

test("accepted asynchronous updates wait and accept only the exact two expected parents", async () => {
  const waiting = await runSerialMerge({ active: active("updating") }, policy, api, 300);
  assert.equal(waiting.decision.action, "wait_update");
  const updatedHead = "c".repeat(40);
  const updatedApi = {
    ...api,
    readPullRequest: async () => ({ ...pull, head: { ...pull.head, sha: updatedHead } }),
    readCommit: async () => ({ parents: [{ sha: head }, { sha: base }] }),
  };
  const updatedPolicy = { ...policy, approvals: [{ ...request, updatedHead }] };
  const updated = await runSerialMerge(
    { active: active("updating") },
    updatedPolicy,
    updatedApi,
    300,
  );
  assert.equal(updated.decision.action, "wait_checks");
  assert.equal(updated.state.active.head, updatedHead);
  assert.equal(updated.state.active.phase, "checking");
  const unproven = await runSerialMerge({ active: active("updating") }, policy, updatedApi, 300);
  assert.equal(unproven.decision.action, "paused");
  assert.equal(unproven.decision.reason, "update_source_unverified");
  for (const parents of [[{ sha: "d".repeat(40) }, { sha: base }], [{ sha: head }]]) {
    const pushed = await runSerialMerge(
      { active: active("updating") },
      policy,
      { ...updatedApi, readCommit: async () => ({ parents }) },
      300,
    );
    assert.equal(pushed.state.finished[0].reason, "unexpected_update");
  }
  const advanced = await runSerialMerge(
    { active: active("updating") },
    updatedPolicy,
    { ...updatedApi, readBranch: async () => ({ commit: { sha: "d".repeat(40) } }) },
    300,
  );
  assert.equal(advanced.state.finished[0].reason, "base_advanced");
});

test("queue admission rejects unapproved identities, stale heads, duplicates and overflow", async () => {
  const second = { ...request, id: "request-2", pr: 2 };
  const third = { ...request, id: "request-3", pr: 3 };
  const cases = [
    [{ ...request, actor: "someone-else" }, "unauthorized"],
    [{ ...request, head: "aaaa" }, "invalid_request"],
    [{ ...request, cancelled: true }, "cancelled"],
  ];
  for (const [item, reason] of cases) {
    const output = await runSerialMerge({ queue: [item] }, policy, api, 200);
    assert.equal(output.decision.action, "idle");
    assert.equal(output.state.finished[0].reason, reason);
  }
  const output = await runSerialMerge(
    { queue: [request, { ...request }, second, third] },
    { ...policy, approvals: [request, second, third] },
    api,
    200,
  );
  assert.deepEqual(
    output.state.queue.map((item) => item.id),
    ["request-2"],
  );
  assert.deepEqual(
    output.state.finished.map((item) => item.reason),
    ["duplicate", "capacity"],
  );
  for (const [change, reason] of [
    [{ draft: true }, "draft"],
    [{ head: { sha: "c".repeat(40), repo: pull.head.repo } }, "head_changed"],
    [{ head: { sha: head, repo: { full_name: "fork/repo" } } }, "fork"],
    [{ base: { ...pull.base, ref: "other" } }, "base_changed"],
  ]) {
    const output = await runSerialMerge(
      { queue: [request] },
      policy,
      { ...api, readPullRequest: async () => ({ ...pull, ...change }) },
      200,
    );
    assert.equal(output.state.active, null);
    assert.equal(output.state.finished[0].reason, reason);
  }
});

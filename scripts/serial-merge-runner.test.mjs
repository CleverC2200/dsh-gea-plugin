import test from "node:test";
import assert from "node:assert/strict";
import { executeSerialMerge } from "./serial-merge-runner.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const updated = "c".repeat(40);
const repository = "CleverC2200/dsh-gea-plugin";
const input = { pr: 300, head, operation: "enqueue" };
function fixture() {
  const calls = [];
  let now = 100000;
  const self = {
    id: 100,
    run_attempt: 1,
    event: "workflow_dispatch",
    path: ".github/workflows/serial-merge.yml",
    head_branch: "main",
    head_sha: "d".repeat(40),
    status: "in_progress",
    repository: { id: 1365221347, full_name: repository },
    actor: { login: "maintainer", id: 42, type: "User" },
  };
  const pull = {
    number: 300,
    id: 3000,
    state: "open",
    draft: false,
    merged: false,
    head: { sha: head, ref: "feature", repo: { id: 1365221347, full_name: repository } },
    base: { sha: base, ref: "main", repo: { id: 1365221347, full_name: repository } },
    mergeable_state: "behind",
  };
  const checks = [
    {
      id: 1,
      name: "candidate-quality",
      head_sha: head,
      app: { id: 15368 },
      check_suite: { id: 1 },
      status: "completed",
      conclusion: "success",
    },
  ];
  const runs = [
    {
      id: 1,
      check_suite_id: 1,
      workflow_id: 391523453,
      path: ".github/workflows/source-quality.yml",
      event: "pull_request",
      head_sha: head,
      head_branch: "feature",
      run_attempt: 1,
      created_at: new Date(0).toISOString(),
      actor: { id: 42, login: "maintainer", type: "User" },
      repository: { id: 1365221347 },
      head_repository: { id: 1365221347 },
      pull_requests: [
        {
          number: 300,
          id: 3000,
          head: { ref: "feature", repo: { id: 1365221347 } },
          base: { ref: "main", repo: { id: 1365221347 } },
        },
      ],
    },
  ];
  const branch = { commit: { sha: base } };
  const protection = {
    enforce_admins: { enabled: true },
    required_status_checks: {
      strict: true,
      checks: [{ context: "candidate-quality", app_id: 15368 }],
    },
  };
  const runtime = {
    identity: async () => ({
      enabled: true,
      self,
      actor: "maintainer",
      actorId: 42,
      checkoutSha: self.head_sha,
      eventSenderId: 42,
    }),
    readJson: async (path) => {
      calls.push(["GET", path]);
      if (path.endsWith("/permission")) return { permission: "write", user: { id: 42 } };
      if (path.endsWith("/pulls/300")) return structuredClone(pull);
      if (path.endsWith("/branches/main/protection")) return structuredClone(protection);
      if (path.endsWith("/branches/main")) return structuredClone(branch);
      if (path.includes("/check-runs?"))
        return { total_count: checks.length, check_runs: structuredClone(checks) };
      if (path.includes("/actions/runs?check_suite_id=")) {
        const suite = Number(new URLSearchParams(path.split("?")[1]).get("check_suite_id"));
        return {
          total_count: 1,
          workflow_runs: structuredClone(runs.filter((run) => run.check_suite_id === suite)),
        };
      }
      if (path.includes("/actions/workflows/391523453/runs?"))
        return { total_count: runs.length, workflow_runs: structuredClone(runs) };
      if (path.match(/\/actions\/runs\/\d+\/attempts\/1$/))
        return structuredClone(runs.find((run) => run.id === Number(path.split("/").at(-3))));
      if (path.endsWith(`/commits/${updated}`))
        return { sha: updated, parents: [{ sha: head }, { sha: base }] };
      throw Error("unexpected fixture endpoint");
    },
    restore: async () => ({ records: [] }),
    checkpoint: async (state, kind) => {
      calls.push(["upload", kind, structuredClone(state)]);
      return { id: calls.length };
    },
    update: async (request, expected) => {
      calls.push(["update", expected]);
      pull.head.sha = updated;
      pull.mergeable_state = "clean";
      checks.splice(0, checks.length, {
        ...checks[0],
        id: 2,
        head_sha: updated,
        check_suite: { id: 2 },
      });
      runs.push({
        ...runs[0],
        id: 2,
        check_suite_id: 2,
        head_sha: updated,
        created_at: new Date(now + 1000).toISOString(),
        actor: { id: 347241815, login: "cleverc2200-gea-serial-merge[bot]", type: "Bot" },
      });
      return { outcome: "accepted" };
    },
    merge: async (request, expected) => {
      calls.push(["merge", expected]);
      pull.merged = true;
      pull.state = "closed";
      pull.merge_commit_sha = "e".repeat(40);
      return { outcome: "accepted" };
    },
    guardWrites: async (request) => {
      assert.equal(request.repository, repository);
      assert.equal(request.pr, 300);
    },
    clock: {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    },
    signal: new AbortController().signal,
  };
  return { runtime, calls, self, pull, checks, protection, runs, branch };
}

test("the trusted entry rejects self-reported approvals when the actual repository actor cannot write", async () => {
  const f = fixture();
  f.runtime.readJson = async () => ({ permission: "read", user: { id: 42 } });
  const result = await executeSerialMerge(
    { ...input, approvals: [{ actor: "maintainer" }] },
    f.runtime,
  );
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "actor_not_authorized");
  assert.equal(
    f.calls.some(([call]) => ["update", "merge"].includes(call)),
    false,
  );
  assert.equal(f.calls.at(-1)[0], "upload");
  assert.equal(f.calls.at(-1)[1], "terminal");
  assert.equal(f.calls.at(-1)[2].noWrite, true);
});

test("green initial head updates once, verifies App source, waits for exact new checks and persists each intent before writing", async () => {
  const f = fixture();
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.status, "finished");
  assert.equal(result.reason, "merged");
  assert.deepEqual(
    f.calls.filter(([call]) => ["update", "merge"].includes(call)),
    [
      ["update", head],
      ["merge", updated],
    ],
  );
  for (const name of ["update", "merge"]) {
    const index = f.calls.findIndex(([call]) => call === name);
    assert.equal(f.calls[index - 1][0], "upload");
    assert.equal(f.calls[index - 1][1], "intent");
    assert.equal(f.calls[index - 1][2].intent.operation, name);
  }
  assert.equal(f.calls.at(-1)[1], "terminal");
});

test("red or unfinished initial head checks end before update instead of occupying the waiting budget", async () => {
  for (const [status, conclusion] of [
    ["completed", "failure"],
    ["queued", null],
  ]) {
    const f = fixture();
    Object.assign(f.checks[0], { status, conclusion });
    const result = await executeSerialMerge(input, f.runtime);
    assert.equal(result.status, "finished");
    assert.equal(result.reason, "initial_checks_not_ready");
    assert.equal(
      f.calls.some(([call]) => ["update", "merge"].includes(call)),
      false,
    );
    assert.equal(f.calls.at(-1)[0], "upload");
    assert.equal(f.calls.at(-1)[1], "terminal");
  }
});

test("main, repository, controller version and service actor identity are required before admission", async () => {
  for (const patch of [
    { enabled: false },
    { actorId: 99 },
    { eventSenderId: 99 },
    { checkoutSha: "e".repeat(40) },
    { self: { head_branch: "feature" } },
    { self: { event: "pull_request" } },
    { self: { repository: { id: 1, full_name: repository } } },
  ]) {
    const f = fixture();
    const original = await f.runtime.identity();
    f.runtime.identity = async () => ({
      ...original,
      ...patch,
      self: { ...original.self, ...patch.self },
    });
    const result = await executeSerialMerge(input, f.runtime);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "trusted_main_required");
    assert.equal(f.calls.length, 0);
  }
});

test("protected candidates and malformed requests cannot be admitted through dispatch inputs", async () => {
  for (const request of [
    { ...input, pr: 197 },
    { ...input, pr: 202 },
    { ...input, head: "aaaa" },
    { ...input, pr: "../1" },
  ]) {
    const f = fixture();
    const result = await executeSerialMerge(request, f.runtime);
    assert.equal(result.status, "rejected");
    assert.equal(result.reason, "request_not_admitted");
    assert.equal(
      f.calls.some(([call]) => ["update", "merge"].includes(call)),
      false,
    );
  }
});

test("an unknown merge survives cancellation and a later run reconciles it without resending or admitting another write", async () => {
  const f = fixture();
  f.runtime.merge = async () => {
    f.calls.push(["merge", updated]);
    return { outcome: "unknown" };
  };
  const sleep = f.runtime.clock.sleep;
  f.runtime.clock.sleep = (ms) => sleep(f.calls.some(([call]) => call === "merge") ? 2700000 : ms);
  assert.equal((await executeSerialMerge(input, f.runtime)).status, "paused");
  const pending = f.calls.at(-1)[2];
  assert.equal(pending.state.active.phase, "reconciling");
  for (const merged of [false, true]) {
    const next = fixture();
    next.self.id = 101;
    next.runtime.restore = async () => ({ records: [structuredClone(pending)] });
    next.runtime.clock.now = () => 9000000;
    Object.assign(next.pull, {
      merged,
      state: merged ? "closed" : "open",
      merge_commit_sha: "e".repeat(40),
    });
    next.pull.head.sha = updated;
    const read = next.runtime.readJson;
    next.runtime.readJson = (path) =>
      path.endsWith("/permission") ? { permission: "admin", user: { id: 42 } } : read(path);
    const blocked = await executeSerialMerge(input, next.runtime);
    assert.equal(blocked.status, "paused");
    assert.equal(blocked.reason, "prior_write_unresolved");
    const recovered = await executeSerialMerge(
      { operation: "recover", recoveryRequestId: "100" },
      next.runtime,
    );
    assert.equal(recovered.status, merged ? "finished" : "paused");
    assert.equal(recovered.reason, merged ? "merged" : "merge_outcome_unknown");
    assert.equal(
      next.calls.some(([call]) => ["update", "merge"].includes(call)),
      false,
    );
  }
});

test("a rerun losing repository permission cannot publish a no-write terminal over its old unknown intent", async () => {
  const f = fixture();
  const request = {
    id: "100",
    repository,
    pr: 300,
    head,
    base: "main",
    actor: "maintainer",
    actorId: 42,
    enqueuedAt: 100000,
  };
  f.self.run_attempt = 2;
  f.runtime.restore = async () => ({
    records: [
      {
        schemaVersion: 1,
        request,
        revision: 1,
        intent: { operation: "merge", head, base, at: 100000, beforeRuns: [] },
        state: {
          queue: [],
          active: { request, phase: "reconciling", head, base, startedAt: 100000 },
          finished: [],
        },
      },
    ],
  });
  f.runtime.readJson = async () => ({ permission: "read", user: { id: 42 } });
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.status, "paused");
  assert.equal(
    f.calls.some(([call]) => call === "upload"),
    false,
  );
});

test("a confirmed rejected update releases without waiting for another read or retrying the write", async () => {
  const f = fixture();
  f.runtime.update = async () => {
    f.calls.push(["update", head]);
    return { outcome: "failed", httpStatus: 422 };
  };
  const read = f.runtime.readJson;
  f.runtime.readJson = (path) => {
    if (path.endsWith("/pulls/300") && f.calls.some(([call]) => call === "update"))
      throw Error("later read unavailable");
    return read(path);
  };
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.status, "finished");
  assert.equal(result.reason, "operation_failed");
  assert.equal(f.calls.filter(([call]) => call === "update").length, 1);
  assert.equal(f.calls.at(-1)[1], "terminal");
});

test("metadata runs and another workflow's same-name green cannot replace the latest formal failure", async () => {
  const f = fixture();
  f.checks[0].conclusion = "failure";
  f.checks.push(
    { ...f.checks[0], id: 99, conclusion: "success", check_suite: { id: 99 } },
    {
      ...f.checks[0],
      id: 100,
      name: "source-plan",
      conclusion: "success",
      check_suite: { id: 100 },
    },
  );
  f.runs.push(
    { ...f.runs[0], id: 99, check_suite_id: 99, workflow_id: 999 },
    { ...f.runs[0], id: 100, check_suite_id: 100 },
  );
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.reason, "initial_checks_not_ready");
  assert.equal(
    f.calls.some(([call]) => call === "update"),
    false,
  );
});

test("source proof rejects author identity, triggering_actor substitution, stale runs and wrong PR association", async () => {
  for (const patch of [
    { actor: { id: 42, login: "maintainer", type: "User" }, triggering_actor: { id: 347241815 } },
    { created_at: new Date(0).toISOString() },
    { pull_requests: [{ number: 301, id: 3001 }] },
  ]) {
    const f = fixture();
    const update = f.runtime.update;
    f.runtime.update = async (...args) => {
      const result = await update(...args);
      Object.assign(f.runs.at(-1), patch);
      return result;
    };
    const sleep = f.runtime.clock.sleep;
    f.runtime.clock.sleep = () => sleep(2700000);
    const result = await executeSerialMerge(input, f.runtime);
    assert.equal(result.status, "paused");
    assert.equal(f.calls.filter(([call]) => call === "update").length, 1);
    assert.equal(
      f.calls.some(([call]) => call === "merge"),
      false,
    );
  }
});

test("a verified App update still needs an independently successful new-head check and ordinary failure releases", async () => {
  const f = fixture();
  const update = f.runtime.update;
  f.runtime.update = async (...args) => {
    const result = await update(...args);
    f.checks[0].conclusion = "failure";
    return result;
  };
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.status, "finished");
  assert.equal(result.reason, "checks_failed");
  assert.equal(
    f.calls.some(([call]) => call === "merge"),
    false,
  );
  assert.equal(f.calls.at(-1)[1], "terminal");
});

test("failed native intent upload prevents the App call even when all checks passed", async () => {
  const f = fixture();
  f.runtime.checkpoint = async () => {
    throw Error("artifact API unavailable");
  };
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.status, "paused");
  assert.equal(
    f.calls.some(([call]) => ["update", "merge"].includes(call)),
    false,
  );
});

test("cancellation before writing releases, while cancellation after an acknowledged intent remains paused", async () => {
  for (const afterIntent of [false, true]) {
    const f = fixture();
    const abort = new AbortController();
    f.runtime.signal = abort.signal;
    if (afterIntent) {
      const checkpoint = f.runtime.checkpoint;
      f.runtime.checkpoint = async (record, kind) => {
        const receipt = await checkpoint(record, kind);
        if (kind === "intent") abort.abort();
        return receipt;
      };
    } else abort.abort();
    const result = await executeSerialMerge(input, f.runtime);
    assert.equal(result.status, afterIntent ? "paused" : "finished");
    assert.equal(
      f.calls.some(([call]) => ["update", "merge"].includes(call)),
      false,
    );
    assert.equal(f.calls.at(-1)[1], afterIntent ? "intent" : "terminal");
  }
});

test("ordinary guard rejection and waiting timeout release without an unknown write hold", async () => {
  for (const timeout of [false, true]) {
    const f = fixture();
    if (timeout) {
      const update = f.runtime.update;
      f.runtime.update = async (...args) => {
        const result = await update(...args);
        f.checks[0].status = "in_progress";
        return result;
      };
      const sleep = f.runtime.clock.sleep;
      f.runtime.clock.sleep = () => sleep(1000000);
    } else
      f.runtime.guardWrites = async () => {
        throw Error("protection changed before intent");
      };
    const result = await executeSerialMerge(input, f.runtime);
    assert.equal(result.status, "finished");
    assert.equal(result.reason, timeout ? "timeout" : "read_failed");
    assert.equal(f.calls.at(-1)[1], "terminal");
    assert.equal(f.calls.at(-1)[2].state.active, null);
    assert.equal(
      f.calls.some(([call]) => call === "merge"),
      false,
    );
  }
});

test("an unavailable admission read leaves an acknowledged no-write terminal instead of an unresolved old run", async () => {
  const f = fixture();
  const read = f.runtime.readJson;
  f.runtime.readJson = (path) => {
    if (path.endsWith("/pulls/300")) throw Error("read unavailable");
    return read(path);
  };
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.reason, "read_failed");
  assert.equal(f.calls.at(-1)[1], "terminal");
  assert.equal(f.calls.at(-1)[2].noWrite, true);
});

test("CI reruns keep the first App source proof and cannot replace its original actor or creation time", async () => {
  const f = fixture();
  let first;
  const update = f.runtime.update;
  f.runtime.update = async (...args) => {
    const result = await update(...args);
    first = structuredClone(f.runs.at(-1));
    Object.assign(f.runs.at(-1), { run_attempt: 3, triggering_actor: { id: 42 } });
    return result;
  };
  const read = f.runtime.readJson;
  f.runtime.readJson = (path) =>
    path.endsWith("/actions/runs/2/attempts/1") ? structuredClone(first) : read(path);
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.reason, "merged");
  assert.equal(f.calls.at(-1)[2].proof.attempt, 1);
  assert.equal(f.calls.at(-1)[2].proof.actorId, 347241815);
});

test("a queued dispatch keeps its trusted controller snapshot while reading the advanced target main separately", async () => {
  const f = fixture();
  const dispatchedMain = f.self.head_sha;
  f.branch.commit.sha = "f".repeat(40);
  f.pull.base.sha = f.branch.commit.sha;
  f.pull.mergeable_state = "clean";
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.reason, "merged");
  assert.deepEqual(
    f.calls.filter(([call]) => ["update", "merge"].includes(call)),
    [["merge", head]],
  );
  assert.equal(f.calls.at(-1)[2].owner.controllerSha, dispatchedMain);
  assert.notEqual(dispatchedMain, f.branch.commit.sha);
});

test("a prior interrupted check with no pending write and a confirmed write failure release before the next request", async () => {
  for (const failed of [false, true]) {
    const f = fixture();
    const request = {
      ...input,
      id: "99",
      repository,
      base: "main",
      actor: "maintainer",
      actorId: 42,
      enqueuedAt: 0,
    };
    const previous = {
      schemaVersion: 1,
      request,
      revision: 2,
      owner: { runId: 99, attempt: 1, controllerSha: "d".repeat(40) },
      state: {
        queue: [],
        active: {
          request,
          phase: failed ? "updating" : "checking",
          head,
          base,
          startedAt: 0,
          ...(failed ? { outcome: "failed" } : {}),
        },
        finished: [],
      },
      intent: failed ? { operation: "update", head, base, at: 0, beforeRuns: [] } : null,
    };
    f.runtime.restore = async () => ({ records: [previous] });
    f.pull.mergeable_state = "clean";
    const result = await executeSerialMerge(input, f.runtime);
    assert.equal(result.reason, "merged");
    const terminal = f.calls.find(([call]) => call === "upload");
    assert.equal(terminal[1], "terminal");
    assert.equal(terminal[2].request.id, "99");
    assert.equal(terminal[2].state.active, null);
    assert.equal(
      terminal[2].state.finished.at(-1).reason,
      failed ? "operation_failed" : "interrupted_without_pending_write",
    );
  }
});

test("cancellation after the App update is confirmed releases without merging or holding an unknown intent", async () => {
  const f = fixture();
  const abort = new AbortController();
  f.runtime.signal = abort.signal;
  const checkpoint = f.runtime.checkpoint;
  f.runtime.checkpoint = async (record, kind) => {
    const receipt = await checkpoint(record, kind);
    if (kind === "state" && record.state.active?.phase === "checking" && !record.intent)
      abort.abort();
    return receipt;
  };
  const result = await executeSerialMerge(input, f.runtime);
  assert.equal(result.status, "finished");
  assert.equal(result.reason, "cancelled");
  assert.equal(f.calls.at(-1)[1], "terminal");
  assert.equal(f.calls.at(-1)[2].state.active, null);
  assert.equal(
    f.calls.some(([call]) => call === "merge"),
    false,
  );
});

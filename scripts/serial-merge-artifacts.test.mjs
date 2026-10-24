import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSerialMergeArtifacts } from "./serial-merge-artifacts.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "serial-artifact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const owner = { runId: 100, attempt: 1, workflowId: 55, controllerSha: "a".repeat(40) };
  const now = () => Date.parse("2026-10-24T06:00:00Z");
  const policy = {
    repository: "CleverC2200/dsh-gea-plugin",
    repositoryId: 1365221347,
    controllerWorkflowPath: ".github/workflows/serial-merge.yml",
    maxHistoryRuns: 1000,
    retentionDays: 30,
  };
  const request = {
    id: "100",
    repository: policy.repository,
    pr: 7,
    head: "b".repeat(40),
    base: "main",
    actor: "author",
    actorId: 7,
    enqueuedAt: now() - 1000,
    sourceBranch: "codex/change",
    pullId: 14,
  };
  const record = {
    schemaVersion: 1,
    request,
    revision: 1,
    owner,
    state: {
      queue: [],
      active: {
        request,
        phase: "updating",
        head: request.head,
        base: "c".repeat(40),
        startedAt: now() - 1000,
      },
      finished: [],
    },
    intent: {
      operation: "update",
      head: request.head,
      base: "c".repeat(40),
      at: now(),
      beforeRuns: [],
    },
  };
  const calls = [];
  const runs = new Map();
  const metadata = new Map();
  const bytes = new Map();
  const jobs = new Map();
  const attempts = new Map();
  const digest = "d".repeat(64);
  const branchRef = {
    ref: "refs/heads/main",
    object: { type: "commit", sha: owner.controllerSha },
  };
  const comparisons = new Map();
  const addRun = (id, extra = {}) => {
    const run = {
      id,
      run_attempt: 1,
      workflow_id: owner.workflowId,
      path: policy.controllerWorkflowPath,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: owner.controllerSha,
      repository: { id: policy.repositoryId, full_name: policy.repository },
      head_repository: { id: policy.repositoryId, full_name: policy.repository },
      actor: { id: request.actorId, login: request.actor, type: "User" },
      status: "in_progress",
      conclusion: null,
      ...extra,
    };
    runs.set(id, run);
    return run;
  };
  addRun(100);
  const artifact = {
    uploadArtifact: async (name, files, root, options) => {
      calls.push(["upload", name, options]);
      const id = 7 + metadata.size;
      const content = readFileSync(files[0]);
      bytes.set(id, content);
      const body = JSON.parse(content);
      metadata.set(id, {
        id,
        name,
        expired: false,
        size_in_bytes: content.length,
        created_at: "2026-10-24T05:59:00Z",
        expires_at: "2026-11-23T05:59:00Z",
        digest: "sha256:" + digest,
        workflow_run: {
          id: body.owner.runId,
          repository_id: policy.repositoryId,
          head_repository_id: policy.repositoryId,
          head_branch: runs.get(body.owner.runId).head_branch,
          head_sha: body.owner.controllerSha,
        },
      });
      return { id, size: content.length, digest };
    },
    downloadArtifact: async (id, options) => {
      calls.push(["download", id, options]);
      writeFileSync(join(options.path, "state.json"), bytes.get(id));
      return {
        downloadPath: options.path,
        digestMismatch: options.expectedHash !== "sha256:" + digest,
      };
    },
  };
  const readJson = async (path) => {
    calls.push(["GET", path]);
    if (path.includes("/git/ref/heads/")) return structuredClone(branchRef);
    if (path.includes("/compare/")) {
      const result = comparisons.get(path.split("/compare/")[1].split("?")[0]);
      if (result instanceof Error) throw result;
      if (!result) throw Error("missing ancestry proof");
      return structuredClone(result);
    }
    const artifactId = /\/actions\/artifacts\/(\d+)$/.exec(path);
    if (artifactId) return structuredClone(metadata.get(Number(artifactId[1])));
    const attempt = /\/actions\/runs\/(\d+)\/attempts\/(\d+)$/.exec(path);
    if (attempt)
      return {
        ...structuredClone(runs.get(Number(attempt[1]))),
        ...structuredClone(attempts.get(attempt[1] + "/" + attempt[2]) ?? {}),
        run_attempt: Number(attempt[2]),
      };
    if (path.includes("/actions/workflows/55/runs?"))
      return {
        total_count: runs.size,
        workflow_runs: [...runs.values()].map((run) => structuredClone(run)),
      };
    const artifacts = /\/actions\/runs\/(\d+)\/artifacts\?/.exec(path);
    if (artifacts) {
      const list = [...metadata.values()].filter(
        (item) => item.workflow_run.id === Number(artifacts[1]),
      );
      return { total_count: list.length, artifacts: structuredClone(list) };
    }
    const jobAttempt = /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?/.exec(path);
    if (jobAttempt) {
      const list = jobs.get(jobAttempt[1] + "/" + jobAttempt[2]) ?? [];
      return { total_count: list.length, jobs: structuredClone(list) };
    }
    throw Error("unexpected fixture endpoint: " + path);
  };
  return {
    directory,
    owner,
    record,
    calls,
    artifact,
    readJson,
    policy,
    now,
    runs,
    addRun,
    metadata,
    bytes,
    jobs,
    attempts,
    digest,
    branchRef,
    comparisons,
  };
}

test("a checkpoint becomes durable only after native upload and server artifact acknowledgement", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  const receipt = await store.save(f.record, "intent");
  assert.equal(receipt.id, 7);
  assert.equal(f.calls.at(-1)[1], "repos/CleverC2200/dsh-gea-plugin/actions/artifacts/7");
  f.artifact.uploadArtifact = async () => {
    throw Error("runtime rejected");
  };
  await assert.rejects(store.save({ ...f.record, revision: 2 }, "intent"));
  assert.equal(
    f.calls.filter(([method, path]) => method === "GET" && path.endsWith("/artifacts/7")).length,
    1,
  );
});

test("an upload acknowledged under another controller SHA never returns a durable checkpoint", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({
    ...f,
    githubToken: "fixture-read-token",
    readJson: async (path) => {
      const result = await f.readJson(path);
      if (path.endsWith("/artifacts/7")) result.workflow_run.head_sha = "f".repeat(40);
      return result;
    },
  });
  await assert.rejects(store.save(f.record, "intent"), /checkpoint_not_acknowledged/);
});

test("cross-run download uses the read token and rejects a state belonging to another upload owner", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  await store.save(f.record, "intent");
  const metadata = await f.readJson("repos/CleverC2200/dsh-gea-plugin/actions/artifacts/7");
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  });
  assert.deepEqual(await later.read(metadata), f.record);
  const download = f.calls.find(([method]) => method === "download");
  assert.equal(download[2].findBy.workflowRunId, 100);
  assert.equal(download[2].findBy.token, "fixture-read-token");
  assert.equal(download[2].expectedHash, "sha256:" + f.digest);
  f.artifact.downloadArtifact = async (id, options) => {
    writeFileSync(
      join(options.path, "state.json"),
      JSON.stringify({ ...f.record, owner: { ...f.owner, runId: 999 } }),
    );
    return { downloadPath: options.path, digestMismatch: false };
  };
  await assert.rejects(later.read(metadata), /invalid_checkpoint/);
});

test("restore selects the latest trusted revision and retains an unknown intent despite native cancellation", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  await store.save(f.record, "intent");
  const latest = structuredClone(f.record);
  latest.revision = 2;
  latest.state.active.outcome = "unknown";
  await store.save(latest, "state");
  f.runs.get(100).status = "completed";
  f.runs.get(100).conclusion = "cancelled";
  f.addRun(101);
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  });
  assert.deepEqual(await later.restore(), { records: [latest] });
});

test("a native download digest mismatch is a persistence failure rather than a usable state", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  await store.checkpoint(f.record, "intent");
  const download = f.artifact.downloadArtifact;
  for (const digestMismatch of [true, undefined]) {
    f.artifact.downloadArtifact = async (...args) => ({
      ...(await download(...args)),
      digestMismatch,
    });
    await assert.rejects(store.read(f.metadata.get(7)), /checkpoint_digest_mismatch/);
  }
});

test("incomplete state or a different nested request is rejected before creating a durable artifact", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  for (const change of [
    (record) => {
      record.schemaVersion = 2;
    },
    (record) => {
      record.request.id = 100;
    },
    (record) => {
      delete record.request.sourceBranch;
    },
    (record) => {
      record.state.queue = null;
    },
    (record) => {
      record.state.active.request = { ...record.state.active.request, pr: 8 };
    },
    (record) => {
      delete record.intent;
    },
    (record) => {
      delete record.state.active.head;
    },
    (record) => {
      record.intent.head = "f".repeat(40);
    },
  ]) {
    const record = structuredClone(f.record);
    change(record);
    await assert.rejects(store.checkpoint(record, "intent"), /invalid_checkpoint/);
  }
  assert.equal(
    f.calls.some(([method]) => method === "upload"),
    false,
  );
});

test("server acknowledgement binds repository, branch, expiry and the native upload digest", async (t) => {
  for (const change of [
    (item) => {
      item.workflow_run.head_branch = "other";
    },
    (item) => {
      item.workflow_run.repository_id = 1;
    },
    (item) => {
      item.expires_at = "2026-10-23T00:00:00Z";
    },
    (item) => {
      item.digest = "sha256:" + "f".repeat(64);
    },
    (item) => {
      delete item.expired;
    },
  ]) {
    const f = fixture(t);
    const store = createSerialMergeArtifacts({
      ...f,
      githubToken: "fixture-read-token",
      readJson: async (path) => {
        const result = await f.readJson(path);
        if (path.endsWith("/artifacts/7")) change(result);
        return result;
      },
    });
    await assert.rejects(store.checkpoint(f.record, "intent"), /checkpoint_not_acknowledged/);
  }
});

test("expired or disappeared latest history cannot be restored as an empty queue", async (t) => {
  for (const fault of ["expired", "disappeared"]) {
    const f = fixture(t);
    const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
    await store.checkpoint(f.record, "intent");
    if (fault === "expired") f.metadata.get(7).expires_at = "2026-10-23T00:00:00Z";
    f.addRun(101);
    const later = createSerialMergeArtifacts({
      ...f,
      owner: { ...f.owner, runId: 101 },
      githubToken: "fixture-read-token",
      readJson: async (path) =>
        fault === "disappeared" && path.endsWith("/artifacts/7") ? null : f.readJson(path),
    });
    await assert.rejects(later.restore(), /checkpoint_not_readable/);
  }
});

test("a trusted invalid-request terminal without intent is restored as finished", async (t) => {
  const f = fixture(t);
  const request = { id: "100", repository: f.policy.repository, actor: "author", actorId: 7 };
  const terminal = {
    schemaVersion: 1,
    request,
    revision: 1,
    owner: f.owner,
    noWrite: true,
    state: { queue: [], active: null, finished: [{ request, reason: "request_not_admitted" }] },
  };
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    terminal,
    "terminal",
  );
  f.addRun(101);
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  });
  assert.deepEqual(await later.restore(), { records: [terminal] });
});

test("only server-confirmed never-started attempts can omit a checkpoint", async (t) => {
  for (const status of ["skipped", "queued"]) {
    const f = fixture(t);
    Object.assign(f.runs.get(100), {
      status: status === "skipped" ? "completed" : status,
      conclusion: status === "skipped" ? status : null,
    });
    f.jobs.set("100/1", [
      {
        id: 1001,
        status: status === "skipped" ? "completed" : status,
        conclusion: status === "skipped" ? status : null,
        runner_id: null,
        steps: [],
      },
    ]);
    f.addRun(101);
    const later = createSerialMergeArtifacts({
      ...f,
      owner: { ...f.owner, runId: 101 },
      githubToken: "fixture-read-token",
    });
    assert.deepEqual(await later.restore(), { records: [] });
    f.jobs.get("100/1")[0].steps.push({ status: "completed", name: "Controller action" });
    await assert.rejects(later.restore(), /checkpoint_missing/);
  }
  for (const conclusion of ["failure", "cancelled", "success"]) {
    const f = fixture(t);
    Object.assign(f.runs.get(100), { status: "completed", conclusion });
    f.addRun(101);
    await assert.rejects(
      createSerialMergeArtifacts({
        ...f,
        owner: { ...f.owner, runId: 101 },
        githubToken: "fixture-read-token",
      }).restore(),
      /checkpoint_missing/,
    );
  }
});

test("only a verified checking state or confirmed failure may omit a write intent", async (t) => {
  const f = fixture(t);
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  const state = { ...structuredClone(f.record), intent: null };
  await assert.rejects(store.checkpoint(state, "state"), /invalid_checkpoint/);
  state.state.active.phase = "checking";
  assert.ok((await store.checkpoint(state, "state")).id);
  state.state.active.outcome = "unknown";
  await assert.rejects(store.checkpoint(state, "state"), /invalid_checkpoint/);
  state.revision = 2;
  state.state.active.phase = "updating";
  state.state.active.outcome = "failed";
  assert.ok((await store.checkpoint(state, "state")).id);
});

test("older controller commits remain readable and newer trusted terminal revisions replace intent", async (t) => {
  const f = fixture(t);
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    f.record,
    "intent",
  );
  f.branchRef.object.sha = "f".repeat(40);
  f.comparisons.set(f.owner.controllerSha + "..." + f.branchRef.object.sha, {
    status: "ahead",
    base_commit: { sha: f.owner.controllerSha },
    merge_base_commit: { sha: f.owner.controllerSha },
  });
  f.addRun(101, { head_sha: "f".repeat(40) });
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101, controllerSha: "f".repeat(40) },
    githubToken: "fixture-read-token",
  });
  assert.deepEqual((await later.restore()).records, [f.record]);
  const terminal = {
    ...f.record,
    revision: 2,
    state: { queue: [], active: null, finished: [{ request: f.record.request, reason: "merged" }] },
  };
  await later.checkpoint(terminal, "terminal");
  f.metadata.get(7).expired = true;
  const restored = await later.restore();
  assert.equal(restored.records.length, 1);
  assert.equal(restored.records[0].revision, 2);
  assert.equal(restored.records[0].owner.controllerSha, "f".repeat(40));
  assert.equal(restored.records[0].state.active, null);
});

test("a queued rerun does not erase an earlier attempt's unknown write or missing evidence", async (t) => {
  const f = fixture(t);
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    f.record,
    "intent",
  );
  Object.assign(f.runs.get(100), { run_attempt: 2, status: "queued", conclusion: null });
  f.attempts.set("100/1", { status: "completed", conclusion: "cancelled" });
  f.addRun(101);
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  });
  assert.deepEqual((await later.restore()).records, [f.record]);
  f.metadata.clear();
  await assert.rejects(later.restore(), /checkpoint_missing/);
});

test("history pagination is complete and its configured bound cannot discard older runs", async (t) => {
  const f = fixture(t);
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    f.record,
    "intent",
  );
  f.addRun(101);
  let incomplete = false;
  const readJson = async (path) => {
    if (!path.includes("/workflows/55/runs?")) return f.readJson(path);
    return {
      total_count: 2,
      workflow_runs: path.endsWith("page=1")
        ? [structuredClone(f.runs.get(100))]
        : incomplete
          ? []
          : [structuredClone(f.runs.get(101))],
    };
  };
  const config = {
    ...f,
    readJson,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  };
  assert.deepEqual((await createSerialMergeArtifacts(config).restore()).records, [f.record]);
  incomplete = true;
  await assert.rejects(createSerialMergeArtifacts(config).restore(), /history_incomplete/);
  await assert.rejects(
    createSerialMergeArtifacts({ ...config, policy: { ...f.policy, maxHistoryRuns: 1 } }).restore(),
    /history_incomplete/,
  );
});

test("two owners claiming the same request revision cannot choose a convenient winner", async (t) => {
  const f = fixture(t);
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    f.record,
    "intent",
  );
  f.addRun(101);
  await createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  }).checkpoint(
    {
      ...f.record,
      state: {
        queue: [],
        active: null,
        finished: [{ request: f.record.request, reason: "merged" }],
      },
    },
    "terminal",
  );
  f.addRun(102);
  await assert.rejects(
    createSerialMergeArtifacts({
      ...f,
      owner: { ...f.owner, runId: 102 },
      githubToken: "fixture-read-token",
    }).restore(),
    /checkpoint_ambiguous/,
  );
});

test("restore ignores explicitly untrusted branches but rejects inconsistent trusted run metadata", async (t) => {
  const f = fixture(t);
  f.addRun(99, { head_branch: "untrusted" });
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  assert.deepEqual(await store.restore(), { records: [] });
  assert.equal(
    f.calls.some(([, path]) => path.includes("/runs/99/artifacts")),
    false,
  );
  Object.assign(f.runs.get(99), { head_branch: "main", workflow_id: 999 });
  await assert.rejects(store.restore(), /untrusted_controller_run/);
});

test("a pinned production workflow ID cannot silently begin a different controller history", (t) => {
  const f = fixture(t);
  assert.throws(
    () => createSerialMergeArtifacts({ ...f, policy: { ...f.policy, controllerWorkflowId: 999 } }),
    /invalid_artifact_policy/,
  );
  assert.ok(
    createSerialMergeArtifacts({
      ...f,
      policy: { ...f.policy, controllerWorkflowId: f.owner.workflowId },
    }),
  );
});

test("an obsolete artifact still cannot certify a different repository's attempt", async (t) => {
  const f = fixture(t);
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    f.record,
    "intent",
  );
  f.addRun(101);
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 101 },
    githubToken: "fixture-read-token",
  });
  await later.checkpoint(
    {
      ...f.record,
      revision: 2,
      state: {
        queue: [],
        active: null,
        finished: [{ request: f.record.request, reason: "merged" }],
      },
    },
    "terminal",
  );
  f.metadata.get(7).workflow_run.repository_id = 999;
  await assert.rejects(later.restore(), /invalid_checkpoint/);
});

test("an off-main producer cannot replace a trusted unknown intent with a higher terminal revision", async (t) => {
  const f = fixture(t);
  await createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).checkpoint(
    f.record,
    "intent",
  );
  const attackerSha = "f".repeat(40);
  f.addRun(101, { head_sha: attackerSha, status: "completed", conclusion: "success" });
  const forged = {
    ...structuredClone(f.record),
    revision: 2,
    owner: { ...f.owner, runId: 101, controllerSha: attackerSha },
    state: {
      queue: [],
      active: null,
      finished: [{ request: f.record.request, reason: "forged_terminal" }],
    },
  };
  delete forged.intent;
  const file = join(f.directory, "forged.json");
  writeFileSync(file, JSON.stringify(forged));
  await f.artifact.uploadArtifact("gea-serial-100-2-101-1-terminal", [file], f.directory, {});
  f.comparisons.set(attackerSha + "..." + f.owner.controllerSha, {
    status: "diverged",
    base_commit: { sha: attackerSha },
    merge_base_commit: { sha: "e".repeat(40) },
  });
  f.addRun(102);
  const later = createSerialMergeArtifacts({
    ...f,
    owner: { ...f.owner, runId: 102 },
    githubToken: "fixture-read-token",
  });
  await assert.rejects(later.restore(), /untrusted_controller_source/);
  assert.equal(JSON.parse(f.bytes.get(7)).state.active.phase, "updating");
  assert.equal(
    f.calls.some(([method, id]) => method === "download" && id === 8),
    false,
  );
});

test("protected branch ancestry is required, cached per snapshot and unavailable proof stays closed", async (t) => {
  const f = fixture(t);
  const tip = "f".repeat(40);
  f.branchRef.object.sha = tip;
  const key = f.owner.controllerSha + "..." + tip;
  f.comparisons.set(key, {
    status: "ahead",
    base_commit: { sha: f.owner.controllerSha },
    merge_base_commit: { sha: f.owner.controllerSha },
  });
  const store = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
  await store.checkpoint(f.record, "intent");
  assert.deepEqual((await store.restore()).records, [f.record]);
  assert.equal(
    f.calls.filter(([method, path]) => method === "GET" && path.endsWith("/git/ref/heads/main"))
      .length,
    1,
  );
  assert.equal(
    f.calls.filter(([method, path]) => method === "GET" && path.includes("/compare/")).length,
    1,
  );
  for (const result of [
    {
      status: "behind",
      base_commit: { sha: f.owner.controllerSha },
      merge_base_commit: { sha: f.owner.controllerSha },
    },
    {
      status: "ahead",
      base_commit: { sha: f.owner.controllerSha },
      merge_base_commit: { sha: "e".repeat(40) },
    },
    new Error("API unavailable"),
  ]) {
    f.comparisons.set(key, result);
    const failed = createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" });
    const before = f.calls.filter(
      ([method, path]) => method === "GET" && path.includes("/compare/"),
    ).length;
    await assert.rejects(failed.restore());
    await assert.rejects(failed.restore());
    assert.equal(
      f.calls.filter(([method, path]) => method === "GET" && path.includes("/compare/")).length,
      before + 1,
    );
  }
  f.branchRef.ref = "refs/tags/main";
  await assert.rejects(
    createSerialMergeArtifacts({ ...f, githubToken: "fixture-read-token" }).restore(),
    /untrusted_controller_source/,
  );
});

test("the isolated probe verifies its exact heads branch and can consume an older producer snapshot", async (t) => {
  const f = fixture(t);
  const branch = "codex/gea-ci-s1-artifact-probe-20261024";
  f.branchRef.ref = "refs/heads/" + branch;
  Object.assign(f.runs.get(100), { head_branch: branch, event: "push" });
  const config = {
    ...f,
    githubToken: "fixture-read-token",
    controllerBranch: branch,
    controllerEvent: "push",
  };
  await createSerialMergeArtifacts(config).checkpoint(f.record, "intent");
  const tip = "f".repeat(40);
  f.branchRef.object.sha = tip;
  f.comparisons.set(f.owner.controllerSha + "..." + tip, {
    status: "ahead",
    base_commit: { sha: f.owner.controllerSha },
    merge_base_commit: { sha: f.owner.controllerSha },
  });
  f.addRun(101, { head_branch: branch, event: "push", head_sha: tip });
  const consumer = { ...config, owner: { ...f.owner, runId: 101, controllerSha: tip } };
  assert.deepEqual((await createSerialMergeArtifacts(consumer).restore()).records, [f.record]);
  assert.ok(
    f.calls.some(([method, path]) => method === "GET" && path.endsWith("/git/ref/heads/" + branch)),
  );
  f.branchRef.ref = "refs/tags/" + branch;
  await assert.rejects(
    createSerialMergeArtifacts(consumer).restore(),
    /untrusted_controller_source/,
  );
});

test("a probe can explicitly read its unique producer while full restore retains a failed consumer's missing-checkpoint block", async (t) => {
  const f = fixture(t);
  const branch = "codex/gea-ci-s1-artifact-probe-20261024";
  f.branchRef.ref = "refs/heads/" + branch;
  f.record.probe = true;
  Object.assign(f.runs.get(100), { head_branch: branch, event: "push" });
  const config = {
    ...f,
    githubToken: "fixture-read-token",
    controllerBranch: branch,
    controllerEvent: "push",
  };
  await createSerialMergeArtifacts(config).checkpoint(f.record, "intent");
  f.addRun(101, { head_branch: branch, event: "push", status: "completed", conclusion: "failure" });
  f.addRun(102, { head_branch: branch, event: "push" });
  const consumer = createSerialMergeArtifacts({ ...config, owner: { ...f.owner, runId: 102 } });
  await assert.rejects(consumer.restore(), /checkpoint_missing/);
  const listed = await f.readJson(
    `repos/${f.policy.repository}/actions/runs/100/artifacts?per_page=100&page=1`,
  );
  assert.equal(listed.total_count, 1);
  const record = await consumer.read(listed.artifacts[0]);
  assert.deepEqual(record, f.record);
  const receipt = await consumer.checkpoint(
    {
      ...record,
      revision: 2,
      state: {
        queue: [],
        active: null,
        finished: [{ request: record.request, reason: "artifact_probe_complete" }],
      },
    },
    "terminal",
  );
  assert.equal(receipt.id, 8);
  assert.equal(f.runs.get(101).conclusion, "failure");
  await assert.rejects(consumer.restore(), /checkpoint_missing/);
});

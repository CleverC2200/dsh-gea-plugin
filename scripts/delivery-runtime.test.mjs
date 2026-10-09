import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { checkDelivery } from "./delivery-check.mjs";
import { prepareRuntimeFixture } from "./delivery-runtime-fixture.mjs";
const when = { observedAt: "2026-10-03T00:00:00.000Z" };
const hash = (v) => createHash("sha256").update(v).digest("hex");
const stage = (r, name) => r.stages.find((v) => v.stage === name);
async function fixture(t, taskId = "22") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "delivery-runtime-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "source"));
  const git = (...args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: join(root, "source"),
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
  git("init", "-q");
  await writeFile(join(root, "source/source.js"), "fixed source");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const candidate = {
    taskId,
    projectId: "split",
    kind: "clean",
    commit: git("rev-parse", "HEAD"),
    checkout: { path: "source" },
  };
  const task = {
    id: taskId,
    ticket: { id: "ticket", path: "ticket.md" },
    candidate: { id: "candidate", path: "candidate.json" },
    delivery: { id: "delivery", path: "delivery.json" },
    session: { id: "session", path: "retained-state" },
    inputs: [],
  };
  const request = { root, projectId: "split", tasks: [task] };
  await mkdir(join(root, "retained-state"));
  await writeFile(
    join(root, "retained-state/entity.json"),
    "persistent fixture data",
  );
  await writeFile(
    join(root, "ticket.md"),
    `# ${taskId}: fixture\n\n**Blocked by:** 无\n\n**Status:** in-progress\n`,
  );
  await writeFile(join(root, "candidate.json"), JSON.stringify(candidate));
  await writeFile(
    join(root, "delivery.json"),
    JSON.stringify({
      taskId,
      projectId: "split",
      requiredChecks: [],
      checks: [],
    }),
  );
  async function put(id, value) {
    await writeFile(join(root, `${id}.json`), JSON.stringify(value));
    if (!task.inputs.some((v) => v.id === id))
      task.inputs.push({ id, path: `${id}.json` });
  }
  const envelope = {
    taskId,
    projectId: "split",
    observation: "official-snapshot",
    observedAt: when.observedAt,
    provenance: {
      interface: "official-tool-result",
      threadId: "executor",
      itemId: "snapshot-item",
    },
  };
  const ownership = {
    ...envelope,
    kind: "execution-ownership",
    actualTaskId: taskId,
    threadId: "executor",
    actualProjectId: "split",
    checkout: "source",
    writers: [
      { taskId, threadId: "executor", roundId: "round", state: "idle" },
    ],
  };
  const runtime = {
    kind: "runtime-evidence",
    taskId,
    projectId: "split",
    ownership: "ownership",
    runs: [],
    handoffs: [],
    tools: [],
    repairs: [],
  };
  await put("ownership", ownership);
  await put("runtime", runtime);
  return {
    root,
    candidate,
    task,
    request,
    envelope,
    ownership,
    runtime,
    put,
    run: async () => (await checkDelivery(request, when)).tasks[0],
  };
}
// Explicit controlled assembly/ownership setup is shared with readiness prerequisites.
async function selectedFixture(t, taskId = "22") {
  const f = await fixture(t, taskId);
  const context = await prepareRuntimeFixture(f.request, when);
  // Runtime behavior tests declare a synthetic real-readonly record; no live operation occurs.
  context.runRecord.mode = "real-readonly";
  await context.put("run", context.runRecord);
  return { ...f, ...context };
}

test("actual task, project and checkout determine ownership while titles cannot resolve concurrent writers", async (t) => {
  const f = await fixture(t);
  f.ownership.title = "27: misleading title";
  await f.put("ownership", f.ownership);
  let r = await f.run();
  assert.equal(r.runtime.ownership.status, "matched");
  assert.equal(r.runtime.ownership.taskId, "22");
  f.ownership.writers.push({
    taskId: "22",
    threadId: "other-writer",
    roundId: "other-round",
    state: "active",
  });
  await f.put("ownership", f.ownership);
  r = await f.run();
  assert.equal(r.runtime.ownership.status, "blocked");
  assert.equal(r.runtime.ownership.reason, "IN_FLIGHT_WRITER_CONFLICT");
  delete f.ownership.actualProjectId;
  await f.put("ownership", f.ownership);
  assert.equal((await f.run()).runtime.ownership.status, "unknown");
});
test("sent, received, delivered, failed and unknown are distinct formal handoff facts; exited commands do not resolve UI timers or unsupported controls", async (t) => {
  const f = await fixture(t);
  const candidate = (await f.run()).candidate;
  for (const state of ["sent", "received", "delivered", "failed", "unknown"]) {
    f.runtime.handoffs.push(`handoff-${state}`);
    await f.put(`handoff-${state}`, {
      ...f.envelope,
      kind: "delivery-handoff",
      deliveryId: "delivery",
      deliverySha256: hash(await readFile(join(f.root, "delivery.json"))),
      candidateSha256: candidate.sha256,
      candidateContentSha256: candidate.contentSha256,
      recipientThreadId: "executor",
      state,
    });
  }
  f.runtime.tools = ["tool"];
  await f.put("tool", {
    ...f.envelope,
    kind: "execution-tool-state",
    actionId: "command",
    roundId: "round",
    command: "exited",
    exitCode: 0,
    turn: "completed",
    uiTimer: "running",
    pid: 12345,
    pendingAction: { visibility: "unavailable" },
    stopInterface: "unavailable",
    rawLog: "https://secret.invalid/?token=secret",
  });
  await f.put("runtime", f.runtime);
  const r = await f.run();
  assert.deepEqual(
    r.runtime.handoffs.map((v) => v.state),
    ["sent", "received", "delivered", "failed", "unknown"],
  );
  assert.equal(r.runtime.tools[0].command.state, "exited");
  assert.equal(r.runtime.tools[0].turn, "completed");
  assert.equal(r.runtime.tools[0].uiTimer, "running");
  assert.equal(r.runtime.tools[0].reason, "TOOL_TERMINAL_UI_TIMER_CONFLICT");
  assert.equal(r.runtime.tools[0].process.state, "unknown");
  assert.equal(r.runtime.tools[0].pendingAction.state, "unknown");
  assert.equal(r.runtime.tools[0].stopInterface, "unknown");
  assert.equal(
    r.runtime.handoffs[4].minimumGap,
    "FORMAL_DELIVERY_RESULT_REQUIRED",
  );
  assert.ok(
    r.runtimeGaps.some((v) => v.reason === "FORMAL_DELIVERY_RESULT_REQUIRED"),
  );
  assert.equal(stage(r, "service-structure").status, "unknown");
  assert.doesNotMatch(
    JSON.stringify(r),
    /12345|secret|https:|rawLog|resend|restart|kill/,
  );
  await f.put("handoff-delivered", {
    ...f.envelope,
    kind: "delivery-handoff",
    deliveryId: "other-delivery",
    recipientThreadId: "executor",
    state: "delivered",
  });
  assert.equal(
    (await f.run()).runtime.handoffs.find(
      (v) => v.sourceId === "handoff-delivered",
    ).state,
    "unknown",
  );
});
test("run evidence binds selected candidate, owners and persistent references without claiming current listening from a formal snapshot", async (t) => {
  const f = await selectedFixture(t);
  let r = await f.run();
  assert.equal(
    stage(r, "frozen-assembly").status,
    "passed",
    stage(r, "frozen-assembly").reason,
  );
  assert.equal(stage(r, "service-structure").status, "passed");
  assert.equal(
    stage(r, "service-structure").proof,
    "recorded-scoped-runtime-evidence",
  );
  assert.equal(r.runtime.runs[0].relation, "selected");
  assert.equal(r.runtime.current.listener, "unknown");
  f.runRecord.combinationId = "22222222-2222-2222-2222-222222222222";
  await f.put("run", f.runRecord);
  r = await f.run();
  assert.equal(r.runtime.runs[0].relation, "selection-mismatch");
  assert.equal(stage(r, "service-structure").status, "blocked");
  assert.equal(
    stage(r, "service-structure").reason,
    "RUN_SELECTED_COMBINATION_MISMATCH",
  );
  f.runRecord.combinationId = f.assembly.combinationId;
  delete f.runRecord.lifecycleOwnerId;
  await f.put("run", f.runRecord);
  assert.equal((await f.run()).runtime.runs[0].relation, "unavailable");
});
test("native 401 and local HTTP authentication do not close GEA, Consumer, dataset, Page, model or entity recovery gates", async (t) => {
  const f = await selectedFixture(t);
  f.runRecord.facts.push(
    { fact: "native-gate", state: "http-401" },
    { fact: "local-authentication", state: "authenticated" },
  );
  await f.put("run", f.runRecord);
  let r = await f.run();
  assert.equal(stage(r, "local-authentication").status, "passed");
  assert.equal(
    r.runtime.runs[0].facts.find((v) => v.fact === "native-gate").state,
    "http-401",
  );
  for (const name of [
    "gea-authorization",
    "real-data",
    "model",
    "native-reference",
    "session-recovery",
    "combination-recovery",
  ])
    assert.notEqual(stage(r, name).status, "passed");
  f.runRecord.facts.push(
    { fact: "gea-identity", state: "authenticated" },
    { fact: "consumer-permission", state: "denied" },
    { fact: "dataset", state: "unavailable" },
  );
  await f.put("run", f.runRecord);
  r = await f.run();
  assert.equal(
    stage(r, "gea-authorization").reason,
    "CONSUMER_PERMISSION_DENIED",
  );
  assert.equal(stage(r, "real-data").reason, "DATASET_UNAVAILABLE");
  assert.equal(r.runtime.current.localAuthentication, "unknown");
  assert.equal(stage(r, "session-recovery").reason, "SESSION_RECOVERY_NOT_RUN");
});
test("scoped real Page, Agent, model references and cancel evidence pass separately from Session entities and source combination restoration", async (t) => {
  const f = await selectedFixture(t);
  const complete = [
    "real-model",
    "page-reference",
    "agent-readonly",
    "model-reference",
    "native-reference",
    "cancel-revoke",
    "session-entity-recovery",
    "combination-recovery",
  ];
  f.runRecord.facts.push(
    ...complete.map((fact) => ({ fact, state: "passed" })),
  );
  await f.put("run", f.runRecord);
  let r = await f.run();
  for (const name of [
    "model",
    "native-reference",
    "session-recovery",
    "combination-recovery",
  ])
    assert.equal(stage(r, name).status, "passed", name);
  f.runRecord.facts = f.runRecord.facts.filter(
    (v) => v.fact !== "session-entity-recovery",
  );
  await f.put("run", f.runRecord);
  r = await f.run();
  assert.notEqual(stage(r, "session-recovery").status, "passed");
  assert.equal(stage(r, "combination-recovery").status, "passed");
  f.runRecord.mode = "fixture";
  await f.put("run", f.runRecord);
  r = await f.run();
  for (const name of [
    "model",
    "native-reference",
    "session-recovery",
    "combination-recovery",
  ])
    assert.notEqual(stage(r, name).status, "passed");
});
test("historical observations and stale live records cannot claim current listener, login or process exit", async (t) => {
  const f = await selectedFixture(t);
  f.runRecord.observation = "live";
  f.runRecord.provenance.interface = "official-live-observer";
  f.runRecord.facts.push(
    { fact: "local-authentication", state: "authenticated" },
    { fact: "gea-identity", state: "authenticated" },
  );
  await f.put("run", f.runRecord);
  let r = await f.run();
  assert.equal(r.runtime.current.listener, "started");
  assert.equal(r.runtime.current.localAuthentication, "authenticated");
  assert.equal(r.runtime.current.geaIdentity, "authenticated");
  assert.equal(r.runtime.current.processesExited, "unknown");
  f.runRecord.observedAt = "2026-10-02T00:00:00.000Z";
  await f.put("run", f.runRecord);
  r = await f.run();
  assert.equal(r.runtime.current.listener, "unknown");
  f.runRecord.observation = "historical";
  await f.put("run", f.runRecord);
  r = await f.run();
  assert.equal(r.runtime.runs[0].relation, "historical");
  assert.notEqual(stage(r, "service-structure").status, "passed");
  f.runRecord.observation = "official-snapshot";
  f.runRecord.provenance.interface = "agent-self-report";
  await f.put("run", f.runRecord);
  assert.equal((await f.run()).runtime.runs[0].relation, "unavailable");
});
test("available authorization remains separate from final integrity and writer readiness; independent offline work and exact stops remain visible", async (t) => {
  const f = await selectedFixture(t);
  await f.put("allow", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human",
      itemId: "permission",
    },
    taskIds: ["22"],
    stages: [
      "offline-checks",
      "frozen-assembly",
      "service-structure",
      "native-reference",
      "model",
    ],
    action: "manual-work",
    effect: "allow",
  });
  const readiness = {
    kind: "authorization-readiness",
    taskId: "22",
    projectId: "split",
    instructions: ["allow"],
    predecessors: [],
    executionPolicy: {
      currentRoundId: "round",
      current: { roundId: "round", access: "full", approval: "never" },
      stops: [
        {
          kind: "model-capacity",
          reasonCode: "capacity-limit",
          actionId: "model-command",
          stage: "model",
          roundId: "round",
        },
      ],
    },
  };
  await f.put("readiness", readiness);
  f.runRecord.combinationId = "22222222-2222-2222-2222-222222222222";
  await f.put("run", f.runRecord);
  let r = await f.run();
  const suggestion = (name) => r.suggestions.find((v) => v.stage === name);
  assert.equal(
    r.authorization.find((v) => v.stage === "native-reference").status,
    "allowed",
  );
  assert.equal(suggestion("native-reference").status, "blocked");
  assert.equal(suggestion("native-reference").allowedScope, "allowed");
  assert.equal(suggestion("offline-checks").status, "can-continue");
  assert.equal(suggestion("model").reason, "MODEL_CAPACITY_STOP");
  f.ownership.writers.push({
    taskId: "22",
    threadId: "other",
    roundId: "other",
    state: "active",
  });
  await f.put("ownership", f.ownership);
  r = await f.run();
  assert.equal(
    r.suggestions.find((v) => v.stage === "offline-checks").reason,
    "IN_FLIGHT_WRITER_CONFLICT",
  );
});
test("runtime authorization cannot turn an observed native failure into a continuation suggestion", async (t) => {
  const f = await selectedFixture(t);
  await f.put("allow", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human",
      itemId: "allow-native",
    },
    taskIds: ["22"],
    stages: ["native-reference"],
    action: "manual-work",
    effect: "allow",
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "22",
    projectId: "split",
    instructions: ["allow"],
    predecessors: [],
  });
  f.runRecord.facts.push({ fact: "cancel-revoke", state: "failed" });
  await f.put("run", f.runRecord);
  const r = await f.run();
  assert.equal(stage(r, "native-reference").status, "failed");
  assert.equal(
    r.suggestions.find((v) => v.stage === "native-reference").status,
    "blocked",
  );
});
test("16 pagination, 26 ageing and 27 receipt/cancel repair histories bind their fixed candidate without closing real acceptance", async (t) => {
  for (const taskId of ["16", "26", "27"]) {
    const f = await fixture(t, taskId),
      before = await f.run();
    f.runtime.repairs = ["repair"];
    await f.put("repair", {
      ...f.envelope,
      kind: "technical-repair",
      issueId: `fixed-${taskId}`,
      status: "fixed",
      candidateSha256: before.candidate.sha256,
      candidateContentSha256: before.candidate.contentSha256,
      history: [
        {
          status: "failed",
          candidateSha256: "a".repeat(64),
          observedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
    });
    await f.put("runtime", f.runtime);
    let r = await f.run();
    assert.equal(r.runtime.repairs[0].status, "fixed");
    assert.equal(r.runtime.repairs[0].history[0].status, "failed");
    for (const name of [
      "real-data",
      "native-reference",
      "model",
      "session-recovery",
    ])
      assert.notEqual(stage(r, name).status, "passed");
    await writeFile(join(f.root, "source/source.js"), "new candidate bytes");
    r = await f.run();
    assert.equal(r.runtime.repairs[0].status, "unknown");
    assert.equal(r.runtime.repairs[0].relation, "candidate-mismatch");
    assert.equal(r.runtime.repairs[0].history[0].status, "failed");
  }
});
test("missing, forged, conflicting and cross-task runtime sources cannot upgrade any stage", async (t) => {
  const f = await selectedFixture(t);
  f.runRecord.projectId = "other-project";
  await f.put("run", f.runRecord);
  assert.equal((await f.run()).runtime.runs[0].relation, "unavailable");
  f.runRecord.projectId = "split";
  f.runRecord.persistentSourceIds = ["undeclared-state"];
  await f.put("run", f.runRecord);
  assert.equal((await f.run()).runtime.runs[0].relation, "unavailable");
  f.runRecord.persistentSourceIds = ["session"];
  f.runRecord.facts.push({ fact: "service", state: "failed" });
  await f.put("run", f.runRecord);
  assert.notEqual(stage(await f.run(), "service-structure").status, "passed");
  f.task.inputs.push({ id: "run", path: "run.json" });
  assert.equal((await f.run()).runtime.ownership.status, "unknown");
  f.task.inputs.pop();
  await f.put("other-runtime", f.runtime);
  assert.equal((await f.run()).runtime.ownership.status, "unknown");
});
test("a mismatched authoritative ticket cannot validate a runtime record that merely names the requested task", async (t) => {
  const f = await selectedFixture(t);
  await writeFile(
    join(f.root, "ticket.md"),
    "# 27: other ticket\n\n**Blocked by:** 无\n\n**Status:** in-progress\n",
  );
  const r = await f.run();
  assert.equal(r.executionStatus, "unknown");
  assert.equal(r.runtime.ownership.status, "unknown");
  assert.notEqual(stage(r, "service-structure").status, "passed");
});
test("malformed writer entries retain an unknown ownership report instead of throwing away the delivery result", async (t) => {
  const f = await fixture(t);
  f.ownership.writers = [null];
  await f.put("ownership", f.ownership);
  const r = await f.run();
  assert.equal(r.runtime.ownership.status, "unknown");
  assert.equal(
    r.runtime.ownership.reason,
    "ACTUAL_TASK_PROJECT_CHECKOUT_AND_WRITERS_REQUIRED",
  );
});
test("run conflicts add diagnostics without replacing an existing precise capacity or approval stop", async (t) => {
  const f = await selectedFixture(t);
  await f.put("allow", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human",
      itemId: "allow-service",
    },
    taskIds: ["22"],
    stages: ["service-structure"],
    action: "manual-work",
    effect: "allow",
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "22",
    projectId: "split",
    instructions: ["allow"],
    predecessors: [],
    executionPolicy: {
      currentRoundId: "round",
      current: { roundId: "round", access: "full", approval: "never" },
      stops: [
        {
          kind: "model-capacity",
          reasonCode: "capacity-limit",
          actionId: "service-command",
          stage: "service-structure",
          roundId: "round",
        },
      ],
    },
  });
  f.runtime.runs.push("second-run");
  await f.put("second-run", { ...f.runRecord, runId: "other-run" });
  await f.put("runtime", f.runtime);
  let r = await f.run();
  assert.equal(stage(r, "service-structure").status, "blocked");
  assert.equal(stage(r, "service-structure").reason, "MODEL_CAPACITY_STOP");
  f.runtime.runs.pop();
  f.runRecord.combinationId = "22222222-2222-2222-2222-222222222222";
  await f.put("runtime", f.runtime);
  await f.put("run", f.runRecord);
  r = await f.run();
  assert.equal(stage(r, "service-structure").reason, "MODEL_CAPACITY_STOP");
  assert.ok(
    r.diagnostics.some((v) => v.reason === "RUN_SELECTED_COMBINATION_MISMATCH"),
  );
});
test("positive model records preserve unknown configuration and incomplete capacity stop gaps", async (t) => {
  for (const gapKind of ["configuration", "capacity"]) {
    const f = await selectedFixture(t);
    await f.put("allow", {
      kind: "human-instruction",
      projectId: "split",
      provenance: {
        author: "human",
        interface: "official-user-message",
        threadId: "human",
        itemId: "allow-model",
      },
      taskIds: ["22"],
      stages: ["model"],
      action: "manual-work",
      effect: "allow",
    });
    const readiness = {
      kind: "authorization-readiness",
      taskId: "22",
      projectId: "split",
      instructions: ["allow"],
      predecessors: [],
    };
    if (gapKind === "configuration") {
      readiness.requirements = [{ stage: "model", needs: ["model"] }];
      readiness.configuration = [
        { category: "model", status: "unknown", mode: "real-readonly" },
      ];
    } else
      readiness.executionPolicy = {
        currentRoundId: "round",
        current: { roundId: "round", access: "full", approval: "never" },
        stops: [
          {
            kind: "model-capacity",
            reasonCode: "capacity-limit",
            stage: "model",
            roundId: "round",
          },
        ],
      };
    await f.put("readiness", readiness);
    f.runRecord.facts.push({ fact: "real-model", state: "passed" });
    await f.put("run", f.runRecord);
    const r = await f.run();
    assert.equal(stage(r, "model").status, "unknown", gapKind);
    assert.notEqual(stage(r, "model").minimumGap, null);
    assert.equal(
      r.runtime.runs[0].facts.find((v) => v.fact === "real-model").state,
      "passed",
    );
  }
});
test("missing the whole runtime index retains authorization but requires actual service ownership while independent offline work remains visible", async (t) => {
  const f = await selectedFixture(t);
  await f.put("allow", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human",
      itemId: "allow-service",
    },
    taskIds: ["22"],
    stages: ["service-structure", "offline-checks"],
    action: "manual-work",
    effect: "allow",
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "22",
    projectId: "split",
    instructions: ["allow"],
    predecessors: [],
  });
  f.task.inputs = f.task.inputs.filter(
    (v) => !["runtime", "ownership", "run"].includes(v.id),
  );
  const r = await f.run(),
    suggestion = r.suggestions.find((v) => v.stage === "service-structure");
  assert.equal(suggestion.allowedScope, "allowed");
  assert.equal(suggestion.status, "unknown");
  assert.equal(r.runtime.ownership.status, "unknown");
  assert.ok(r.runtimeGaps.some((v) => v.stage === "execution-ownership"));
  assert.equal(
    r.suggestions.find((v) => v.stage === "offline-checks").status,
    "can-continue",
  );
});
test("bare recorded-snapshot readiness keeps model/native authorization without claiming actual continuation readiness", async (t) => {
  const f = await fixture(t, "27");
  await writeFile(
    join(f.root, "candidate.json"),
    JSON.stringify({
      taskId: "27",
      projectId: "split",
      kind: "clean",
      commit: "a".repeat(40),
    }),
  );
  f.task.inputs = [];
  await f.put("allow", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human",
      itemId: "allow-bare",
    },
    taskIds: ["27"],
    stages: ["model", "native-reference", "service-structure"],
    action: "manual-work",
    effect: "allow",
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "27",
    projectId: "split",
    instructions: ["allow"],
    predecessors: [],
    requirements: [{ stage: "model", needs: ["model"] }],
    configuration: [
      {
        category: "model",
        status: "ready",
        mode: "real-readonly",
        referenceId: "synthetic-model",
      },
    ],
  });
  const r = await f.run();
  assert.equal(r.candidate.proof, "recorded-snapshot");
  for (const name of ["model", "native-reference", "service-structure"]) {
    const suggestion = r.suggestions.find((v) => v.stage === name);
    assert.equal(suggestion.allowedScope, "allowed");
    assert.equal(suggestion.status, "unknown");
    assert.notEqual(stage(r, name).status, "passed");
  }
});
async function snapshot(root) {
  const files = {};
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path, `${key}/`);
      else files[key] = hash(await readFile(path));
    }
  }
  await walk(root);
  return files;
}
test("same Interface and permission-limited stdout CLI preserve the complete fixture, retained Session, selection and lock", async (t) => {
  const f = await selectedFixture(t);
  const observedAt = new Date(Date.now() - 1000).toISOString();
  f.ownership.observedAt = observedAt;
  f.runRecord.observedAt = observedAt;
  await f.put("ownership", f.ownership);
  await f.put("run", f.runRecord);
  const requestFile = join(f.root, "request.json");
  await writeFile(requestFile, JSON.stringify(f.request));
  const before = await snapshot(f.root);
  assert.deepEqual(await f.run(), await f.run());
  const cli = spawnSync(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${process.cwd()}`,
      `--allow-fs-read=${f.root}`,
      "scripts/delivery-check.mjs",
      "--input",
      requestFile,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(cli.stderr, "");
  const report = JSON.parse(cli.stdout);
  assert.equal(stage(report.tasks[0], "service-structure").status, "passed");
  assert.deepEqual(
    report,
    await checkDelivery(f.request, { observedAt: report.observedAt }),
  );
  assert.doesNotMatch(
    cli.stdout,
    /https?:|password|Cookie|rawLog|\/private\/|retained-state\/entity/,
  );
  assert.deepEqual(await snapshot(f.root), before);
});
test("runtime records pointing into declared persistent data are refused before reading; missing directories are not created", async (t) => {
  const f = await selectedFixture(t);
  f.task.inputs.find((v) => v.id === "run").path = "retained-state/entity.json";
  let r = await f.run();
  assert.equal(
    r.inputs.find((v) => v.id === "run").error,
    "INPUT_PERSISTENT_OVERLAP",
  );
  assert.equal(r.runtime.runs[0].relation, "unavailable");
  f.task.session.path = "missing-state";
  f.task.inputs.find((v) => v.id === "run").path = "run.json";
  r = await f.run();
  assert.equal(stage(r, "session-recovery").status, "blocked");
  assert.equal((await readdir(f.root)).includes("missing-state"), false);
});
test("a single exited service record is not live proof that the whole process group exited", async (t) => {
  const f = await selectedFixture(t);
  f.runRecord.observation = "live";
  f.runRecord.provenance.interface = "official-live-observer";
  f.runRecord.facts = [{ fact: "service", state: "exited" }];
  await f.put("run", f.runRecord);
  assert.equal((await f.run()).runtime.current.processesExited, "unknown");
  f.runRecord.facts.push({ fact: "process-group", state: "all-exited" });
  await f.put("run", f.runRecord);
  assert.equal((await f.run()).runtime.current.processesExited, "all-exited");
});

test("conflicting selected runs stop runtime suggestions with the exact gap while independent preparation stays available", async (t) => {
  const f = await selectedFixture(t);
  await f.put("allow", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human",
      itemId: "allow-service",
    },
    taskIds: ["22"],
    stages: [
      "offline-checks",
      "frozen-assembly",
      "service-structure",
      "native-reference",
    ],
    action: "manual-work",
    effect: "allow",
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "22",
    projectId: "split",
    instructions: ["allow"],
    predecessors: [],
    executionPolicy: {
      currentRoundId: "round",
      current: { roundId: "round", access: "full", approval: "never" },
    },
  });
  assert.equal(
    (await f.run()).suggestions.find((v) => v.stage === "service-structure")
      .status,
    "can-continue",
  );
  f.runtime.runs.push("second-run");
  await f.put("second-run", { ...f.runRecord, runId: "other-run" });
  await f.put("runtime", f.runtime);
  const r = await f.run();
  for (const name of ["service-structure", "native-reference"]) {
    const suggestion = r.suggestions.find((v) => v.stage === name);
    assert.equal(suggestion.status, "unknown");
    assert.equal(suggestion.reason, "RUN_RECORD_CONFLICT");
    assert.equal(suggestion.minimumGap, "UNIQUE_SELECTED_RUN_REQUIRED");
    assert.ok(suggestion.evidence.some((v) => v.sourceId === "second-run"));
  }
  for (const name of ["offline-checks", "frozen-assembly"])
    assert.equal(
      r.suggestions.find((v) => v.stage === name).status,
      "can-continue",
    );
});

test("an impossible calendar date cannot advance a selected runtime stage", async (t) => {
  const f = await selectedFixture(t);
  let report = await f.run();
  assert.equal(report.runtime.runs[0].relation, "selected");
  assert.equal(stage(report, "service-structure").status, "passed");
  f.runRecord.observedAt = "2026-02-30T00:00:00.000Z";
  await f.put("run", f.runRecord);
  report = await f.run();
  assert.notEqual(report.runtime.runs[0].relation, "selected");
  assert.notEqual(stage(report, "service-structure").status, "passed");
});

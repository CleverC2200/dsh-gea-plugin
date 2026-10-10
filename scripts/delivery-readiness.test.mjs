import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDelivery } from "./delivery-check.mjs";
import { prepareRuntimeFixture } from "./delivery-runtime-fixture.mjs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

async function fixture(t, taskId = "15", blockedBy = "14：predecessor") {
  const root = await mkdtemp(join(tmpdir(), "gea-delivery-readiness-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = {
    id: taskId,
    ticket: { id: `ticket-${taskId}`, path: "ticket.md" },
    candidate: { id: `candidate-${taskId}`, path: "candidate.json" },
    delivery: { id: `delivery-${taskId}`, path: "delivery.json" },
    inputs: [],
  };
  const input = { root, projectId: "split", tasks: [task] };
  async function put(id, value) {
    const path = `${id}.${typeof value === "string" ? "md" : "json"}`;
    await writeFile(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
    if (!task.inputs.some((ref) => ref.id === id)) task.inputs.push({ id, path });
  }
  await writeFile(
    join(root, "ticket.md"),
    `# ${taskId}: sample\n\n**Blocked by:** ${blockedBy}\n\n**Status:** ready-for-agent\n`,
  );
  await writeFile(
    join(root, "candidate.json"),
    JSON.stringify({
      taskId,
      projectId: "split",
      kind: "clean",
      commit: "a".repeat(40),
    }),
  );
  await writeFile(
    join(root, "delivery.json"),
    JSON.stringify({
      taskId,
      projectId: "split",
      requiredChecks: [],
      checks: [],
    }),
  );
  const readiness = {
    kind: "authorization-readiness",
    taskId,
    projectId: "split",
    instructions: ["allow"],
    predecessors: [{ taskId: "14", sourceId: "predecessor" }],
  };
  const allow = {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "human-thread",
      itemId: "human-item",
    },
    taskIds: [taskId],
    stages: ["offline-checks"],
    action: "manual-work",
    effect: "allow",
    dependencyExceptions: ["14"],
  };
  await put("allow", allow);
  await put("predecessor", "# 14: previous\n\n**Status:** in-progress\n");
  await put("readiness", readiness);
  return {
    input,
    task,
    put,
    readiness,
    allow,
    report: async () =>
      (await checkDelivery(input, { observedAt: "2026-10-03T00:00:00.000Z" })).tasks[0],
  };
}

test("14 stage permission allows only 15 offline while the original predecessor and real stages remain incomplete", async (t) => {
  const f = await fixture(t);
  const task = await f.report();
  assert.equal(task.executionStatus, "ready-for-agent");
  assert.equal(task.dependencies.predecessors[0].executionStatus, "in-progress");
  assert.equal(
    task.authorization.find((entry) => entry.stage === "offline-checks").status,
    "allowed",
  );
  assert.equal(
    task.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  assert.equal(task.suggestions.find((entry) => entry.stage === "real-data").status, "blocked");
  assert.equal(task.stages.find((entry) => entry.stage === "real-data").status, "blocked");
});

test("only explicit human supersession replaces old scope and conflicting or unverifiable sources stay unknown", async (t) => {
  const f = await fixture(t);
  const old = {
    ...f.allow,
    effect: "deny",
    dependencyExceptions: [],
    stages: ["offline-checks", "real-data"],
  };
  await f.put("old", old);
  f.readiness.instructions.push("old");
  await f.put("readiness", f.readiness);
  assert.equal(
    (await f.report()).authorization.find((entry) => entry.stage === "offline-checks").status,
    "unknown",
  );
  f.allow.supersedes = ["old"];
  await f.put("allow", f.allow);
  let report = await f.report();
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  assert.equal(report.authorization.find((entry) => entry.stage === "real-data").status, "blocked");
  f.allow.provenance.author = "agent";
  await f.put("allow", f.allow);
  assert.equal(
    (await f.report()).authorization.find((entry) => entry.stage === "offline-checks").status,
    "unknown",
  );
  f.allow.provenance.author = "human";
  delete f.allow.provenance.itemId;
  await f.put("allow", f.allow);
  assert.equal(
    (await f.report()).authorization.find((entry) => entry.stage === "offline-checks").reason,
    "HUMAN_SOURCE_AND_SCOPE_REQUIRED",
  );
});

test("ready labels and another ticket's exception cannot replace actual Markdown predecessor done", async (t) => {
  for (const taskId of ["17", "27"]) {
    const f = await fixture(t, taskId);
    f.allow.taskIds = ["15"];
    await f.put("allow", f.allow);
    let report = await f.report();
    assert.equal(
      report.suggestions.find((entry) => entry.stage === "offline-checks").status,
      "blocked",
    );
    await f.put("predecessor", "# 14: previous\n\n**Status:** ready-for-agent\n");
    assert.equal((await f.report()).dependencies.status, "blocked");
    await f.put("predecessor", "# 14: previous\n\n**Status:** done\n");
    f.allow.taskIds = [taskId];
    f.allow.dependencyExceptions = [];
    await f.put("allow", f.allow);
    report = await f.report();
    assert.equal(report.dependencies.status, "satisfied");
    assert.equal(
      report.suggestions.find((entry) => entry.stage === "offline-checks").status,
      "can-continue",
    );
    await writeFile(
      join(f.input.root, "ticket.md"),
      `# ${taskId}: sample\n\n**Blocked by:** 14：previous；11：missing previous\n\n**Status:** ready-for-agent\n`,
    );
    assert.equal((await f.report()).dependencies.status, "unknown");
  }
});

test("27 model configuration gap blocks only its requested stages and leaves independently authorized 22 assembly visible", async (t) => {
  const sales = await fixture(t, "27", "None (can start immediately)");
  sales.allow.stages = ["offline-checks", "model"];
  sales.readiness.requirements = [{ stage: "model", needs: ["model"] }];
  sales.readiness.configuration = [
    {
      category: "model",
      status: "missing",
      mode: "real-readonly",
      referenceId: null,
    },
  ];
  await sales.put("allow", sales.allow);
  await sales.put("readiness", sales.readiness);
  const prototype = await fixture(t, "22", "None (can start immediately)");
  prototype.allow.stages = ["frozen-assembly"];
  await prototype.put("allow", prototype.allow);
  const blocked = await sales.report();
  assert.equal(blocked.configuration.find((entry) => entry.category === "model").status, "missing");
  assert.equal(
    blocked.stages.find((entry) => entry.stage === "model").reason,
    "MODEL_REFERENCE_NOT_DELIVERED",
  );
  assert.equal(
    blocked.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  assert.equal(
    (await prototype.report()).suggestions.find((entry) => entry.stage === "frozen-assembly")
      .status,
    "can-continue",
  );
  assert.equal(
    (await prototype.report()).stages.find((entry) => entry.stage === "frozen-assembly").status,
    "not-run",
  );
});

test("configuration modes and identity data observations remain separate without promoting real stages", async (t) => {
  const f = await fixture(t, "27", "None");
  await prepareRuntimeFixture(f.input, {
    observedAt: "2026-10-03T00:00:00.000Z",
  });
  await f.put("setup-allow", { ...f.allow, stages: ["service-structure"] });
  f.readiness.instructions.push("setup-allow");
  f.allow.stages = ["gea-authorization", "real-data", "model"];
  f.readiness.requirements = [
    {
      stage: "gea-authorization",
      needs: ["test-deployment", "tenant", "read-scope", "login-method"],
    },
    { stage: "model", needs: ["model"] },
  ];
  f.readiness.configuration = [
    "test-deployment",
    "tenant",
    "read-scope",
    "login-method",
    "model",
  ].map((category) => ({
    category,
    status: "ready",
    mode: "real-readonly",
    referenceId: `test-${category}`,
    scope: ["sales.read"],
  }));
  await f.put("allow", f.allow);
  for (const mode of ["mock", "receipt", "placeholder", "real-write", "real-readonly"]) {
    f.readiness.configuration.forEach((entry) => {
      entry.mode = mode;
    });
    await f.put("readiness", f.readiness);
    const report = await f.report();
    assert.equal(report.configuration.find((entry) => entry.category === "model").mode, mode);
    assert.equal(
      report.suggestions.find((entry) => entry.stage === "model").status,
      mode === "real-readonly" ? "can-continue" : "blocked",
    );
    assert.notEqual(report.stages.find((entry) => entry.stage === "model").status, "passed");
  }
  const candidate = (await f.report()).candidate.sha256;
  const observed = (fact, state) => ({
    fact,
    state,
    candidateSha256: candidate,
    runId: "fixture-run",
    combinationId: "fixture-combination",
    ownerId: "original-owner",
    observedAt: "2026-10-02T16:00:00.000Z",
  });
  f.readiness.observations = [
    observed("local-authentication", "authenticated"),
    observed("gea-identity", "not-run"),
    observed("consumer-permission", "not-run"),
    observed("dataset", "not-run"),
    observed("query", "unknown"),
    observed("real-model", "not-run"),
  ];
  await f.put("readiness", f.readiness);
  let report = await f.report();
  assert.equal(
    report.facts.find((entry) => entry.fact === "local-authentication").state,
    "authenticated",
  );
  assert.equal(report.facts.find((entry) => entry.fact === "gea-identity").state, "not-run");
  assert.notEqual(
    report.stages.find((entry) => entry.stage === "gea-authorization").status,
    "passed",
  );
  for (const state of ["failed", "empty", "zero", "nonempty", "unknown"]) {
    f.readiness.observations = [observed("query", state)];
    await f.put("readiness", f.readiness);
    report = await f.report();
    assert.equal(report.facts.find((entry) => entry.fact === "query").state, state);
    assert.equal(
      report.stages.find((entry) => entry.stage === "real-data").status,
      state === "failed" ? "failed" : "not-run",
    );
  }
  f.readiness.observations = [
    observed("consumer-permission", "denied"),
    observed("dataset", "unavailable"),
  ];
  await f.put("readiness", f.readiness);
  report = await f.report();
  assert.equal(
    report.stages.find((entry) => entry.stage === "gea-authorization").reason,
    "CONSUMER_PERMISSION_DENIED",
  );
  assert.equal(
    report.stages.find((entry) => entry.stage === "real-data").reason,
    "DATASET_UNAVAILABLE",
  );
});

test("final internal review replaces an explicitly superseded external gate only for its reviewed candidate and inputs", async (t) => {
  const f = await fixture(t, "20", "None");
  const oldRule = {
    ...f.allow,
    action: "review-rule",
    reviewMode: "external-final",
  };
  const newRule = {
    ...oldRule,
    reviewMode: "internal-final",
    supersedes: ["old-review-rule"],
  };
  await f.put("old-review-rule", oldRule);
  await f.put("current-review-rule", newRule);
  await f.put("review-scope", "current source input");
  f.readiness.instructions.push("old-review-rule", "current-review-rule");
  f.readiness.review = { sourceId: "review", requiredInputs: ["review-scope"] };
  await f.put("readiness", f.readiness);
  const initial = await f.report();
  const review = {
    kind: "internal-review",
    taskId: "20",
    projectId: "split",
    scope: "final-candidate",
    standards: "passed",
    spec: "passed",
    taste: "passed",
    candidateSha256: initial.candidate.sha256,
    candidateContentSha256: initial.candidate.contentSha256,
    inputs: [
      {
        sourceId: "review-scope",
        sha256: initial.inputs.find((entry) => entry.id === "review-scope").sha256,
      },
    ],
  };
  await f.put("review", review);
  let report = await f.report();
  assert.equal(report.review.status, "satisfied");
  assert.equal(report.review.rule, "internal-final");
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  await f.put("review-scope", "unreviewed increment");
  report = await f.report();
  assert.equal(report.review.status, "unknown");
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "unknown",
  );
  review.candidateSha256 = "b".repeat(64);
  await f.put("review", review);
  assert.equal((await f.report()).review.status, "unknown");
});

test("paused followup and browser scopes survive manual checks and only the matching explicit browser resume changes them", async (t) => {
  const f = await fixture(t, "22", "None");
  await prepareRuntimeFixture(f.input, {
    observedAt: "2026-10-03T00:00:00.000Z",
  });
  await f.put("setup-allow", { ...f.allow, stages: ["service-structure"] });
  f.readiness.instructions.push("setup-allow");
  f.allow.stages = ["offline-checks", "native-reference"];
  await f.put("allow", f.allow);
  await f.put("pause-followup", {
    ...f.allow,
    action: "automatic-followup",
    effect: "pause",
  });
  await f.put("pause-browser", {
    ...f.allow,
    action: "browser",
    effect: "pause",
    stages: ["native-reference"],
  });
  f.readiness.instructions.push("pause-followup", "pause-browser");
  await f.put("readiness", f.readiness);
  let report = await f.report();
  assert.equal(
    report.arrangements.find(
      (entry) => entry.action === "automatic-followup" && entry.stage === "offline-checks",
    ).status,
    "blocked",
  );
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "native-reference").reason,
    "BROWSER_WINDOW_PAUSED",
  );
  await f.put("resume-browser", {
    ...f.allow,
    action: "browser",
    effect: "allow",
    stages: ["native-reference"],
    supersedes: ["pause-browser"],
  });
  f.readiness.instructions.push("resume-browser");
  await f.put("readiness", f.readiness);
  report = await f.report();
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "native-reference").status,
    "can-continue",
  );
  assert.equal(
    report.arrangements.find(
      (entry) => entry.action === "automatic-followup" && entry.stage === "offline-checks",
    ).status,
    "blocked",
  );
});

test("current policy never inherits an old round restriction and capacity or approval stops identify only their precise action", async (t) => {
  const f = await fixture(t, "27", "None");
  f.allow.stages = ["offline-checks", "model"];
  await f.put("allow", f.allow);
  f.readiness.executionPolicy = {
    currentRoundId: "round-2",
    current: { roundId: "round-2", access: "full", approval: "never" },
    history: [{ roundId: "round-1", access: "restricted", approval: "on-request" }],
    pendingAction: { visibility: "unavailable", stage: "model" },
    stops: [
      {
        kind: "model-capacity",
        roundId: "round-1",
        stage: "model",
        actionId: "old-model-call",
        reasonCode: "capacity-limit",
      },
    ],
  };
  await f.put("readiness", f.readiness);
  let report = await f.report();
  assert.equal(report.executionPolicy.current.access, "full");
  assert.equal(report.executionPolicy.pendingAction.status, "unknown");
  assert.equal(report.executionPolicy.stops[0].relation, "historical");
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  f.readiness.executionPolicy.current.access = "restricted";
  f.readiness.executionPolicy.pendingAction = null;
  f.readiness.executionPolicy.stops.push({
    kind: "model-capacity",
    roundId: "round-2",
    stage: "model",
    actionId: "model-query-27",
    reasonCode: "capacity-limit",
  });
  await f.put("readiness", f.readiness);
  report = await f.report();
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "model").reason,
    "MODEL_CAPACITY_STOP",
  );
  assert.equal(report.executionPolicy.stops[1].actionId, "model-query-27");
  f.readiness.executionPolicy.stops[1] = {
    kind: "approval-rejected",
    roundId: "round-2",
    stage: "model",
    actionId: "original-action-27",
    reasonCode: "automatic-approval-rejected",
  };
  await f.put("readiness", f.readiness);
  report = await f.report();
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "model").reason,
    "AUTOMATIC_APPROVAL_REJECTED",
  );
  assert.equal(report.executionPolicy.stops[1].reasonCode, "automatic-approval-rejected");
});

test("supersession cycles browser conflicts and ambiguous source IDs never allow work while valid non-applicability survives", async (t) => {
  const f = await fixture(t, "22", "None");
  f.allow.stages = ["native-reference"];
  await f.put("allow", f.allow);
  await f.put("cycle-a", { ...f.allow, supersedes: ["cycle-b"] });
  await f.put("cycle-b", { ...f.allow, supersedes: ["cycle-a"] });
  f.readiness.instructions.push("cycle-a", "cycle-b");
  await f.put("readiness", f.readiness);
  assert.equal(
    (await f.report()).authorization.find((entry) => entry.stage === "native-reference").status,
    "unknown",
  );
  f.readiness.instructions = ["allow", "browser-allow", "browser-pause"];
  await f.put("browser-allow", { ...f.allow, action: "browser" });
  await f.put("browser-pause", {
    ...f.allow,
    action: "browser",
    effect: "pause",
  });
  await f.put("readiness", f.readiness);
  assert.equal(
    (await f.report()).suggestions.find((entry) => entry.stage === "native-reference").status,
    "unknown",
  );
  f.readiness.configuration = [
    {
      category: "model",
      status: "ready",
      mode: "receipt",
      referenceId: "offline-receipt",
    },
  ];
  f.readiness.requirements = [{ stage: "offline-checks", needs: ["model"] }];
  f.readiness.instructions = ["allow"];
  f.allow.stages.push("offline-checks");
  await f.put("allow", f.allow);
  await f.put("readiness", f.readiness);
  assert.equal(
    (await f.report()).suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  const delivery = {
    taskId: "22",
    projectId: "split",
    requiredChecks: [],
    checks: [],
    notApplicable: [
      {
        stage: "formal-release",
        reasonCode: "outside-task-scope",
        sourceId: "ticket-22",
      },
    ],
  };
  await writeFile(join(f.input.root, "delivery.json"), JSON.stringify(delivery));
  f.readiness.requirements.push({ stage: "formal-release", needs: ["tenant"] });
  await f.put("readiness", f.readiness);
  assert.equal(
    (await f.report()).stages.find((entry) => entry.stage === "formal-release").status,
    "not-applicable",
  );
  f.task.inputs.push({ id: "allow", path: "allow.json" });
  const conflict = await f.report();
  assert.equal(
    conflict.authorization.find((entry) => entry.stage === "offline-checks").status,
    "unknown",
  );
  assert.ok(conflict.diagnostics.some((entry) => entry.reason === "INPUT_ID_CONFLICT"));
});

async function tree(path) {
  const result = {};
  for (const entry of await readdir(path, { withFileTypes: true }))
    result[entry.name] = entry.isDirectory()
      ? await tree(join(path, entry.name))
      : createHash("sha256")
          .update(await readFile(join(path, entry.name)))
          .digest("hex");
  return result;
}

test("main Interface and stdout CLI preserve all inputs and populated fixture Sessions without exposing raw metadata", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.input.root, "fixture-sessions"));
  await writeFile(
    join(f.input.root, "fixture-sessions", "session.json"),
    '{"messages":["keep fixture bytes"]}',
  );
  f.task.session = { id: "fixture-session", path: "fixture-sessions" };
  f.readiness.url = "https://secret.invalid/?token=DO_NOT_PRINT";
  f.readiness.password = "DO_NOT_PRINT";
  f.readiness.rawAuthenticationLog = "Cookie=DO_NOT_PRINT";
  f.readiness.executionPolicy = {
    pendingAction: {
      command: "DO_NOT_PRINT",
      reason: "DO_NOT_PRINT",
      visibility: "unavailable",
      stage: "model",
    },
  };
  await f.put("readiness", f.readiness);
  await writeFile(join(f.input.root, "request.json"), JSON.stringify(f.input));
  const before = await tree(f.input.root);
  const report = await f.report();
  assert.deepEqual(await f.report(), report);
  assert.doesNotMatch(JSON.stringify(report), /DO_NOT_PRINT|secret\.invalid|Cookie|password/);
  const cli = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      join(f.input.root, "request.json"),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(cli.status, 0);
  assert.equal(cli.stderr, "");
  assert.doesNotMatch(cli.stdout, /DO_NOT_PRINT|secret\.invalid|Cookie|password/);
  assert.equal(
    JSON.parse(cli.stdout).tasks[0].suggestions.find((entry) => entry.stage === "offline-checks")
      .status,
    "can-continue",
  );
  assert.deepEqual(await tree(f.input.root), before);
});

test("an old round pending approval stays historical and future or changed candidate observations are unknown", async (t) => {
  const f = await fixture(t, "27", "None");
  f.readiness.executionPolicy = {
    currentRoundId: "round-2",
    current: { roundId: "round-2", access: "full", approval: "never" },
    pendingAction: {
      roundId: "round-1",
      visibility: "available",
      approvalState: "rejected",
      stage: "offline-checks",
      actionId: "old-command",
    },
  };
  await f.put("readiness", f.readiness);
  let report = await f.report();
  assert.equal(report.executionPolicy.pendingAction.relation, "historical");
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
  f.readiness.observations = [
    {
      fact: "query",
      state: "zero",
      runId: "fixture-run",
      combinationId: "fixture-combination",
      ownerId: "original-owner",
      candidateSha256: report.candidate.sha256,
      observedAt: "2026-10-04T00:00:00.000Z",
    },
  ];
  await f.put("readiness", f.readiness);
  assert.equal((await f.report()).facts.find((entry) => entry.fact === "query").state, "unknown");
  f.readiness.observations[0].observedAt = "2026-10-02T00:00:00.000Z";
  f.readiness.observations[0].candidateSha256 = "b".repeat(64);
  await f.put("readiness", f.readiness);
  assert.equal(
    (await f.report()).facts.find((entry) => entry.fact === "query").relation,
    "candidate-mismatch",
  );
});

test("a wider new human grant supersedes only the old overlap and keeps its newly authorized stage", async (t) => {
  const f = await fixture(t, "27", "None");
  await prepareRuntimeFixture(f.input, {
    observedAt: "2026-10-03T00:00:00.000Z",
  });
  await f.put("setup-allow", { ...f.allow, stages: ["service-structure"] });
  f.readiness.instructions.push("setup-allow");
  await f.put("old-offline", { ...f.allow, effect: "deny" });
  f.allow.stages = ["offline-checks", "model"];
  f.allow.supersedes = ["old-offline"];
  await f.put("allow", f.allow);
  f.readiness.instructions.push("old-offline");
  await f.put("readiness", f.readiness);
  const report = await f.report();
  assert.equal(
    report.authorization.find((entry) => entry.stage === "offline-checks").status,
    "allowed",
  );
  assert.equal(report.authorization.find((entry) => entry.stage === "model").status, "allowed");
  assert.equal(report.suggestions.find((entry) => entry.stage === "model").status, "can-continue");
});

test("an incomplete current stop keeps known model scope and requires the missing action before it can continue", async (t) => {
  const f = await fixture(t, "27", "None");
  f.allow.stages = ["offline-checks", "model"];
  await f.put("allow", f.allow);
  f.readiness.executionPolicy = {
    currentRoundId: "round-2",
    current: { roundId: "round-2", access: "full", approval: "never" },
    stops: [
      {
        kind: "model-capacity",
        roundId: "round-2",
        stage: "model",
        reasonCode: "capacity-limit",
      },
    ],
  };
  await f.put("readiness", f.readiness);
  const report = await f.report();
  assert.equal(report.executionPolicy.stops[0].stage, "model");
  assert.equal(report.executionPolicy.stops[0].roundId, "round-2");
  assert.equal(report.executionPolicy.stops[0].actionId, null);
  assert.equal(report.suggestions.find((entry) => entry.stage === "model").status, "unknown");
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "model").minimumGap,
    "STOP_ACTION_SCOPE_ROUND_AND_REASON_REQUIRED",
  );
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "offline-checks").status,
    "can-continue",
  );
});

test("an available action without a visible effective current policy stays unknown rather than approval-free", async (t) => {
  const f = await fixture(t, "27", "None");
  f.allow.stages = ["offline-checks", "model"];
  await f.put("allow", f.allow);
  for (const current of [
    { roundId: "round-2", access: "unknown", approval: "never" },
    { roundId: "round-2", access: "full", approval: "unknown" },
  ]) {
    f.readiness.executionPolicy = {
      currentRoundId: "round-2",
      current,
      pendingAction: {
        visibility: "available",
        roundId: "round-2",
        stage: "model",
        actionId: "model-action",
        approvalState: "none",
      },
    };
    await f.put("readiness", f.readiness);
    const report = await f.report();
    assert.equal(report.executionPolicy.pendingAction.status, "unknown");
    assert.equal(report.executionPolicy.pendingAction.actionId, "model-action");
    assert.equal(
      report.suggestions.find((entry) => entry.stage === "model").minimumGap,
      "EFFECTIVE_CURRENT_POLICY_REQUIRED",
    );
    assert.equal(report.suggestions.find((entry) => entry.stage === "model").status, "unknown");
    assert.equal(
      report.suggestions.find((entry) => entry.stage === "offline-checks").status,
      "can-continue",
    );
  }
});

test("a cross-stage supersession cycle stays unknown for both affected grants while an independent stage remains visible", async (t) => {
  const f = await fixture(t, "27", "None");
  await f.put("cycle-offline", {
    ...f.allow,
    stages: ["offline-checks"],
    supersedes: ["cycle-model"],
  });
  await f.put("cycle-model", {
    ...f.allow,
    stages: ["model"],
    supersedes: ["cycle-offline"],
  });
  await f.put("allow", { ...f.allow, stages: ["source-candidate"] });
  f.readiness.instructions = ["allow", "cycle-offline", "cycle-model"];
  await f.put("readiness", f.readiness);
  const report = await f.report();
  assert.equal(
    report.authorization.find((entry) => entry.stage === "offline-checks").status,
    "unknown",
  );
  assert.equal(report.authorization.find((entry) => entry.stage === "model").status, "unknown");
  assert.equal(
    report.suggestions.find((entry) => entry.stage === "source-candidate").status,
    "can-continue",
  );
});

test("a conflicting prerequisite ticket cannot satisfy dependencies while one matching done ticket can", async (t) => {
  const f = await fixture(t, "06");
  f.allow.dependencyExceptions = [];
  f.allow.stages = ["offline-checks", "frozen-assembly"];
  await f.put("allow", f.allow);
  for (const text of [
    "# 14: previous\n# 99: other authority\n\n**Status:** done\n",
    "# 14: previous\n# 14: duplicate authority\n\n**Status:** done\n",
    "# 99: wrong authority\n\n**Status:** done\n",
    "# 14: previous\n\n**Status:** done\n**Status:** in-progress\n",
    "# 14: previous\n\n**Status:** unsupported\n",
  ]) {
    await f.put("predecessor", text);
    const r = await f.report();
    assert.equal(r.dependencies.status, "unknown");
    assert.equal(r.dependencies.predecessors[0].executionStatus, "unknown");
    for (const stage of ["offline-checks", "frozen-assembly"]) {
      const suggestion = r.suggestions.find((v) => v.stage === stage);
      assert.equal(suggestion.status, "unknown");
      assert.equal(suggestion.minimumGap, "PREDECESSOR_DONE_REQUIRED");
      assert.ok(suggestion.evidence.some((v) => v.sourceId === "predecessor"));
    }
  }
  await f.put("predecessor", "# 14: previous\n\n**Status:** done\n");
  const valid = await f.report();
  assert.equal(valid.dependencies.status, "satisfied");
  assert.equal(valid.dependencies.predecessors[0].executionStatus, "done");
  for (const stage of ["offline-checks", "frozen-assembly"])
    assert.equal(valid.suggestions.find((v) => v.stage === stage).status, "can-continue");
  f.allow.dependencyExceptions = ["14"];
  f.allow.stages = ["offline-checks"];
  await f.put("allow", f.allow);
  await f.put("predecessor", "# 14: previous\n# 99: conflict\n\n**Status:** in-progress\n");
  assert.equal(
    (await f.report()).suggestions.find((v) => v.stage === "offline-checks").status,
    "unknown",
  );
  await f.put("predecessor", "# 14: previous\n\n**Status:** in-progress\n");
  const exception = await f.report();
  assert.equal(exception.dependencies.status, "blocked");
  assert.equal(
    exception.suggestions.find((v) => v.stage === "offline-checks").status,
    "can-continue",
  );
  assert.equal(exception.suggestions.find((v) => v.stage === "frozen-assembly").status, "blocked");
});

test("an impossible calendar date cannot become current readiness evidence", async (t) => {
  const f = await fixture(t, "27", "None");
  const candidate = (await f.report()).candidate.sha256;
  f.readiness.observations = [
    {
      fact: "query",
      state: "zero",
      runId: "fixture-run",
      combinationId: "fixture-combination",
      ownerId: "original-owner",
      candidateSha256: candidate,
      observedAt: "2026-02-28T00:00:00.000Z",
    },
  ];
  await f.put("readiness", f.readiness);
  let fact = (await f.report()).facts.find((entry) => entry.fact === "query");
  assert.equal(fact.state, "zero");
  assert.equal(fact.relation, "current");
  f.readiness.observations[0].observedAt = "2026-02-30T00:00:00.000Z";
  await f.put("readiness", f.readiness);
  fact = (await f.report()).facts.find((entry) => entry.fact === "query");
  assert.equal(fact.state, "unknown");
  assert.notEqual(fact.relation, "current");
});

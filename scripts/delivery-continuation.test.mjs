import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { checkDelivery } from "./delivery-check.mjs";

const when = { observedAt: "2026-10-09T12:00:00.000Z" };
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "delivery-continuation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const task = {
    id: "06",
    ticket: { id: "ticket", path: "ticket.md" },
    candidate: { id: "candidate", path: "candidate.json" },
    delivery: { id: "delivery", path: "delivery.json" },
    inputs: [],
  };
  const request = { root, projectId: "split", tasks: [task] };
  async function put(id, value) {
    const path = `${id}.${typeof value === "string" ? "md" : "json"}`;
    await writeFile(
      join(root, path),
      typeof value === "string" ? value : JSON.stringify(value),
    );
    if (!task.inputs.some((ref) => ref.id === id))
      task.inputs.push({ id, path });
  }
  await writeFile(
    join(root, "ticket.md"),
    "# 06: derived delivery\n\n**Blocked by:** None\n\n**Status:** in-progress\n",
  );
  const candidate = JSON.stringify({
    taskId: "06",
    projectId: "split",
    kind: "clean",
    commit: "a".repeat(40),
  });
  await writeFile(join(root, "candidate.json"), candidate);
  const delivery = {
    taskId: "06",
    projectId: "split",
    requiredChecks: ["behavior"],
    checks: [
      {
        id: "behavior",
        scope: "offline",
        status: "passed",
        candidateSha256: hash(candidate),
        inputs: [],
        observedAt: "2026-10-09T10:00:00.000Z",
        counts: { passed: 1, failed: 0, skipped: 0 },
      },
    ],
    goal: { id: "full-route", stages: ["offline-checks", "model"] },
  };
  async function report() {
    await writeFile(join(root, "delivery.json"), JSON.stringify(delivery));
    return (await checkDelivery(request, when)).tasks[0];
  }
  return { root, request, task, delivery, put, report };
}

test("budget derives physical confirmed calls from one receipt and never extends its cutoff from normal exit", async (t) => {
  const f = await fixture(t);
  await f.put("read", {
    at: "2026-10-09T10:30:00.000Z",
    case: "read-one",
    SQL: 3,
    REST: 2,
    models: 0,
    businessWrites: 0,
    terminalSnapshotAt: "2026-10-09T10:20:00.000Z",
    postSnapshotBusinessAttempts: "unknown; no zero claim",
    normalStop: { exitCode: 0, NativeStopped: true },
  });
  f.delivery.budget = { receipts: [{ sourceId: "read", caseId: "read-one" }] };
  const task = await f.report();
  assert.equal(task.budget.status, "observed");
  assert.deepEqual(task.budget.counts.SQL, {
    confirmed: 3,
    completeness: "recorded",
  });
  assert.deepEqual(task.budget.counts.REST, {
    confirmed: 2,
    completeness: "recorded",
  });
  assert.equal(task.budget.through, "2026-10-09T10:20:00.000Z");
  assert.equal(task.budget.afterCutoff, "unknown");
  assert.equal(task.budget.counts.models.confirmed, 0);
  assert.equal(task.budget.effectsAfterCutoff, "unknown");
  assert.equal(task.budget.evidence[0].sourceId, "read");
  assert.equal(
    task.budget.evidence[0].sha256,
    hash(await readFile(join(f.root, "read.json"))),
  );
});

async function permission(f, effect = "allow", blockedBy = "None") {
  await writeFile(
    join(f.root, "ticket.md"),
    `# 06: derived delivery\n\n**Blocked by:** ${blockedBy}\n\n**Status:** in-progress\n`,
  );
  await f.put("instruction", {
    kind: "human-instruction",
    projectId: "split",
    provenance: {
      author: "human",
      interface: "official-user-message",
      threadId: "fixture-human",
      itemId: "fixture-message",
    },
    taskIds: ["06"],
    stages: ["frozen-assembly"],
    action: "manual-work",
    effect,
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "06",
    projectId: "split",
    instructions: ["instruction"],
    predecessors:
      blockedBy === "None" ? [] : [{ taskId: "01", sourceId: "prior" }],
  });
  f.delivery.goal = {
    id: "full-route",
    stages: ["offline-checks", "frozen-assembly"],
  };
}

test("offline stage completion retains independently authorized assembly as the next action", async (t) => {
  const f = await fixture(t);
  await permission(f);
  const task = await f.report();
  assert.equal(task.continuation.state, "actionable");
  assert.deepEqual(
    task.continuation.verified.map((item) => item.stage),
    ["offline-checks"],
  );
  assert.deepEqual(
    task.continuation.remaining.map((item) => item.stage),
    ["frozen-assembly"],
  );
  assert.deepEqual(
    task.continuation.independentNextActions.map((item) => item.stage),
    ["frozen-assembly"],
  );
  assert.equal(task.continuation.goal.id, "full-route");
  assert.equal(
    task.continuation.inputs.find((input) => input.sourceId === "candidate")
      .sha256,
    task.candidate.sha256,
  );
  assert.equal(task.continuation.performsActions, false);
});

test("an explicit human pause remains a pause rather than an external blocker", async (t) => {
  const f = await fixture(t);
  await permission(f, "pause");
  const task = await f.report();
  assert.equal(task.continuation.state, "user-paused");
  assert.equal(task.continuation.independentNextActions.length, 0);
  assert.equal(task.continuation.remaining[0].cause, "user-paused");
  assert.equal(
    task.continuation.remaining[0].minimumGap,
    "HUMAN_RESUME_FOR_SAME_SCOPE_REQUIRED",
  );
});

test("unfinished original prerequisites block the dependent action without becoming a user pause", async (t) => {
  const f = await fixture(t);
  await permission(f, "allow", "01：input check");
  await f.put("prior", "# 01: input check\n\n**Status:** in-progress\n");
  const task = await f.report();
  assert.equal(task.continuation.state, "dependency-unmet");
  assert.equal(task.continuation.remaining[0].cause, "dependency-unmet");
  assert.equal(task.continuation.independentNextActions.length, 0);
  assert.equal(
    task.dependencies.predecessors[0].executionStatus,
    "in-progress",
  );
});

test("a scoped external final review is an external condition when no independent action remains", async (t) => {
  const f = await fixture(t);
  await permission(f);
  const instruction = JSON.parse(
    await readFile(join(f.root, "instruction.json")),
  );
  instruction.stages = ["offline-checks"];
  await f.put("instruction", instruction);
  await f.put("review-rule", {
    ...instruction,
    action: "review-rule",
    reviewMode: "external-final",
  });
  await f.put("readiness", {
    kind: "authorization-readiness",
    taskId: "06",
    projectId: "split",
    instructions: ["instruction", "review-rule"],
    predecessors: [],
    review: { sourceId: "review", requiredInputs: [] },
  });
  f.delivery.goal.stages = ["offline-checks"];
  f.delivery.checks[0].status = "not-run";
  const task = await f.report();
  assert.equal(task.continuation.state, "external-conditions");
  assert.equal(task.continuation.remaining[0].cause, "external-condition");
  assert.equal(
    task.continuation.remaining[0].minimumGap,
    "EXTERNAL_REVIEW_EVIDENCE_REQUIRED",
  );
  assert.equal(task.continuation.independentNextActions.length, 0);
});

test("old budget projections cannot disagree on confirmed SQL or closed window activation", async (t) => {
  const f = await fixture(t);
  await f.put("old-budget", {
    at: "2026-10-09T00:51:31.109015+00:00",
    stage: "48",
    actualCounts: { physicalSQLRequests: 100 },
    currentSQLResult: "90 cumulative confirmed SQL; no counters reset",
    currentWindowActive: false,
    proposedCompanySingleSnapshot: { activated: true },
    temporaryLimitsRestored: true,
    referenceRecovery: {
      currentRuntime: "running locked; normal stop pending",
    },
  });
  f.delivery.reconciliation = [
    { sourceId: "old-budget", profile: "call-budget" },
  ];
  const task = await f.report();
  assert.equal(task.reconciliation.status, "failed");
  assert.deepEqual(
    task.reconciliation.conflicts.map((conflict) => conflict.reason).sort(),
    [
      "BUDGET_PROJECTION_CONFLICT",
      "RESTORATION_PROJECTION_CONFLICT",
      "WINDOW_ACTIVATION_CONFLICT",
    ],
  );
  assert.equal(
    task.reconciliation.records[0].observedAt,
    "2026-10-09T00:51:31.109Z",
  );
  assert.equal(
    task.reconciliation.conflicts[0].evidence[0].sourceId,
    "old-budget",
  );
});

test("the original interrupted navigation r7 receipt stays unknown even beside a normal exit", async (t) => {
  const f = await fixture(t);
  const original = await readFile(
    new URL(
      "./fixtures/delivery-history/navigation-r7-setup-failure.json",
      import.meta.url,
    ),
  );
  await writeFile(join(f.root, "r7.json"), original);
  f.task.inputs.push({ id: "r7", path: "r7.json" });
  await f.put("stop", {
    at: "2026-10-09T10:00:00.000Z",
    case: "later-stop",
    exitCode: 0,
    NativeStopped: true,
    SQL: 0,
    models: 0,
    businessWrites: 0,
  });
  f.delivery.budget = {
    receipts: [
      { sourceId: "r7", caseId: "48-navigation-r7-interrupted-setup" },
      { sourceId: "stop", caseId: "later-stop" },
    ],
  };
  const task = await f.report();
  assert.equal(task.budget.status, "unknown");
  assert.deepEqual(task.budget.counts.models, {
    confirmed: 0,
    completeness: "unknown",
  });
  assert.equal(task.budget.records[0].counts.SQL, null);
  assert.equal(task.budget.records[0].effects, "unknown");
  assert.equal(task.budget.effectsAfterCutoff, "unknown");
  assert.deepEqual(await readFile(join(f.root, "r7.json")), original);
});

test("the public continuation CLI emits the same scoped next action without dispatching or writing inputs", async (t) => {
  const f = await fixture(t);
  await permission(f);
  await f.report();
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  const before = await readFile(join(f.root, "delivery.json"));
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      join(f.root, "request.json"),
      "--continuation",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tasks[0].state, "actionable");
  assert.equal(
    report.tasks[0].independentNextActions[0].stage,
    "frozen-assembly",
  );
  assert.equal(report.tasks[0].performsActions, false);
  assert.equal(report.continuation.state, "actionable");
  assert.deepEqual(await readFile(join(f.root, "delivery.json")), before);
});

test("unused receipt quota is derived but never becomes a new current allowance", async (t) => {
  const f = await fixture(t);
  await f.put("read", {
    at: "2026-10-09T10:30:00.000Z",
    case: "read-one",
    SQL: 0,
    REST: 2,
    models: 0,
    businessWrites: 0,
    readonlyValidation: {
      limits: { maxRequests: 3, metadata: 1 },
      spent: { maxRequests: 2, metadata: 1 },
    },
    normalStop: { exitCode: 0, NativeStopped: true },
  });
  f.delivery.budget = { receipts: [{ sourceId: "read", caseId: "read-one" }] };
  const task = await f.report();
  assert.deepEqual(task.budget.records[0].quota[0], {
    metric: "maxRequests",
    limit: 3,
    spent: 2,
    unspentRecorded: 1,
    usableNow: "unknown",
  });
  assert.equal(task.budget.records[0].quota[1].unspentRecorded, 0);
  assert.equal(task.budget.afterCutoff, "unknown");
});

test("a missing scoped budget rejects continuation while a generated CLI report still exits zero", async (t) => {
  const f = await fixture(t);
  await permission(f);
  f.delivery.budget = {
    receipts: [{ sourceId: "missing", caseId: "read-one" }],
  };
  const task = await f.report();
  assert.equal(task.consistency.status, "unknown");
  assert.equal(task.continuation.state, "unknown");
  assert.equal(task.continuation.independentNextActions.length, 0);
  assert.equal(
    task.suggestions.find((item) => item.stage === "frozen-assembly").status,
    "unknown",
  );
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      join(f.root, "request.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.consistency.status, "unknown");
  assert.equal(report.consistency.generated, true);
  assert.equal(report.consistency.acceptance, "not-evaluated");
});

function verificationCLI(f) {
  return spawnSync(
    process.execPath,
    ["--run", "delivery:check", "--", "--input", join(f.root, "request.json")],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
  );
}

function goalCLI(f) {
  return spawnSync(
    process.execPath,
    [
      "--run",
      "delivery:verify-goal",
      "--",
      "--input",
      join(f.root, "request.json"),
      "--continuation",
    ],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
  );
}

// Replays the stage-closeout pattern documented in
// .scratch/real-readonly-48/evidence/retro-20261009-closeout/report.md.
// The permission and inputs below are test fixtures, not new business receipts.
test("goal verification rejects a done stage with independently authorized work remaining", async (t) => {
  const f = await fixture(t);
  await permission(f);
  await writeFile(
    join(f.root, "ticket.md"),
    "# 06: stage closed\n\n**Blocked by:** None\n\n**Status:** done\n",
  );
  const task = await f.report();
  assert.equal(task.executionStatus, "done");
  assert.equal(task.continuation.state, "actionable");
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  assert.equal(verificationCLI(f).status, 0);
  const result = goalCLI(f);
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verification.reason, "DECLARED_GOAL_INCOMPLETE");
  assert.equal(report.continuation.state, "actionable");
  assert.equal(report.continuation.independentNextActions.length, 1);
  assert.equal(report.continuation.performsActions, false);
  const direct = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--verify-goal",
      "--input",
      join(f.root, "request.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(direct.status, 4, direct.stdout);
});

test("goal verification preserves a human pause and missing goal instead of treating either as completion", async (t) => {
  const f = await fixture(t);
  await permission(f, "pause");
  await f.report();
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  let result = goalCLI(f);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).continuation.state, "user-paused");
  delete f.delivery.goal;
  await f.report();
  result = goalCLI(f);
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).continuation.state, "unknown");
});

test("goal verification admits the verified declared scope without granting business acceptance or editing the ticket", async (t) => {
  const f = await fixture(t);
  f.delivery.goal.stages = ["offline-checks"];
  await f.report();
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  const before = await readFile(join(f.root, "ticket.md"));
  const result = goalCLI(f);
  assert.equal(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verification.reason, "DECLARED_GOAL_VERIFIED");
  assert.equal(report.consistency.exitZeroMeans, "declared-goal-verified-only");
  assert.equal(report.consistency.acceptance, "not-evaluated");
  assert.equal(report.continuation.state, "completed");
  assert.equal(report.tasks[0].executionStatus, "in-progress");
  assert.deepEqual(await readFile(join(f.root, "ticket.md")), before);
});

test("verification refuses the real r31 counters and closed-window contradictions instead of treating report generation as a pass", async (t) => {
  const f = await fixture(t);
  const historical = await readFile(
    new URL(
      "./fixtures/delivery-history/r31-budget-projection.json",
      import.meta.url,
    ),
    "utf8",
  );
  await f.put("old-budget", JSON.parse(historical));
  f.delivery.reconciliation = [
    { sourceId: "old-budget", profile: "call-budget" },
  ];
  const task = await f.report();
  assert.equal(task.consistency.status, "failed");
  assert.ok(
    task.reconciliation.conflicts.some(
      (item) => item.reason === "BUDGET_PROJECTION_CONFLICT",
    ),
  );
  assert.ok(
    task.reconciliation.conflicts.some(
      (item) => item.reason === "WINDOW_ACTIVATION_CONFLICT",
    ),
  );
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  const before = await readFile(join(f.root, "old-budget.json"));
  const generated = spawnSync(
    process.execPath,
    ["--run", "delivery:report", "--", "--input", join(f.root, "request.json")],
    { cwd: join(import.meta.dirname, ".."), encoding: "utf8" },
  );
  assert.equal(generated.status, 0);
  assert.equal(JSON.parse(generated.stdout).consistency.status, "failed");
  const result = verificationCLI(f);
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.consistency.status, "failed");
  assert.equal(report.verification.status, "failed");
  assert.equal(report.verification.reason, "DELIVERY_CONSISTENCY_REQUIRED");
  assert.deepEqual(await readFile(join(f.root, "old-budget.json")), before);
});

test("verification refuses unknown inputs and admits only observed consistency without evaluating business acceptance", async (t) => {
  const f = await fixture(t);
  await f.report();
  await writeFile(join(f.root, "request.json"), JSON.stringify(f.request));
  let result = verificationCLI(f);
  assert.equal(result.status, 0, result.stdout);
  let report = JSON.parse(result.stdout);
  assert.equal(report.verification.status, "passed");
  assert.equal(report.consistency.acceptance, "not-evaluated");
  assert.equal(report.consistency.exitZeroMeans, "consistency-observed-only");
  f.delivery.budget = {
    receipts: [{ sourceId: "missing", caseId: "read-one" }],
  };
  await f.report();
  result = verificationCLI(f);
  assert.notEqual(result.status, 0, result.stdout);
  report = JSON.parse(result.stdout);
  assert.equal(report.consistency.status, "unknown");
  assert.equal(report.verification.status, "failed");
  const direct = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--verify",
      "--input",
      join(f.root, "request.json"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(direct.status, 3, direct.stdout);
});

test("an empty report cannot satisfy strict consistency verification", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "request.json"),
    JSON.stringify({ ...f.request, tasks: [] }),
  );
  const result = verificationCLI(f);
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.tasks.length, 0);
  assert.equal(report.verification.status, "failed");
});

test("an unmet original ticket does not stop a separately scoped authorized task", async (t) => {
  const f = await fixture(t);
  await permission(f);
  await f.report();
  await f.put(
    "dependent-ticket",
    "# 27: original route\n\n**Blocked by:** 26：original dependency\n\n**Status:** blocked\n",
  );
  await f.put("dependent-candidate", {
    taskId: "27",
    projectId: "split",
    kind: "clean",
    commit: "b".repeat(40),
  });
  await f.put("dependent-delivery", {
    taskId: "27",
    projectId: "split",
    requiredChecks: [],
    checks: [],
    goal: { id: "original-route", stages: ["real-data"] },
  });
  f.request.tasks.push({
    id: "27",
    ticket: { id: "dependent-ticket", path: "dependent-ticket.md" },
    candidate: { id: "dependent-candidate", path: "dependent-candidate.json" },
    delivery: { id: "dependent-delivery", path: "dependent-delivery.json" },
  });
  const report = await checkDelivery(f.request, when);
  assert.equal(report.continuation.state, "actionable");
  assert.deepEqual(
    report.continuation.independentNextActions.map((action) => action.taskId),
    ["06"],
  );
  assert.equal(report.tasks[1].continuation.state, "unknown");
  assert.equal(report.tasks[1].executionStatus, "blocked");
});

test("future receipts, conflicting aliases and duplicate case observations never supply a current budget", async (t) => {
  const f = await fixture(t);
  await permission(f);
  await f.put("read", {
    at: "2026-10-10T10:00:00.000Z",
    case: "read-one",
    SQL: 0,
    models: 0,
    businessWrites: 0,
  });
  f.delivery.budget = { receipts: [{ sourceId: "read", caseId: "read-one" }] };
  let task = await f.report();
  assert.equal(task.budget.status, "unknown");
  assert.equal(task.budget.records[0].relation, "unavailable");
  assert.equal(task.continuation.independentNextActions.length, 0);
  await f.put("read", {
    at: "2026-10-09T10:00:00.000Z",
    case: "read-one",
    SQL: 3,
    physicalSQL: 4,
    models: 0,
    businessWrites: 0,
  });
  task = await f.report();
  assert.equal(task.budget.counts.SQL.confirmed, null);
  assert.equal(task.budget.status, "unknown");
  f.delivery.budget.receipts.push({ sourceId: "read", caseId: "read-one" });
  task = await f.report();
  assert.equal(task.budget.status, "unknown");
  assert.equal(task.budget.counts.SQL.confirmed, null);
});

test("a recorded physical quota overrun is failed rather than unused budget", async (t) => {
  const f = await fixture(t);
  await permission(f);
  await f.put("read", {
    at: "2026-10-09T10:00:00.000Z",
    case: "read-one",
    SQL: 0,
    REST: 4,
    models: 0,
    businessWrites: 0,
    readonlyValidation: {
      limits: { maxRequests: 3 },
      spent: { maxRequests: 4 },
    },
  });
  f.delivery.budget = { receipts: [{ sourceId: "read", caseId: "read-one" }] };
  const task = await f.report();
  assert.equal(task.budget.status, "failed");
  assert.equal(task.budget.reason, "RECORDED_PHYSICAL_QUOTA_EXCEEDED");
  assert.equal(task.consistency.status, "failed");
  assert.equal(task.continuation.independentNextActions.length, 0);
  assert.equal(task.budget.records[0].quota[0].unspentRecorded, null);
});

test("a nonexistent calendar date cannot become a receipt observation time", async (t) => {
  const f = await fixture(t);
  await f.put("read", {
    at: "2026-02-30T10:00:00.000Z",
    case: "read-one",
    SQL: 0,
    models: 0,
    businessWrites: 0,
  });
  f.delivery.budget = { receipts: [{ sourceId: "read", caseId: "read-one" }] };
  const task = await f.report();
  assert.equal(task.budget.status, "unknown");
  assert.equal(task.budget.records[0].observedAt, null);
});

test("a done ticket cannot finish an unverified full goal", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, "ticket.md"),
    "# 06: stage closed\n\n**Blocked by:** None\n\n**Status:** done\n",
  );
  const task = await f.report();
  assert.equal(task.executionStatus, "done");
  assert.equal(task.continuation.state, "unknown");
  assert.deepEqual(
    task.continuation.verified.map((item) => item.stage),
    ["offline-checks"],
  );
  assert.deepEqual(
    task.continuation.remaining.map((item) => item.stage),
    ["model"],
  );
  assert.equal(task.continuation.independentNextActions.length, 0);
});

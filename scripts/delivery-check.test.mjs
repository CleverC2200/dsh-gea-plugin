import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  link,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { checkDelivery } from "./delivery-check.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-delivery-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = JSON.stringify({
    taskId: "15",
    projectId: "split",
    kind: "clean",
    commit: "a".repeat(40),
  });
  await writeFile(join(root, "candidate.json"), candidate);
  await writeFile(
    join(root, "ticket.md"),
    "# 15: offline migration\n\n**Status:** in-progress\n",
  );
  await writeFile(
    join(root, "delivery.json"),
    JSON.stringify({
      taskId: "15",
      projectId: "split",
      requiredChecks: ["behavior"],
      checks: [
        {
          id: "behavior",
          scope: "offline",
          status: "passed",
          candidateSha256: hash(candidate),
          inputs: [],
          observedAt: "2026-10-02T16:00:00.000Z",
          owner: "implementer",
          counts: { passed: 3, failed: 0, skipped: 0 },
        },
      ],
    }),
  );
  return {
    root,
    projectId: "split",
    tasks: [
      {
        id: "15",
        ticket: { id: "ticket-15", path: "ticket.md" },
        candidate: { id: "candidate-15", path: "candidate.json" },
        delivery: { id: "delivery-15", path: "delivery.json" },
      },
    ],
  };
}
test("an identified offline delivery reuses scoped checks without promoting later stages", async (t) => {
  const input = await fixture(t);
  const report = await checkDelivery(input, {
    observedAt: "2026-10-02T17:00:00.000Z",
  });
  const task = report.tasks[0];
  assert.equal(task.executionStatus, "in-progress");
  assert.equal(
    task.stages.find((s) => s.stage === "source-candidate").status,
    "passed",
  );
  assert.equal(
    task.stages.find((s) => s.stage === "offline-checks").status,
    "passed",
  );
  assert.equal(
    task.stages.find((s) => s.stage === "offline-checks").proof,
    "recorded-reused",
  );
  assert.equal(
    task.stages.find((s) => s.stage === "frozen-assembly").status,
    "not-run",
  );
  assert.equal(
    task.stages.find((s) => s.stage === "gea-authorization").status,
    "not-run",
  );
  assert.equal(task.candidate.proof, "recorded-snapshot");
});
test("check sets retain historical failures and skips without summing or replacing current failures", async (t) => {
  const input = await fixture(t);
  const path = join(input.root, "delivery.json");
  const delivery = JSON.parse(await readFile(path, "utf8"));
  delivery.checks.push({
    ...delivery.checks[0],
    candidateSha256: "b".repeat(64),
    status: "failed",
    counts: { passed: 0, failed: 1, skipped: 0 },
  });
  await writeFile(path, JSON.stringify(delivery));
  let task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.stages[1].status, "passed");
  assert.equal(task.checks[1].relation, "historical");
  assert.deepEqual(task.checks[1].counts, { passed: 0, failed: 1, skipped: 0 });
  delivery.checks[0].status = "failed";
  await writeFile(path, JSON.stringify(delivery));
  task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.stages[1].status, "failed");
  delivery.checks[0].status = "skipped";
  await writeFile(path, JSON.stringify(delivery));
  task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.stages[1].status, "not-run");
  delivery.checks[0].status = "passed";
  delivery.checks[0].inputs = [{ id: "rules", sha256: "c".repeat(64) }];
  await writeFile(join(input.root, "rules.md"), "current input");
  input.tasks[0].inputs = [{ id: "rules", path: "rules.md" }];
  await writeFile(path, JSON.stringify(delivery));
  task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.stages[1].status, "unknown");
  assert.equal(task.checks[0].relation, "input-mismatch");
});
test("dirty candidate bytes invalidate matching HEAD records when content changes", async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.root, "source.txt"), "reviewed source");
  const candidate = {
    taskId: "15",
    projectId: "split",
    kind: "dirty",
    commit: "a".repeat(40),
    files: [
      { id: "source", path: "source.txt", sha256: hash("reviewed source") },
    ],
  };
  const bytes = JSON.stringify(candidate);
  await writeFile(join(input.root, "candidate.json"), bytes);
  const delivery = JSON.parse(
    await readFile(join(input.root, "delivery.json"), "utf8"),
  );
  delivery.checks[0].candidateSha256 = hash(bytes);
  await writeFile(join(input.root, "delivery.json"), JSON.stringify(delivery));
  const before = (await checkDelivery(input)).tasks[0];
  assert.equal(before.stages[0].status, "passed");
  await writeFile(join(input.root, "source.txt"), "unreviewed repair");
  const after = (await checkDelivery(input)).tasks[0];
  assert.equal(after.candidate.commit, before.candidate.commit);
  assert.notEqual(
    after.candidate.contentSha256,
    before.candidate.contentSha256,
  );
  assert.equal(after.stages[0].status, "failed");
  assert.equal(after.stages[1].status, "unknown");
});
async function tree(path) {
  const result = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = join(path, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await tree(name)
      : hash(await readFile(name));
  }
  return result;
}
test("grouped observations preserve populated Sessions and absent directories across repeat reads", async (t) => {
  const input = await fixture(t);
  await mkdir(join(input.root, "sessions"));
  await writeFile(
    join(input.root, "sessions", "native-session.json"),
    '{"id":"fixture-session","messages":["kept"]}',
  );
  input.tasks[0].session = { id: "session-15", path: "sessions" };
  input.tasks.push({
    id: "27",
    ticket: { id: "ticket-27", path: "missing-ticket.md" },
    candidate: { id: "candidate-27", path: "absent-candidate.json" },
    delivery: { id: "delivery-27", path: "absent-delivery.json" },
    session: { id: "session-27", path: "missing-session" },
  });
  const before = await tree(input.root);
  const first = await checkDelivery(input, {
    observedAt: "2026-10-02T17:00:00.000Z",
  });
  assert.deepEqual(
    await checkDelivery(input, { observedAt: "2026-10-02T17:00:00.000Z" }),
    first,
  );
  assert.equal(
    first.tasks[0].stages.find((s) => s.stage === "session-recovery").status,
    "not-run",
  );
  assert.equal(first.tasks[0].session.state, "present");
  assert.equal(
    first.tasks[1].stages.find((s) => s.stage === "session-recovery").status,
    "blocked",
  );
  assert.equal(first.tasks[1].stages[0].status, "unknown");
  assert.equal(first.tasks[1].executionStatus, "unknown");
  assert.deepEqual(await tree(input.root), before);
});
test("CLI emits a safe derived report and keeps explicit non-applicability source-bound", async (t) => {
  const input = await fixture(t);
  const path = join(input.root, "delivery.json");
  const delivery = JSON.parse(await readFile(path, "utf8"));
  delivery.url = "https://sensitive.invalid/?token=DO_NOT_PRINT";
  delivery.password = "DO_NOT_PRINT";
  delivery.rawAuthenticationLog = "Cookie=DO_NOT_PRINT";
  delivery.checks[0].message = "token=DO_NOT_PRINT";
  delivery.notApplicable = [
    {
      stage: "formal-release",
      reasonCode: "outside-task-scope",
      sourceId: "ticket-15",
    },
  ];
  await writeFile(path, JSON.stringify(delivery));
  await writeFile(join(input.root, "request.json"), JSON.stringify(input));
  const before = await tree(input.root);
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      join(input.root, "request.json"),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(
    result.stdout,
    /DO_NOT_PRINT|sensitive\.invalid|Cookie|password/,
  );
  const stage = JSON.parse(result.stdout).tasks[0].stages.find(
    (s) => s.stage === "formal-release",
  );
  assert.equal(stage.status, "not-applicable");
  assert.equal(stage.reason, "OUTSIDE_TASK_SCOPE");
  assert.ok(stage.evidence.some((ref) => ref.sourceId === "ticket-15"));
  assert.deepEqual(await tree(input.root), before);
  const bad = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      "https://sensitive.invalid/DO_NOT_PRINT",
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(bad.status, 2);
  assert.doesNotMatch(
    bad.stdout + bad.stderr,
    /DO_NOT_PRINT|sensitive\.invalid/,
  );
});
test("conflicting ticket identity and unbounded proof cannot become an offline pass", async (t) => {
  const input = await fixture(t);
  const deliveryPath = join(input.root, "delivery.json");
  const delivery = JSON.parse(await readFile(deliveryPath, "utf8"));
  delivery.checks[0].scope = "runtime";
  await writeFile(deliveryPath, JSON.stringify(delivery));
  assert.equal(
    (await checkDelivery(input)).tasks[0].stages[1].status,
    "unknown",
  );
  delivery.checks[0].scope = "offline";
  delivery.checks[0].counts = { passed: 3, failed: 0, skipped: -1 };
  await writeFile(deliveryPath, JSON.stringify(delivery));
  assert.equal(
    (await checkDelivery(input)).tasks[0].stages[1].status,
    "unknown",
  );
  delivery.checks[0].counts.skipped = 0;
  await writeFile(deliveryPath, JSON.stringify(delivery));
  await writeFile(
    join(input.root, "ticket.md"),
    "# 27: different task\n\n**Status:** done\n",
  );
  const task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.executionStatus, "unknown");
  assert.equal(task.stages[1].status, "unknown");
  assert.ok(task.diagnostics.some((d) => d.reason === "TASK_TICKET_MISMATCH"));
});
test("ambiguous source identities prevent reuse and safe CLI errors identify the missing input", async (t) => {
  const input = await fixture(t);
  await writeFile(join(input.root, "old-rules.md"), "old rules");
  await writeFile(join(input.root, "new-rules.md"), "new rules");
  input.tasks[0].inputs = [
    { id: "rules", path: "old-rules.md" },
    { id: "rules", path: "new-rules.md" },
  ];
  const path = join(input.root, "delivery.json");
  const delivery = JSON.parse(await readFile(path, "utf8"));
  delivery.checks[0].inputs = [{ id: "rules", sha256: hash("old rules") }];
  await writeFile(path, JSON.stringify(delivery));
  const task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.stages[1].status, "unknown");
  assert.ok(task.diagnostics.some((d) => d.reason === "INPUT_ID_CONFLICT"));
  const missing = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "delivery-check.mjs"),
      "--input",
      join(input.root, "missing.json"),
    ],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).reason, "DELIVERY_REQUEST_MISSING");
});
test("review gaps name missing checks and invalidate drift, skips and ambiguous applicability", async (t) => {
  const input = await fixture(t);
  const path = join(input.root, "delivery.json");
  const delivery = JSON.parse(await readFile(path, "utf8"));
  delivery.requiredChecks.push("lint");
  await writeFile(path, JSON.stringify(delivery));
  let task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.stages[1].status, "unknown");
  assert.ok(
    task.checkGaps.some(
      (gap) => gap.checkId === "lint" && gap.reason === "CHECK_RECORD_REQUIRED",
    ),
  );
  delivery.requiredChecks = ["behavior"];
  delivery.checks[0].counts = { passed: 0, failed: 0, skipped: 3 };
  await writeFile(path, JSON.stringify(delivery));
  assert.equal(
    (await checkDelivery(input)).tasks[0].stages[1].status,
    "unknown",
  );
  await writeFile(join(input.root, "source.txt"), "changed source");
  const candidate = JSON.stringify({
    taskId: "15",
    projectId: "split",
    kind: "dirty",
    commit: "a".repeat(40),
    files: [
      { id: "source", path: "source.txt", sha256: hash("reviewed source") },
    ],
  });
  await writeFile(join(input.root, "candidate.json"), candidate);
  delivery.checks[0].candidateSha256 = hash(candidate);
  delivery.checks[0].counts = { passed: 3, failed: 0, skipped: 0 };
  await writeFile(path, JSON.stringify(delivery));
  task = (await checkDelivery(input)).tasks[0];
  assert.equal(task.checks[0].relation, "candidate-content-mismatch");
  await writeFile(join(input.root, "old-rules.md"), "old rules");
  await writeFile(join(input.root, "new-rules.md"), "new rules");
  input.tasks[0].inputs = [
    { id: "rules", path: "old-rules.md" },
    { id: "rules", path: "new-rules.md" },
  ];
  delivery.notApplicable = [
    {
      stage: "formal-release",
      reasonCode: "outside-task-scope",
      sourceId: "rules",
    },
  ];
  await writeFile(path, JSON.stringify(delivery));
  task = (await checkDelivery(input)).tasks[0];
  assert.equal(
    task.stages.find((s) => s.stage === "formal-release").status,
    "unknown",
  );
});

test("Session hardlink aliases in controlled metadata stay unknown without hashing their bytes", async (t) => {
  const input = await fixture(t);
  await mkdir(join(input.root, "sessions"));
  input.tasks[0].session = { id: "session", path: "sessions" };
  for (const [ref, filename] of [
    ["candidate", "candidate.json"],
    ["ticket", "ticket.md"],
    ["delivery", "delivery.json"],
  ]) {
    const bytes = await readFile(join(input.root, filename));
    await link(
      join(input.root, filename),
      join(input.root, "sessions", filename),
    );
    const r = (
      await checkDelivery(input, { observedAt: "2026-10-03T00:00:00.000Z" })
    ).tasks[0];
    const observed = r.inputs.find((v) => v.id === input.tasks[0][ref].id);
    assert.equal(observed.error, "INPUT_MULTILINK_UNVERIFIABLE");
    assert.equal(observed.sha256, undefined);
    assert.equal(r.stages[ref === "delivery" ? 1 : 0].status, "unknown");
    assert.deepEqual(
      await readFile(join(input.root, "sessions", filename)),
      bytes,
    );
    await rm(join(input.root, "sessions", filename));
  }
  assert.equal(
    (await checkDelivery(input)).tasks[0].stages[0].status,
    "passed",
  );
});

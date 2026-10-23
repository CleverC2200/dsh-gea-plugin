import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionPlan } from "./quality-test-execution.mjs";
import { verifyDocsResults, docsHostedJobScope } from "./quality-docs.mjs";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { windowsNativeInput } from "./ci-windows-update.mjs";
import { assessHostedBudget, unexpandedSkippedJobNames } from "./quality-hosted-budget.mjs";

const expected = {
  cores: ["a".repeat(40)],
  runId: "123",
  runAttempt: "1",
  node: process.versions.node,
  groupId: "frozen-group",
  sources: ["dsh-gea-plugin", "dsh-agent-manage", "dsh-agent-workbench"].map((repo, index) => ({
    repo,
    head: String(index + 1).repeat(40),
  })),
};
function receipt() {
  const plan = createExecutionPlan({
    selection: { files: [], required: [], runtimeFiles: [] },
    platformPlan: { files: [], platformTasks: [] },
    binding: {
      manifest: { core: expected.cores[0], repositories: expected.sources },
      inputSha256: "b".repeat(64),
      dependencyReview: false,
      platform: "linux",
      node: expected.node,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
    },
  });
  return {
    schemaVersion: 1,
    status: "passed",
    applicability: "docs",
    groupId: expected.groupId,
    plan,
    admission: {
      status: "passed",
      inputSha256: plan.binding.inputSha256,
      repositories: expected.sources.map((entry) => ({ ...entry, lockSha256: "c".repeat(64) })),
    },
    checks: ["whitespace", "knowledge"].map((name) => ({ name, status: "passed" })),
  };
}
test("documentation coverage accepts every exact tuple without inventing build or test acceptance", () => {
  const result = verifyDocsResults({ receipts: [receipt()], expected });
  assert.equal(result.status, "passed");
  assert.equal(result.tests, "not-applicable");
  assert.equal(result.build, "not-applicable");
  assert.equal(result.macos, "not-applicable");
});
test("documentation coverage rejects missing, duplicate, failed and stale source obligations", () => {
  for (const receipts of [[], [receipt(), receipt()]])
    assert.throws(() => verifyDocsResults({ receipts, expected }), /QUALITY_DOCS_RECEIPT_REJECTED/);
  for (const change of [
    (r) => (r.status = "failed"),
    (r) => (r.applicability = "source"),
    (r) => (r.groupId = "old"),
    (r) => r.checks.pop(),
    (r) => (r.checks[0].status = "skipped"),
    (r) => (r.checks[0].status = "cancelled"),
    (r) => (r.admission.inputSha256 = "d".repeat(64)),
    (r) => (r.admission.repositories[0].head = "e".repeat(40)),
    (r) => (r.admission.repositories[0].lockSha256 = undefined),
    (r) => (r.plan.binding.runAttempt = "2"),
    (r) => (r.plan.binding.node = "old"),
    (r) => r.plan.selected.push("tests/fake.test.mjs"),
    (r) => r.plan.shards.push({ id: "1", files: [] }),
  ]) {
    const r = receipt();
    change(r);
    assert.throws(
      () => verifyDocsResults({ receipts: [r], expected }),
      /QUALITY_DOCS_RECEIPT_REJECTED|QUALITY_TEST_EXECUTION_REJECTED/,
    );
  }
});

test("the actual failed docs run recognizes only its exact skipped matrix names and preserves applicable failures", () => {
  const snapshot = JSON.parse(
    readFileSync(new URL("./fixtures/quality-docs-run-39233284232.json", import.meta.url)),
  );
  const cores = snapshot.jobs
    .filter((job) => job.name.startsWith("source-plan-"))
    .map((job) => job.name.slice("source-plan-".length));
  const scope = docsHostedJobScope({ snapshot, cores });
  for (const name of unexpandedSkippedJobNames) assert.ok(scope.notApplicableJobs.includes(name));
  const assess = (value) =>
    assessHostedBudget({
      snapshot: value,
      ...scope,
      finalJobName: "candidate-quality",
      mode: "completed",
      now: value.observedAt,
    });
  assert.equal(assess(snapshot).functional.status, "failed");
  assert.ok(
    assess(snapshot).functional.reasons.includes("HOSTED_REQUIRED_JOB: source-plan-" + cores[0]),
  );
  const repaired = structuredClone(snapshot);
  repaired.run.conclusion = "success";
  for (const job of repaired.jobs) if (job.conclusion === "failure") job.conclusion = "success";
  assert.equal(assess(repaired).functional.status, "passed");
  for (const name of unexpandedSkippedJobNames) {
    for (const conclusion of ["success", "failure", "cancelled"]) {
      const changed = structuredClone(repaired);
      changed.jobs.find((job) => job.name === name).conclusion = conclusion;
      assert.ok(assess(changed).functional.reasons.includes("HOSTED_NOT_APPLICABLE_JOB: " + name));
    }
  }
  for (const name of ["prepare-unknown", "prepare-${{ matrix.unknown }}", "other-job"]) {
    const unknown = structuredClone(snapshot);
    unknown.jobs.find((job) => job.name === unexpandedSkippedJobNames[0]).name = name;
    assert.throws(
      () => docsHostedJobScope({ snapshot: unknown, cores }),
      /QUALITY_DOCS_JOB_REJECTED/,
    );
  }
});

test("the public docs final accepts only the scheduler docs path and preserves stale REST observations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "docs-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "windows"));
  writeFileSync(join(root, "docs", "receipt.json"), JSON.stringify(receipt()));
  writeFileSync(
    join(root, "windows", "windows-update-scope.json"),
    JSON.stringify({
      schemaVersion: 1,
      applicable: false,
      sourceHead: expected.sources[0].head,
      group: { groupId: expected.groupId, repositories: expected.sources },
      runtime: windowsNativeInput,
    }),
  );
  const needs = {
    "candidate-scope": { result: "success" },
    "source-plan": { result: "success", outputs: { applicability: "docs" } },
    gates: { result: "skipped" },
    "plan-test-shards": { result: "skipped" },
    "test-shards": { result: "skipped" },
    "macos-isolation": { result: "skipped" },
    "windows-plugin-update": { result: "success" },
    "dependency-review": { result: "skipped" },
  };
  const jobs = [
    "candidate-scope",
    "windows-plugin-update",
    "source-plan-" + expected.cores[0],
    "joint-quality",
  ].map((name, i) => ({
    id: i + 1,
    name,
    run_id: 123,
    run_attempt: 1,
    head_sha: expected.sources[0].head,
    status: "queued",
    conclusion: null,
    started_at: null,
    completed_at: null,
    steps: [{ name: "Post Run actions/setup-node", status: "completed", conclusion: "skipped" }],
  }));
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url.includes("/jobs?")
          ? { total_count: jobs.length, jobs }
          : {
              id: 123,
              run_attempt: 1,
              head_sha: expected.sources[0].head,
              status: "queued",
              conclusion: null,
              created_at: new Date().toISOString(),
              run_started_at: null,
              updated_at: new Date().toISOString(),
            },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const invoke = async (name, schedulerNeeds = needs) => {
    const output = join(root, name);
    const child = spawn(
      process.execPath,
      [
        "scripts/run-quality-ci.mjs",
        "--phase",
        "docs-final",
        "--docs-results",
        join(root, "docs"),
        "--windows-results",
        join(root, "windows"),
        "--final-output",
        output,
      ],
      {
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          QUALITY_EXPECTED_WORKFLOW_SHA: expected.sources[0].head,
          QUALITY_FINAL_MANAGE_SHA: expected.sources[1].head,
          QUALITY_FINAL_WORKBENCH_SHA: expected.sources[2].head,
          QUALITY_FINAL_GROUP_ID: expected.groupId,
          QUALITY_FINAL_CORES: JSON.stringify(expected.cores),
          QUALITY_FINAL_JOB_NAME: "joint-quality",
          QUALITY_FINAL_NEEDS: JSON.stringify(schedulerNeeds),
          QUALITY_HOSTED_API_BASE: `http://127.0.0.1:${server.address().port}`,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [status] = await once(child, "exit");
    return { status, stderr, output };
  };
  const good = await invoke("good");
  assert.equal(good.status, 0, good.stderr);
  const read = (file) => JSON.parse(readFileSync(join(good.output, file + ".json")));
  assert.equal(read("final-dependencies").status, "passed");
  assert.equal(read("hosted-budget").functional.status, "failed");
  assert.equal(read("hosted-budget").performance.status, "unknown");
  assert.equal(read("hosted-snapshot").jobs.at(-1).status, "queued");
  assert.equal(read("coverage").tests, "not-applicable");
  assert.equal((await invoke("missing", null)).status, 1);
  const invalid = structuredClone(needs);
  invalid.gates.result = "success";
  assert.equal((await invoke("wrong-scope", invalid)).status, 1);
  Object.assign(jobs[2], { status: "completed", conclusion: "failure" });
  assert.equal((await invoke("actual-failure")).status, 1);
});

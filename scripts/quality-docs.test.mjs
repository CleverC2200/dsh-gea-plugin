import test from "node:test";
import assert from "node:assert/strict";
import { createExecutionPlan } from "./quality-test-execution.mjs";
import { verifyDocsResults, docsHostedJobScope } from "./quality-docs.mjs";
import { readFileSync } from "node:fs";
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

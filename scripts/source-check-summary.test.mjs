import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createExecutionPlan,
  executionDigest,
  runExecutionPlan,
} from "./quality-test-execution.mjs";
import { summarizeSourceChecks, sourceReportMarkdown } from "./source-check-summary.mjs";
import { selectPlatformTests } from "./ci-platform-tests.mjs";

const identity = { head: "a".repeat(40), runId: "123", runAttempt: "1" };
const write = (file, value) => {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value) + "\n");
};
function fixture(t, { joint = true, parallel = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "source-summary-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "artifacts");
  const selection = {
    head: identity.head,
    repo: "dsh-gea-plugin",
    base: "b".repeat(40),
    diffBase: "b".repeat(40),
    joint,
    files: parallel
      ? ["cases/a.test.mjs", "cases/b.test.mjs"]
      : ["cases/a.test.mjs", "tests/host-config-keychain.test.mjs"],
    mode: "source-affected",
    fullSuite: "not-run",
    runtimeFiles: [],
  };
  mkdirSync(join(root, "cases"));
  for (const name of ["a", "b", "unselected"])
    writeFileSync(
      join(root, "cases", name + ".test.mjs"),
      `import test from 'node:test'; test('${name}', () => {});`,
    );
  write(join(root, "scripts/ci-test-policy.json"), { tests: ["cases/*.test.mjs"] });
  const plan = createExecutionPlan({
    selection,
    platformPlan: selectPlatformTests(selection, "linux"),
    binding: {
      ...identity,
      inputSha256: "b".repeat(64),
      platform: "linux",
      manifest: { repositories: [{ repo: "dsh-gea-plugin", head: identity.head }] },
    },
    shardCount: parallel && joint ? 2 : 1,
  });
  const artifacts = { output: { "lib/host.js": "c".repeat(64) } };
  const ids = joint && parallel ? ["1", "2"] : ["single"];
  for (const id of ids) {
    const worker = join(directory, "source-checks-" + id);
    const runtime = join(worker, "candidate/dsh-gea-plugin/.runtime");
    write(join(runtime, "source-checks-plan.json"), selection);
    write(join(runtime, "source-checks-result.json"), {
      schemaVersion: 1,
      ...identity,
      plan: selection,
      status: "passed",
    });
    if (joint) {
      write(join(worker, "quality-test-execution-plan.json"), plan);
      write(join(worker, "quality-stages.json"), {
        binding: {
          executionPlan: plan,
          manifest: plan.binding.manifest,
          inputSha256: plan.binding.inputSha256,
        },
        artifacts,
        stages: Object.fromEntries(
          ["prepare", "build", "checks", "tests"].map((name) => [
            name,
            { status: "passed", durationMs: 10 },
          ]),
        ),
      });
      if (parallel)
        write(join(worker, "source-checks-scope.json"), {
          schemaVersion: 1,
          ...identity,
          shard: { id, count: 2 },
          plan: selection,
        });
      runExecutionPlan({
        plan,
        root,
        ...(parallel ? { shardId: id } : {}),
        resultFile: join(worker, "quality-test-execution.json"),
        reporter: resolve("scripts/quality-test-reporter.mjs"),
        buildSha256: executionDigest(artifacts),
        environment: { NODE_TEST_CONTEXT: undefined },
      });
    }
  }
  return { root, directory, read: () => summarizeSourceChecks(directory, { ...identity, root }) };
}

test("parallel summary reuses strict actual Node receipts and keeps unselected coverage visible", (t) => {
  const f = fixture(t);
  const result = f.read();
  assert.equal(result.execution.status, "verified");
  assert.equal(result.execution.counts.tests, 2);
  assert.equal(result.execution.verifiedFiles, 2);
  assert.equal(result.scope.registeredFiles, 3);
  assert.deepEqual(result.scope.unselected, ["cases/unselected.test.mjs"]);
  assert.equal(result.scope.fullSuite, "not-run");
  assert.equal(result.scope.allRepositoryAndPlatforms, "not-established");
  assert.equal(result.slowFiles.length, 2);
  assert.equal(result.workers[0].stages.tests.durationMs, 10);
  rmSync(join(f.directory, "source-checks-2"), { recursive: true });
  assert.throws(f.read, /worker inventory/);
});

test("single joint summary verifies its receipt and separates deferred platform files", (t) => {
  const f = fixture(t, { parallel: false });
  const result = f.read();
  assert.equal(result.execution.counts.tests, 1);
  assert.equal(result.scope.selectedFiles, 2);
  assert.equal(result.scope.platformFiles, 1);
  assert.deepEqual(result.scope.deferred, ["tests/host-config-keychain.test.mjs"]);
  assert.equal(result.workers[0].name, "source-checks");
});

test("skipped cases and foreign runs cannot become verified coverage", (t) => {
  const f = fixture(t);
  const path = join(f.directory, "source-checks-2/quality-test-execution.json");
  const receipt = JSON.parse(readFileSync(path));
  receipt.results[0].report.files[0].counts.skipped = 1;
  write(path, receipt);
  const result = f.read();
  assert.notEqual(result.execution.status, "verified");
  assert.equal(result.execution.counts, null);
  assert.ok(result.execution.verificationError);
  assert.throws(
    () => summarizeSourceChecks(f.directory, { ...identity, runId: "456", root: f.root }),
    /worker result input/,
  );
});

test("lightweight checks report entry completion without inventing strict case counts", (t) => {
  const f = fixture(t, { joint: false, parallel: false });
  const result = f.read();
  assert.equal(result.execution.status, "entry-passed");
  assert.equal(result.execution.counts, null);
  assert.equal(result.execution.verifiedFiles, null);
  assert.equal(result.execution.entryPassedFiles, 1);
  rmSync(
    join(
      f.directory,
      "source-checks-single/candidate/dsh-gea-plugin/.runtime/source-checks-result.json",
    ),
  );
  assert.equal(f.read().execution.status, "not-observed");
});

test("human summary labels in-gate timing and unknown counts without claiming full acceptance", (t) => {
  const f = fixture(t, { joint: false, parallel: false });
  const text = sourceReportMarkdown({
    mode: "in-gate",
    completedMeasurement: false,
    functional: { status: "passed" },
    performance: {
      budgetMs: 600000,
      workflowToDecisionMs: 720000,
      triggerQueueMs: 0,
      jobs: [{ name: "source-checks", durationMs: 1000, measurement: "completed" }],
    },
    coverage: f.read(),
  });
  assert.match(text, /completed workflow: false/);
  assert.match(text, /fullSuite: not-run/);
  assert.match(text, /Cases: unknown/);
  assert.match(text, /historical 600000 ms reference is informational/);
  assert.match(text, /must not be summed/);
});

test("missing execution artifacts remain unknown in the human report", () => {
  const text = sourceReportMarkdown({
    mode: "in-gate",
    completedMeasurement: false,
    functional: { status: "failed" },
    performance: { budgetMs: 600000, jobs: [] },
    coverage: { status: "unknown", error: "worker inventory" },
  });
  assert.match(text, /Coverage: unknown/);
  assert.match(text, /Functional: failed/);
  assert.match(text, /Workflow to observation: unknown/);
});

test("single lightweight artifacts keep coverage after upload strips the common ancestor", (t) => {
  const f = fixture(t, { joint: false, parallel: false });
  const worker = join(f.directory, "source-checks-single");
  renameSync(join(worker, "candidate/dsh-gea-plugin/.runtime"), join(worker, ".runtime"));
  assert.equal(f.read().execution.status, "entry-passed");
  renameSync(
    join(worker, ".runtime/source-checks-plan.json"),
    join(worker, "source-checks-plan.json"),
  );
  renameSync(
    join(worker, ".runtime/source-checks-result.json"),
    join(worker, "source-checks-result.json"),
  );
  assert.equal(f.read().scope.platformFiles, 1);
});

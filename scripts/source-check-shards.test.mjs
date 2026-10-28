import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import {
  createExecutionPlan,
  executionDigest,
  runExecutionPlan,
} from "./quality-test-execution.mjs";
import {
  aggregateSourceCheckShards,
  sourceCheckShard,
  sourceCheckMatrix,
  sourceCheckCost,
} from "./source-check-shards.mjs";

const head = "a".repeat(40);
const expected = { head, runId: "test-run", runAttempt: "1" };
const write = (file, value) => writeFileSync(file, JSON.stringify(value) + "\n");

test("source planning shows unknown costs and uses valid timings without changing coverage", (t) => {
  const root = mkdtempSync(join(tmpdir(), "source-cost-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selection = {
    joint: true,
    files: ["tests/a.test.mjs", "tests/b.test.mjs"],
    runtimeFiles: ["tests/a.test.mjs"],
  };
  const environment = {
    platform: "linux",
    node: "24.22.0",
    core: "a".repeat(40),
    fileConcurrency: 3,
  };
  const unknown = sourceCheckCost({ selection, root, environment });
  assert.equal(unknown.estimates.estimatedMs, null);
  assert.equal(unknown.estimates.unknownFiles, 2);
  assert.equal(unknown.estimates.profileFiles, 1);
  assert.equal(unknown.shards.length, 2);
  mkdirSync(join(root, "tests"));
  for (const file of selection.files) writeFileSync(join(root, file), file);
  const timings = {
    schemaVersion: 2,
    source: environment,
    files: selection.files.map((file, i) => ({
      file,
      durationMs: [900, 300][i],
      sha256: createHash("sha256").update(file).digest("hex"),
      fixtures: [],
    })),
  };
  const observed = sourceCheckCost({ selection, root, environment, timings });
  assert.equal(observed.estimates.knownFiles, 2);
  assert.equal(observed.estimates.estimatedMs, 900);
  assert.deepEqual(observed.selected, selection.files);
  writeFileSync(join(root, selection.files[0]), "changed");
  const changed = sourceCheckCost({ selection, root, environment, timings });
  assert.equal(changed.estimates.unknownFiles, 1);
  assert.equal(changed.estimates.estimatedMs, null);
});
function fixture(t, count = 2) {
  const parent = mkdtempSync(join(tmpdir(), "gea-source-shards-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, "results"),
    source = join(parent, "cases");
  mkdirSync(root);
  mkdirSync(source);
  const files =
    count === 2
      ? ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs"]
      : Array.from({ length: 17 }, (_, i) => `case-${i}.test.mjs`);
  for (const file of files)
    writeFileSync(
      join(source, file),
      `import test from 'node:test'; test(${JSON.stringify(file)},()=>{});`,
    );
  const plan = createExecutionPlan({
    selection: { files, required: files },
    platformPlan: { files },
    binding: {
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      platform: "linux",
      inputSha256: "b".repeat(64),
      manifest: { repositories: [{ repo: "dsh-gea-plugin", head }] },
    },
    shardCount: count,
  });
  const artifacts = { output: { "lib/host.js": "c".repeat(64) } };
  for (const id of Array.from({ length: count }, (_, i) => String(i + 1))) {
    const worker = join(root, "source-checks-" + id);
    mkdirSync(worker);
    write(join(worker, "source-checks-scope.json"), {
      schemaVersion: 1,
      head,
      runId: expected.runId,
      runAttempt: expected.runAttempt,
      shard: { id, count },
      plan: { joint: true, files, runtimeFiles: count > 2 ? files : [] },
    });
    write(join(worker, "quality-test-execution-plan.json"), plan);
    write(join(worker, "quality-stages.json"), {
      binding: {
        executionPlan: plan,
        manifest: plan.binding.manifest,
        inputSha256: plan.binding.inputSha256,
      },
      artifacts,
      stages: Object.fromEntries(
        ["prepare", "build", "checks", "tests"].map((name) => [name, { status: "passed" }]),
      ),
    });
    runExecutionPlan({
      plan,
      root: source,
      shardId: id,
      resultFile: join(worker, "quality-test-execution.json"),
      reporter: resolve("scripts/quality-test-reporter.mjs"),
      buildSha256: executionDigest(artifacts),
      environment: { NODE_TEST_CONTEXT: undefined },
    });
  }
  const change = (file, mutate) => {
    const path = join(root, "source-checks-2", file);
    const value = JSON.parse(readFileSync(path));
    mutate(value);
    write(path, value);
  };
  return { root, plan, change };
}

test("source workers bind a bounded shard count and reject malformed assignment", () => {
  assert.equal(sourceCheckShard({}), undefined);
  for (const count of [2, 8, 16])
    for (let id = 1; id <= count; id++)
      assert.deepEqual(
        sourceCheckShard({
          GEA_SOURCE_CHECK_SHARD: String(id),
          GEA_SOURCE_CHECK_SHARD_COUNT: String(count),
        }),
        { id: String(id), count },
      );
  for (const env of [
    { GEA_SOURCE_CHECK_SHARD: "1" },
    { GEA_SOURCE_CHECK_SHARD: "0", GEA_SOURCE_CHECK_SHARD_COUNT: "2" },
    { GEA_SOURCE_CHECK_SHARD: "3", GEA_SOURCE_CHECK_SHARD_COUNT: "2" },
    { GEA_SOURCE_CHECK_SHARD: "01", GEA_SOURCE_CHECK_SHARD_COUNT: "2" },
    { GEA_SOURCE_CHECK_SHARD: "1", GEA_SOURCE_CHECK_SHARD_COUNT: "17" },
  ])
    assert.throws(() => sourceCheckShard(env), /shard/);
});

test("large runtime selections expand within the shared account concurrency allowance", () => {
  const files = Array.from({ length: 209 }, (_, i) => `tests/fixture-${i}.test.mjs`);
  const matrix = sourceCheckMatrix({ joint: true, files, runtimeFiles: files.slice(0, 109) });
  assert.equal(matrix.shards.length, 16);
  assert.deepEqual(
    matrix.shards,
    Array.from({ length: 16 }, (_, i) => String(i + 1)),
  );
});

test("independent actual Node workers prove complete exact-once file and case coverage", (t) => {
  const f = fixture(t);
  assert.equal(aggregateSourceCheckShards(f.root, expected).files, 4);
});

test("three actual workers prove the expanded assignment without missing or duplicate cases", (t) => {
  const f = fixture(t, 3);
  assert.equal(aggregateSourceCheckShards(f.root, expected).files, 17);
  rmSync(join(f.root, "source-checks-3"), { recursive: true });
  assert.throws(() => aggregateSourceCheckShards(f.root, expected), /worker inventory/);
});

test("tools and single-file joint selections retain one complete worker", () => {
  for (const plan of [
    { joint: false, files: ["a", "b"] },
    { joint: true, files: ["a"] },
    { joint: true, files: [] },
    { joint: true, files: ["a", "tests/host-config-keychain.test.mjs"] },
  ])
    assert.deepEqual(sourceCheckMatrix(plan), { parallel: false, shards: ["single"] });
  assert.deepEqual(sourceCheckMatrix({ joint: true, files: ["a", "b"] }), {
    parallel: true,
    shards: ["1", "2"],
  });
  assert.throws(() => sourceCheckMatrix({}), /source plan/);
});

test("workflow preserves the reusable single job and requires independent receipts before its gate", () => {
  const { jobs } = parse(readFileSync(".github/workflows/source-quality.yml", "utf8"));
  const workers = jobs["source-checks"];
  assert.equal(
    workers.name,
    "${{ matrix.shard == 'single' && 'source-checks' || format('source-checks ({0})', matrix.shard) }}",
  );
  assert.equal(workers.strategy["fail-fast"], false);
  assert.equal(workers["timeout-minutes"], 60);
  const upload = workers.steps.find(
    (step) =>
      step.uses?.startsWith("actions/upload-artifact@") &&
      step.with.name.startsWith("source-checks-"),
  );
  assert.equal(upload.with.name, "source-checks-${{ matrix.shard }}");
  for (const receipt of [
    "source-checks-scope.json",
    "quality-stages.json",
    "quality-test-execution-plan.json",
    "quality-test-execution.json",
    "quality-test-results/",
  ])
    assert.ok(upload.with.path.split("\n").includes(receipt), receipt);
  const gate = jobs["candidate-quality"].steps;
  const aggregate = gate.findIndex((step) => step.run?.includes("--aggregate source-check-shards"));
  const final = gate.findIndex((step) => step.run?.includes("--phase final"));
  assert.ok(aggregate > 0 && aggregate < final);
  const performance = gate.findIndex((step) =>
    step.run?.includes("--source-report source-budget.json --mode in-gate"),
  );
  assert.ok(performance > final);
  assert.equal(
    gate[performance].if,
    "always() && (needs.source-plan.result != 'success' || needs.source-plan.outputs.validate != 'false')",
  );
  assert.equal(jobs["candidate-quality"].permissions.actions, "read");
  assert.ok(
    jobs["source-plan"].steps.some(
      (step) =>
        step.with?.name === "source-cost-${{ github.run_attempt }}" &&
        step.with.path.includes(".runtime/source-check-cost.json"),
    ),
  );
  assert.equal(
    gate[aggregate].if,
    "(needs.source-plan.result != 'success' || needs.source-plan.outputs.validate != 'false') && needs.source-plan.outputs.parallel == 'true' && needs.source-checks.result == 'success'",
  );
  assert.equal(gate[aggregate - 1].with.pattern, "source-checks-*");
});

for (const [name, file, mutate] of [
  [
    "moved source",
    "source-checks-scope.json",
    (x) => {
      x.head = "d".repeat(40);
    },
  ],
  [
    "duplicate assignment",
    "source-checks-scope.json",
    (x) => {
      x.shard.id = "1";
    },
  ],
  [
    "missing selection",
    "source-checks-scope.json",
    (x) => {
      x.plan = {};
    },
  ],
  [
    "different plan",
    "quality-test-execution-plan.json",
    (x) => {
      x.binding.runId = "another-run";
    },
  ],
  [
    "different build",
    "quality-stages.json",
    (x) => {
      x.artifacts.output["lib/host.js"] = "d".repeat(64);
    },
  ],
  [
    "failed check",
    "quality-stages.json",
    (x) => {
      x.stages.checks.status = "failed";
    },
  ],
  [
    "cancelled worker",
    "quality-test-execution.json",
    (x) => {
      x.status = "failed";
      x.error = "cancelled";
    },
  ],
  [
    "partial worker",
    "quality-test-execution.json",
    (x) => {
      x.terminal = false;
    },
  ],
  [
    "missing execution",
    "quality-test-execution.json",
    (x) => {
      x.results = [];
    },
  ],
  [
    "skipped test",
    "quality-test-execution.json",
    (x) => {
      x.results[0].report.files[0].counts.skipped = 1;
    },
  ],
])
  test("source aggregation rejects " + name, (t) => {
    const f = fixture(t);
    f.change(file, mutate);
    assert.throws(() => aggregateSourceCheckShards(f.root, expected));
  });

test("missing workers and another run or source cannot satisfy the source gate", (t) => {
  const f = fixture(t);
  assert.throws(
    () => aggregateSourceCheckShards(f.root, { ...expected, runId: "foreign" }),
    /worker source/,
  );
  assert.throws(
    () => aggregateSourceCheckShards(f.root, { ...expected, head: "f".repeat(40) }),
    /worker source/,
  );
  rmSync(join(f.root, "source-checks-2"), { recursive: true });
  assert.throws(() => aggregateSourceCheckShards(f.root, expected), /worker inventory/);
});

test("the public CLI rejects a source shard on other stages before preparation", () => {
  const child = spawnSync(
    process.execPath,
    ["scripts/run-quality-ci.mjs", "--source-only", "--stage", "plan"],
    {
      encoding: "utf8",
      env: { ...process.env, GEA_SOURCE_CHECK_SHARD: "1", GEA_SOURCE_CHECK_SHARD_COUNT: "2" },
    },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /SOURCE_CHECK_SHARDS_REJECTED/);
});

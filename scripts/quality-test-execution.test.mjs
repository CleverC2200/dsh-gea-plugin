import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createExecutionPlan,
  executionDigest,
  runExecutionPlan,
  verifyExecutionResults,
} from "./quality-test-execution.mjs";
import * as execution from "./quality-test-execution.mjs";
import { spawnSync } from "node:child_process";

test("explicit three- and four-file execution overlaps real Node files while the default remains two", (t) => {
  for (const concurrency of [undefined, 3, 4]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-node-capacity-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const limit = concurrency ?? 2,
      log = join(root, "events.jsonl");
    const files = ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs"];
    for (const file of files)
      writeFileSync(
        join(root, file),
        `
      import test from 'node:test';
      import {appendFileSync,readFileSync} from 'node:fs';
      const log=${JSON.stringify(log)};
      test(${JSON.stringify(file)}, {timeout:5000}, async () => {
        appendFileSync(log,JSON.stringify({event:'start',file:${JSON.stringify(file)}})+'\\n');
        while(readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse).filter(x=>x.event==='start').length<${limit})
          await new Promise(r=>setTimeout(r,10));
        await new Promise(r=>setTimeout(r,20));
        appendFileSync(log,JSON.stringify({event:'end',file:${JSON.stringify(file)}})+'\\n');
      });`,
      );
    const selection = { files, required: files };
    const plan = createExecutionPlan({
      selection,
      platformPlan: selection,
      binding: { platform: process.platform },
      concurrency,
    });
    assert.equal(plan.concurrency, limit);
    const result = runExecutionPlan({
      plan,
      root,
      resultFile: join(root, "result.json"),
      reporter: resolve("scripts/quality-test-reporter.mjs"),
      buildSha256: "a".repeat(64),
      environment: { NODE_TEST_CONTEXT: undefined },
    });
    assert.equal(result.status, "passed");
    assert.equal(result.receipt.capacity.concurrency, limit);
    assert.equal(
      verifyExecutionResults({ plan, receipt: result.receipt, buildSha256: "a".repeat(64) }).files,
      4,
    );
    let active = 0,
      peak = 0;
    for (const event of readFileSync(log, "utf8").trim().split("\n").map(JSON.parse)) {
      active += event.event === "start" ? 1 : -1;
      peak = Math.max(peak, active);
    }
    assert.equal(peak, limit);
    assert.equal(active, 0);
    assert.ok(
      result.receipt.results[0].report.files.every(
        (file) => file.startCount === 1 && file.completeCount === 1 && file.summaryCount === 1,
      ),
    );
  }
});

test("plans refuse every unsupported file concurrency instead of adapting it", () => {
  const selection = { files: ["a.test.mjs"] };
  for (const concurrency of [0, 1, 5, -1, 2.5, NaN, Infinity, "2", "3", "4", null])
    assert.throws(
      () => createExecutionPlan({ selection, platformPlan: selection, binding: {}, concurrency }),
      /QUALITY_TEST_CONCURRENCY_REQUIRED/,
    );
});

test("rehashing an unsupported concurrency cannot authorize another actual Node run", (t) => {
  const f = observedRun(t);
  const plan = { ...f.plan, concurrency: 5 };
  const { planSha256: _old, ...contents } = plan;
  plan.planSha256 = executionDigest(contents);
  assert.throws(
    () => runExecutionPlan({ ...f, plan, reporter: resolve("scripts/quality-test-reporter.mjs") }),
    /QUALITY_TEST_CONCURRENCY_REQUIRED/,
  );
});

test("plans balance measured dispatch order without dropping any required file", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g"].map((name) => name + ".test.mjs");
  const durations = [9, 8, 7, 5, 4, 3, 6];
  const selection = { files, required: [...files], runtimeFiles: [] };
  const plan = createExecutionPlan({
    selection,
    platformPlan: selection,
    binding: {},
    shardCount: 2,
    timings: {
      source: { kind: "worked-example" },
      files: files.map((file, i) => ({ file, durationMs: durations[i] })),
    },
  });
  assert.deepEqual(
    plan.shards.map((s) => s.files),
    [
      ["a.test.mjs", "g.test.mjs", "d.test.mjs"],
      ["b.test.mjs", "c.test.mjs", "e.test.mjs", "f.test.mjs"],
    ],
  );
  assert.deepEqual(
    plan.shards.map((s) => s.estimatedMs),
    [11, 11],
  );
  assert.deepEqual(plan.shards.flatMap((s) => s.files).sort(), files);
  assert.deepEqual(plan.required, files);
  assert.equal(plan.estimates.estimatedMs, 11);
});

test("three-slot measured dispatch preserves the complete set and deterministic plan hash", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g"].map((name) => name + ".test.mjs");
  const selection = { files, required: files };
  const args = {
    selection,
    platformPlan: selection,
    binding: {},
    shardCount: 2,
    concurrency: 3,
    timings: {
      source: { kind: "worked-example" },
      files: files.map((file, i) => ({ file, durationMs: [9, 8, 7, 5, 4, 3, 6][i] })),
    },
  };
  const plan = createExecutionPlan(args);
  assert.deepEqual(
    plan.shards.map((s) => s.files),
    [
      ["a.test.mjs", "d.test.mjs", "e.test.mjs", "f.test.mjs"],
      ["b.test.mjs", "c.test.mjs", "g.test.mjs"],
    ],
  );
  assert.deepEqual(
    plan.shards.map((s) => s.estimatedMs),
    [9, 8],
  );
  assert.deepEqual(plan.shards.flatMap((s) => s.files).sort(), files);
  assert.deepEqual(plan.required, files);
  assert.deepEqual(createExecutionPlan(args), plan);
  assert.notEqual(createExecutionPlan({ ...args, concurrency: 4 }).planSha256, plan.planSha256);
});

for (const concurrency of [3, 4])
  test(`${concurrency}-file capacity requires measured four CPUs and twelve GiB, while two adds no floor`, () => {
    const minimum = { availableParallelism: 4, totalMemoryBytes: 12884901888 };
    assert.deepEqual(execution.verifyExecutionCapacity({ concurrency, resources: minimum }), {
      status: "passed",
      concurrency,
      required: minimum,
      observed: minimum,
    });
    assert.deepEqual(execution.verifyExecutionCapacity({ concurrency: 2, resources: {} }), {
      status: "not-required",
      concurrency: 2,
    });
    for (const resources of [
      {},
      { availableParallelism: 4 },
      { totalMemoryBytes: 12884901888 },
      { ...minimum, availableParallelism: 3 },
      { ...minimum, totalMemoryBytes: 12884901887 },
      { ...minimum, availableParallelism: 4.5 },
      { ...minimum, totalMemoryBytes: Infinity },
    ])
      assert.throws(
        () => execution.verifyExecutionCapacity({ concurrency, resources }),
        (error) => {
          assert.equal(error.code, "QUALITY_TEST_CAPACITY_REQUIRED");
          assert.deepEqual(error.required, minimum);
          assert.ok(Object.hasOwn(error.observed, "availableParallelism"));
          assert.ok(Object.hasOwn(error.observed, "totalMemoryBytes"));
          return true;
        },
      );
  });

test("actual execution refuses insufficient local capacity before starting any Node test file", (t) => {
  for (const concurrency of [3, 4])
    for (const resources of [
      { availableParallelism: 3, totalMemoryBytes: 12884901888 },
      { availableParallelism: 4, totalMemoryBytes: 12884901887 },
      {},
    ]) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-capacity-refusal-")));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const marker = join(root, "node-started"),
        observed = join(root, "denied.json");
      writeFileSync(
        join(root, "a.test.mjs"),
        `import test from 'node:test';import{writeFileSync}from'node:fs';test('must not start',()=>writeFileSync(${JSON.stringify(marker)},'started'));`,
      );
      writeFileSync(
        join(root, "capacity.mjs"),
        `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';const r=${JSON.stringify(resources)};os.availableParallelism=()=>r.availableParallelism;os.totalmem=()=>r.totalMemoryBytes;syncBuiltinESMExports();`,
      );
      writeFileSync(
        join(root, "run.mjs"),
        `import{createExecutionPlan,runExecutionPlan}from${JSON.stringify(new URL("./quality-test-execution.mjs", import.meta.url).href)};import{writeFileSync}from'node:fs';const selection={files:['a.test.mjs']};const plan=createExecutionPlan({selection,platformPlan:selection,binding:{},concurrency:${concurrency}});try{runExecutionPlan({plan,root:${JSON.stringify(root)},resultFile:${JSON.stringify(join(root, "result.json"))},reporter:${JSON.stringify(resolve("scripts/quality-test-reporter.mjs"))},buildSha256:'a'.repeat(64)});process.exitCode=1;}catch(e){writeFileSync(${JSON.stringify(observed)},JSON.stringify({code:e.code,observed:e.observed,required:e.required}));}`,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", join(root, "capacity.mjs"), join(root, "run.mjs")],
        { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(JSON.parse(readFileSync(observed)).code, "QUALITY_TEST_CAPACITY_REQUIRED");
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(join(root, "result.json")), false);
    }
});

function poolBudgetRun(
  t,
  { fileCount = 3, concurrency = 3, cpus = 4, expected = "1", shardCount = 1, shardId } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-libuv-budget-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = Array.from({ length: fileCount }, (_, i) => `${i}.test.mjs`);
  for (const file of files)
    writeFileSync(
      join(root, file),
      `import test from 'node:test';import assert from 'node:assert/strict';test('declared child environment',()=>assert.equal(process.env.UV_THREADPOOL_SIZE,${JSON.stringify(typeof expected === "string" ? expected : expected[file])}));`,
    );
  writeFileSync(join(root, "child.env"), "UV_THREADPOOL_SIZE=77\n");
  writeFileSync(
    join(root, "capacity.mjs"),
    `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';os.availableParallelism=()=>${cpus};os.totalmem=()=>12884901888;syncBuiltinESMExports();`,
  );
  writeFileSync(
    join(root, "run.mjs"),
    `import{createExecutionPlan,runExecutionPlan}from${JSON.stringify(new URL("./quality-test-execution.mjs", import.meta.url).href)};
const selection={files:${JSON.stringify(files)},required:${JSON.stringify(files)}};
const plan=createExecutionPlan({selection,platformPlan:selection,binding:{},concurrency:${concurrency},shardCount:${shardCount}});
runExecutionPlan({plan,root:${JSON.stringify(root)},resultFile:${JSON.stringify(join(root, "result.json"))},reporter:${JSON.stringify(resolve("scripts/quality-test-reporter.mjs"))},buildSha256:'a'.repeat(64),shardId:${JSON.stringify(shardId)},environment:{NODE_TEST_CONTEXT:undefined,UV_THREADPOOL_SIZE:'88'},nodeArgs:['--env-file='+${JSON.stringify(join(root, "child.env"))}]});`,
  );
  const child = spawnSync(
    process.execPath,
    ["--import", join(root, "capacity.mjs"), join(root, "run.mjs")],
    {
      encoding: "utf8",
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, UV_THREADPOOL_SIZE: "99" },
    },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const receipt = JSON.parse(readFileSync(join(root, "result.json")));
  const selection = { files, required: files };
  const plan = createExecutionPlan({
    selection,
    platformPlan: selection,
    binding: {},
    concurrency,
    shardCount,
  });
  return { plan, receipt, buildSha256: "a".repeat(64) };
}

test("three-file execution owns its declared libuv budget over inherited and caller environment", (t) => {
  const result = poolBudgetRun(t);
  assert.equal(result.receipt.status, "passed");
  assert.deepEqual(result.receipt.results[0].libuvPool, {
    status: "declared",
    size: 1,
    activeFiles: 3,
    availableParallelism: 4,
    source: "capacity.observed.availableParallelism",
  });
  assert.equal(verifyExecutionResults(result).status, "passed");
});

test("three-file receipts reject missing or changed libuv declarations and capacity evidence", (t) => {
  const result = poolBudgetRun(t);
  for (const change of [
    (r) => delete r.results[0].libuvPool,
    (r) => (r.results[0].libuvPool.size = 4),
    (r) => (r.results[0].libuvPool.activeFiles = 1),
    (r) => (r.results[0].libuvPool.availableParallelism = 12),
    (r) => (r.results[0].libuvPool.source = "environment"),
    (r) => delete r.results[0].capacity,
    (r) => (r.results[0].capacity.status = "not-required"),
    (r) => (r.results[0].capacity.observed.availableParallelism = 3),
    (r) => (r.results[0].capacity.observed.totalMemoryBytes = 1),
  ]) {
    const receipt = structuredClone(result.receipt);
    change(receipt);
    assert.throws(
      () => verifyExecutionResults({ ...result, receipt }),
      /QUALITY_TEST_(?:EXECUTION_REJECTED|CAPACITY_REQUIRED)/,
    );
  }
});

test("three-file lane budgets retain singleton capacity and scale from the observed CPU count", (t) => {
  for (const [fileCount, cpus, size, activeFiles] of [
    [1, 4, 4, 1],
    [2, 4, 2, 2],
    [4, 4, 1, 3],
    [3, 6, 2, 3],
    [2, 7, 3, 2],
    [3, 16, 4, 3],
  ]) {
    const result = poolBudgetRun(t, { fileCount, cpus, expected: String(size) });
    assert.deepEqual(result.receipt.results[0].libuvPool, {
      status: "declared",
      size,
      activeFiles,
      availableParallelism: cpus,
      source: "capacity.observed.availableParallelism",
    });
    assert.equal(verifyExecutionResults(result).status, "passed");
  }
});

test("libuv budgets use each actual shard and single-shard receipts cannot prove the full plan", (t) => {
  const args = {
    shardCount: 2,
    expected: { "0.test.mjs": "2", "1.test.mjs": "4", "2.test.mjs": "2" },
  };
  const result = poolBudgetRun(t, args);
  assert.deepEqual(
    result.receipt.results.map(({ shardId, libuvPool }) => [shardId, libuvPool.size]),
    [
      ["1", 2],
      ["2", 4],
    ],
  );
  assert.equal(verifyExecutionResults(result).files, 3);
  // The existing hosted aggregator retains worker results, not each parent receipt's capacity.
  const aggregate = {
    schemaVersion: 1,
    scope: "platform",
    status: "passed",
    terminal: true,
    executionId: "aggregate:" + result.plan.planSha256,
    planSha256: result.plan.planSha256,
    buildSha256: result.buildSha256,
    results: result.receipt.results,
  };
  assert.equal(verifyExecutionResults({ ...result, receipt: aggregate }).files, 3);
  const partial = poolBudgetRun(t, { ...args, shardId: "2", cpus: 16 });
  assert.equal(partial.receipt.status, "passed");
  assert.equal(partial.receipt.results.length, 1);
  assert.equal(partial.receipt.results[0].libuvPool.size, 4);
  assert.throws(() => verifyExecutionResults(partial), /QUALITY_TEST_EXECUTION_REJECTED/);
  const mixedCapacity = {
    ...aggregate,
    results: [result.receipt.results[0], partial.receipt.results[0]],
  };
  assert.deepEqual(
    mixedCapacity.results.map((entry) => entry.capacity.observed.availableParallelism),
    [4, 16],
  );
  assert.equal(verifyExecutionResults({ ...result, receipt: mixedCapacity }).files, 3);
});

test("two- and four-file plans retain the caller's existing libuv environment protocol", (t) => {
  for (const concurrency of [2, 4]) {
    const result = poolBudgetRun(t, { concurrency, expected: "88" });
    assert.equal(Object.hasOwn(result.receipt.results[0], "libuvPool"), false);
    assert.equal(Object.hasOwn(result.receipt.results[0], "capacity"), false);
    assert.equal(verifyExecutionResults(result).status, "passed");
  }
});

test("public plan validation rejects changed hash and coverage before a caller prepares execution", () => {
  const selection = { files: ["a.test.mjs"] };
  const plan = createExecutionPlan({
    selection,
    platformPlan: selection,
    binding: {},
    concurrency: 4,
  });
  assert.equal(execution.verifyExecutionPlan(plan), undefined);
  assert.throws(
    () => execution.verifyExecutionPlan({ ...plan, planSha256: "0".repeat(64) }),
    /QUALITY_TEST_EXECUTION_REJECTED/,
  );
  const bad = { ...plan, shards: [] };
  const { planSha256: _old, ...contents } = bad;
  bad.planSha256 = executionDigest(contents);
  assert.throws(() => execution.verifyExecutionPlan(bad), /QUALITY_TEST_EXECUTION_REJECTED/);
});

test("four-slot routing keeps unknown costs null and uses conservative weights without losing files", () => {
  const files = ["a", "b", "c", "d", "e", "f", "z"].map((n) => n + ".test.mjs");
  const selection = { files, required: files };
  const args = {
    selection,
    platformPlan: selection,
    binding: {},
    shardCount: 2,
    concurrency: 4,
    timings: { source: { kind: "worked-example" }, files: [{ file: "z.test.mjs", durationMs: 9 }] },
  };
  const plan = createExecutionPlan(args);
  assert.deepEqual(
    plan.shards.map((s) => s.files),
    [
      ["a.test.mjs", "c.test.mjs", "d.test.mjs", "e.test.mjs"],
      ["b.test.mjs", "f.test.mjs", "z.test.mjs"],
    ],
  );
  assert.deepEqual(
    plan.shards.map((s) => s.estimatedMs),
    [null, null],
  );
  assert.equal(plan.estimates.estimatedMs, null);
  assert.equal(plan.estimates.unknownFiles, 6);
  assert.deepEqual(plan.shards.flatMap((s) => s.files).sort(), files);
  assert.deepEqual(createExecutionPlan(args), plan);
});

test("four-file Node cancellation drains cleanup and preserves failed exact-once evidence", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-four-cancel-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "cleanup.jsonl"),
    files = ["a", "b", "c", "d"].map((n) => n + ".test.mjs");
  for (const file of files)
    writeFileSync(
      join(root, file),
      `
    import test from 'node:test';import{appendFileSync,readFileSync}from'node:fs';
    import{setTimeout as delay}from'node:timers/promises';const log=${JSON.stringify(log)};
    test(${JSON.stringify(file)},{timeout:1000},async t=>{
      t.after(()=>appendFileSync(log,JSON.stringify({event:'cleanup',file:${JSON.stringify(file)}})+'\\n'));
      appendFileSync(log,JSON.stringify({event:'start',file:${JSON.stringify(file)}})+'\\n');
      while(readFileSync(log,'utf8').trim().split('\\n').map(JSON.parse).filter(x=>x.event==='start').length<4)await delay(5);
      await delay(${file === "a.test.mjs" ? 5000 : 20},undefined,{signal:t.signal});
    });`,
    );
  const selection = { files, required: files };
  const plan = createExecutionPlan({
    selection,
    platformPlan: selection,
    binding: {},
    concurrency: 4,
  });
  const resultFile = join(root, "result.json");
  assert.throws(
    () =>
      runExecutionPlan({
        plan,
        root,
        resultFile,
        reporter: resolve("scripts/quality-test-reporter.mjs"),
        buildSha256: "a".repeat(64),
        environment: { NODE_TEST_CONTEXT: undefined },
      }),
    /QUALITY_TEST_EXECUTION_REJECTED/,
  );
  const record = JSON.parse(readFileSync(resultFile));
  assert.equal(record.status, "failed");
  assert.equal(record.results[0].report.summary.counts.cancelled, 1);
  assert.equal(record.results[0].report.files.length, 4);
  assert.deepEqual(
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse)
      .filter((x) => x.event === "cleanup")
      .map((x) => x.file)
      .sort(),
    files,
  );
});

function observedRun(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-execution-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = "fixture.test.mjs";
  writeFileSync(
    join(root, file),
    `import test from 'node:test'; test('same', async t => { await t.test('same', () => {}); await t.test('same', () => {}); });`,
  );
  const selection = { files: [file], required: [file], runtimeFiles: [] };
  const plan = createExecutionPlan({
    selection,
    platformPlan: { ...selection, platformTasks: [] },
    binding: {
      inputSha256: "a".repeat(64),
      runAttempt: "1",
      core: "b".repeat(40),
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    },
  });
  const buildSha256 = executionDigest({ artifact: "fixed fixture bytes" });
  const resultFile = join(root, "result.json");
  runExecutionPlan({
    plan,
    root,
    resultFile,
    reporter: resolve("scripts/quality-test-reporter.mjs"),
    buildSha256,
    environment: { NODE_TEST_CONTEXT: undefined },
  });
  return { root, plan, buildSha256, resultFile, receipt: JSON.parse(readFileSync(resultFile)) };
}

test("actual Node execution starts the measured long file before alphabetically earlier files", (t) => {
  const f = observedRun(t);
  const files = ["z-long.test.mjs", "a-short.test.mjs", "b-short.test.mjs"];
  for (const file of files)
    writeFileSync(
      join(f.root, file),
      `import test from 'node:test';test(${JSON.stringify(file)},()=>{});`,
    );
  const selection = { files, required: files, runtimeFiles: [] };
  const plan = createExecutionPlan({
    selection,
    platformPlan: selection,
    binding: f.plan.binding,
    concurrency: 2,
    timings: {
      source: { kind: "worked-example" },
      files: files.map((file, index) => ({ file, durationMs: index === 0 ? 1000 : 1 })),
    },
  });
  runExecutionPlan({
    ...f,
    plan,
    reporter: resolve("scripts/quality-test-reporter.mjs"),
    environment: { NODE_TEST_CONTEXT: undefined },
  });
  const receipt = JSON.parse(readFileSync(f.resultFile));
  assert.equal(receipt.results[0].report.files[0].file, files[0]);
  assert.deepEqual(
    receipt.results[0].report.files.map((file) => file.file).sort(),
    [...files].sort(),
  );
});

test("public execution verification rejects incomplete, duplicate, failed and stale actual Node receipts", (t) => {
  const f = observedRun(t);
  assert.equal(verifyExecutionResults(f).status, "passed");
  const invalid = [
    [
      "missing shard",
      (r) => {
        r.results = [];
      },
    ],
    ["duplicate shard", (r) => r.results.push(structuredClone(r.results[0]))],
    [
      "missing file",
      (r) => {
        r.results[0].report.files = [];
      },
    ],
    [
      "duplicate file",
      (r) => r.results[0].report.files.push(structuredClone(r.results[0].report.files[0])),
    ],
    [
      "extra file",
      (r) => {
        r.results[0].report.files[0].file = "extra.test.mjs";
      },
    ],
    [
      "duplicate start",
      (r) => {
        r.results[0].report.files[0].startCount = 2;
      },
    ],
    [
      "missing complete",
      (r) => {
        r.results[0].report.files[0].completeCount = 0;
      },
    ],
    [
      "failed file",
      (r) => {
        r.results[0].report.files[0].passed = false;
      },
    ],
    [
      "skip",
      (r) => {
        r.results[0].report.files[0].counts.skipped = 1;
      },
    ],
    [
      "todo",
      (r) => {
        r.results[0].report.files[0].counts.todo = 1;
      },
    ],
    [
      "cancelled",
      (r) => {
        r.results[0].report.files[0].counts.cancelled = 1;
      },
    ],
    [
      "failed child",
      (r) => {
        r.results[0].exitCode = 1;
      },
    ],
    [
      "signal",
      (r) => {
        r.results[0].signal = "SIGTERM";
      },
    ],
    [
      "partial reporter",
      (r) => {
        r.results[0].report.terminal = false;
      },
    ],
    [
      "partial parent",
      (r) => {
        r.terminal = false;
      },
    ],
    [
      "old plan",
      (r) => {
        r.planSha256 = "c".repeat(64);
      },
    ],
    [
      "old reporter input",
      (r) => {
        r.results[0].report.context.planSha256 = "c".repeat(64);
      },
    ],
    [
      "old build",
      (r) => {
        r.buildSha256 = "d".repeat(64);
      },
    ],
    [
      "invalid observed duration",
      (r) => {
        r.results[0].report.durationMs = -1;
      },
    ],
  ];
  for (const [name, mutate] of invalid) {
    const receipt = structuredClone(f.receipt);
    mutate(receipt);
    assert.throws(
      () => verifyExecutionResults({ ...f, receipt }),
      /QUALITY_TEST_EXECUTION_REJECTED/,
      name,
    );
  }
});

test("a fresh actual child cannot reuse an earlier reporter receipt from the same plan", (t) => {
  const f = observedRun(t);
  assert.throws(
    () =>
      runExecutionPlan({ ...f, reporter: "spec", environment: { NODE_TEST_CONTEXT: undefined } }),
    /QUALITY_TEST_EXECUTION_REJECTED/,
  );
  const record = JSON.parse(readFileSync(f.resultFile));
  assert.equal(record.status, "failed");
  assert.equal(record.results[0].exitCode, 0);
});

test("an empty platform assignment never starts Node discovery", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gea-execution-empty-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "unexpected-discovery");
  writeFileSync(
    join(root, "stray.test.mjs"),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'discovered');`,
  );
  const selection = { files: ["kernel.test.mjs"], required: ["kernel.test.mjs"] };
  const plan = createExecutionPlan({
    selection,
    platformPlan: { files: [], platformTasks: [{ platform: "darwin", files: selection.files }] },
    binding: { platform: "linux" },
  });
  const result = runExecutionPlan({
    plan,
    root,
    resultFile: join(root, "result.json"),
    reporter: resolve("scripts/quality-test-reporter.mjs"),
    buildSha256: "a".repeat(64),
  });
  assert.deepEqual(plan.shards, []);
  assert.equal(result.execution, "not-applicable");
  assert.equal(existsSync(marker), false);
});

test("single-shard execution proves only its actual nonempty slice while full verification still rejects missing shards", (t) => {
  const f = observedRun(t);
  const marker = join(f.root, "second-executed");
  writeFileSync(
    join(f.root, "second.test.mjs"),
    `import test from 'node:test'; import {writeFileSync} from 'node:fs'; test('second', () => {writeFileSync(${JSON.stringify(marker)}, 'executed');});`,
  );
  const selection = {
    files: ["fixture.test.mjs", "second.test.mjs"],
    required: ["fixture.test.mjs"],
  };
  const plan = createExecutionPlan({
    selection,
    platformPlan: { ...selection, platformTasks: [] },
    binding: f.plan.binding,
    shardCount: 2,
  });
  const result = runExecutionPlan({
    ...f,
    plan,
    shardId: "1",
    reporter: resolve("scripts/quality-test-reporter.mjs"),
    environment: { NODE_TEST_CONTEXT: undefined },
  });
  const receipt = JSON.parse(readFileSync(f.resultFile));
  assert.equal(receipt.results.length, 1);
  assert.equal(receipt.results[0].shardId, "1");
  assert.equal(result.receipt.status, "passed");
  assert.equal(existsSync(marker), false);
  assert.throws(
    () => verifyExecutionResults({ plan, receipt, buildSha256: f.buildSha256 }),
    /QUALITY_TEST_EXECUTION_REJECTED/,
  );
  assert.throws(
    () =>
      runExecutionPlan({
        ...f,
        plan,
        shardId: "missing",
        reporter: resolve("scripts/quality-test-reporter.mjs"),
      }),
    /QUALITY_TEST_EXECUTION_REJECTED/,
  );
  const second = runExecutionPlan({
    ...f,
    plan,
    shardId: "2",
    reporter: resolve("scripts/quality-test-reporter.mjs"),
    environment: { NODE_TEST_CONTEXT: undefined },
  });
  const combined = {
    ...receipt,
    scope: "platform",
    results: [...receipt.results, ...second.receipt.results],
  };
  assert.equal(
    verifyExecutionResults({ plan, receipt: combined, buildSha256: f.buildSha256 }).files,
    2,
  );
  assert.equal(existsSync(marker), true);
});

test("reporter fixture subprocesses remain isolated when their public test file is selected", (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "gea-reporter-nested-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const selection = { files: ["scripts/quality-test-reporter.test.mjs"], required: [] };
  const plan = createExecutionPlan({
    selection,
    platformPlan: { ...selection, platformTasks: [] },
    binding: { platform: process.platform },
  });
  const result = runExecutionPlan({
    plan,
    root: process.cwd(),
    resultFile: join(directory, "result.json"),
    reporter: resolve("scripts/quality-test-reporter.mjs"),
    buildSha256: "a".repeat(64),
    environment: { NODE_TEST_CONTEXT: undefined },
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(
    result.receipt.results[0].report.files.map((file) => file.file),
    selection.files,
  );
});

test("actual failing, skipped, todo, cancelled and signalled Node children retain failed execution evidence", async (t) => {
  for (const [name, body] of [
    [
      "failed",
      `import test from 'node:test'; test('failed', () => {throw Error('actual failure');});`,
    ],
    ["skipped", `import test from 'node:test'; test('skip', {skip:true}, () => {});`],
    ["todo", `import test from 'node:test'; test.todo('todo');`],
    [
      "cancelled",
      `import test from 'node:test'; test('cancelled', {timeout:10}, async () => {await new Promise(r=>setTimeout(r,40));});`,
    ],
    [
      "signal",
      `setTimeout(() => process.kill(process.ppid, 'SIGKILL'), 30); setTimeout(() => process.exit(0), 100);`,
    ],
    [
      "terminated",
      `setTimeout(() => process.kill(process.ppid, 'SIGTERM'), 30); setTimeout(() => process.exit(0), 500);`,
    ],
  ])
    await t.test(name, (t) => {
      const f = observedRun(t);
      writeFileSync(join(f.root, "fixture.test.mjs"), body);
      assert.throws(
        () =>
          runExecutionPlan({
            ...f,
            reporter: resolve("scripts/quality-test-reporter.mjs"),
            environment: { NODE_TEST_CONTEXT: undefined },
          }),
        /QUALITY_TEST_EXECUTION_REJECTED/,
      );
      const receipt = JSON.parse(readFileSync(f.resultFile));
      assert.equal(receipt.status, "failed");
      if (name === "signal") assert.equal(receipt.results[0].signal, "SIGKILL");
      if (name === "terminated") assert.equal(receipt.results[0].exitCode, 143);
      if (name === "todo") assert.equal(receipt.results[0].report.files[0].counts.todo, 1);
      if (name === "skipped") assert.equal(receipt.results[0].report.files[0].counts.skipped, 1);
    });
});

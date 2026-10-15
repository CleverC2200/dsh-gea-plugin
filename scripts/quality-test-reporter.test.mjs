import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
test("the public test reporter rejects an exit-zero skipped lane and keeps executed fixtures green", () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-"));
  try {
    const fixture = join(root, "fixture.mjs");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = () =>
      spawnSync(
        process.execPath,
        ["--test", "--test-reporter=./scripts/quality-test-reporter.mjs", fixture],
        { encoding: "utf8", env },
      );
    writeFileSync(
      fixture,
      'import test from "node:test"; test("required fixture", {skip: true}, () => {});',
    );
    const skipped = run();
    assert.equal(skipped.status, 1);
    assert.match(skipped.stderr, /QUALITY_REQUIRED_TEST_SKIPPED/);
    writeFileSync(fixture, 'import test from "node:test"; test("executed fixture", () => {});');
    assert.equal(run().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failure details appear before the following fixture completes", () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-detail-"));
  try {
    const fixture = join(root, "fixture.mjs");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    writeFileSync(
      fixture,
      'import test from "node:test"; test("failure fixture", () => { throw Error("FIXTURE_FAILURE_DETAIL"); }); test("later marker", async () => { await new Promise(resolve => setTimeout(resolve, 50)); });',
    );
    const result = spawnSync(
      process.execPath,
      ["--test", "--test-reporter=./scripts/quality-test-reporter.mjs", fixture],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 1);
    const detail = result.stdout.indexOf("FIXTURE_FAILURE_DETAIL");
    const later = result.stdout.indexOf("✔ later marker");
    assert.ok(detail >= 0 && later >= 0 && detail < later, result.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runLive(
  files,
  onOutput = () => {},
  reporter = "./scripts/quality-test-reporter.mjs",
) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=2", `--test-reporter=${reporter}`, ...files],
    { env },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    onOutput(stdout, child);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000);
  const result = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  }).finally(() => clearTimeout(watchdog));
  return result;
}

test("a fast file reports completion before the earlier slow file and keeps spec output", async () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-live-"));
  try {
    const slow = join(root, "a-slow.mjs");
    const fast = join(root, "b-fast.mjs");
    writeFileSync(
      slow,
      'import test from "node:test"; test("slow fixture", async () => { await new Promise(resolve => setTimeout(resolve, 700)); });',
    );
    writeFileSync(fast, 'import test from "node:test"; test("fast fixture", () => {});');
    let fastWasLive = false;
    const result = await runLive([slow, fast], (output) => {
      if (output.includes(`file complete ${fast}`) && !output.includes("✔ slow fixture"))
        fastWasLive = true;
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(fastWasLive, result.stdout);
    assert.match(result.stdout, /files=2\/2/);
    assert.match(result.stdout, /✔ fast fixture/);
    assert.match(result.stdout, /\[quality-progress\] summary .*elapsed=\d+ms/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file counts ignore imported, nested, concurrent and same-name cases", async () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-counts-"));
  try {
    const imported = join(root, "imported.mjs");
    const first = join(root, "first.mjs");
    const second = join(root, "second.mjs");
    writeFileSync(
      imported,
      'import test from "node:test"; test("same", {concurrency: true}, async t => { await Promise.all([1,2].map(() => t.test("same", async () => { await new Promise(r => setTimeout(r, 10)); }))); });',
    );
    writeFileSync(first, 'import "./imported.mjs";');
    writeFileSync(second, 'import "./imported.mjs";');
    const result = await runLive([first, second]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      (result.stdout.match(/\[quality-progress\] file start /g) ?? []).length,
      2,
      result.stdout,
    );
    assert.equal(
      (result.stdout.match(/\[quality-progress\] file complete /g) ?? []).length,
      2,
      result.stdout,
    );
    assert.match(result.stdout, /summary files=2\/2/);
    assert.doesNotMatch(result.stdout, /\[quality-progress\] file (start|complete) .*imported.mjs/);
    assert.match(result.stdout, /ℹ tests 6/);
    assert.match(result.stdout, /summary files=2\/2 .*running=none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bounded heartbeat shows current cases and elapsed time without delaying exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-heartbeat-"));
  try {
    const fixture = join(root, "slow.mjs");
    writeFileSync(
      fixture,
      'import test from "node:test"; test("current slow case", async () => { await new Promise(r => setTimeout(r, 5400)); });',
    );
    let live = false;
    const start = performance.now();
    const result = await runLive([fixture], (output) => {
      if (/heartbeat .*current slow case/.test(output) && !output.includes("✔ current slow case"))
        live = true;
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(live, result.stdout);
    assert.match(
      result.stdout,
      /heartbeat files=0\/1 elapsed=\d+ms running=.*slow.mjs.*current slow case/,
    );
    assert.equal(
      (result.stdout.match(/\[quality-progress\] heartbeat /g) ?? []).length,
      1,
      result.stdout,
    );
    assert.ok(performance.now() - start < 8000, "heartbeat held the child open");
    assert.match(result.stdout, /summary files=1\/1.*running=none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cancelled cases retain Node's failure exit and summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-cancel-"));
  try {
    const fixture = join(root, "cancelled.mjs");
    writeFileSync(
      fixture,
      'import test from "node:test"; test("cancelled fixture", {timeout: 50}, async () => { await new Promise(r => setTimeout(r, 150)); });',
    );
    const result = await runLive([fixture]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const baseline = spawnSync(process.execPath, ["--test", "--test-reporter=spec", fixture], {
      encoding: "utf8",
      env,
      timeout: 3000,
    });
    assert.equal(baseline.status, 1, baseline.stderr);
    assert.equal(result.status, baseline.status, result.stderr);
    assert.match(result.stdout, /test timed out after 50ms/);
    assert.match(result.stdout, /ℹ cancelled 1/);
    assert.match(result.stdout, /file complete .*result=failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminating the runner releases the heartbeat without a completion summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-signal-"));
  try {
    const fixture = join(root, "interrupted.mjs");
    writeFileSync(
      fixture,
      'import test from "node:test"; test("interrupted fixture", async () => { console.log("RUNNING_MARKER"); await new Promise(r => setTimeout(r, 500)); });',
    );
    let signalled = false;
    const start = performance.now();
    const result = await runLive([fixture], (output, child) => {
      if (!signalled && output.includes("RUNNING_MARKER")) {
        signalled = true;
        child.kill("SIGTERM");
      }
    });
    let baselineSignalled = false;
    const baseline = await runLive(
      [fixture],
      (output, child) => {
        if (!baselineSignalled && output.includes("RUNNING_MARKER")) {
          baselineSignalled = true;
          child.kill("SIGTERM");
        }
      },
      "spec",
    );
    assert.ok(signalled && baselineSignalled);
    assert.deepEqual([result.status, result.signal], [baseline.status, baseline.signal]);
    assert.notEqual(result.status, 0, result.stderr);
    assert.ok(performance.now() - start < 2500, "terminated runner stayed open");
    assert.doesNotMatch(result.stdout, /\[quality-progress\] summary/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovered files report an unknown plan until the real file total is known", async () => {
  const root = mkdtempSync(join(tmpdir(), "gea-test-report-discovery-"));
  try {
    for (const name of ["first", "second"])
      writeFileSync(
        join(root, `${name}.test.mjs`),
        'import test from "node:test"; test("case", () => {});',
      );
    const result = await runLive([join(root, "*.test.mjs")]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /file start .*files=0\/\?/);
    assert.match(result.stdout, /summary files=2\/2 .*running=none/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

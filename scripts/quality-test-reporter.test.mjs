import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { currentTestTimings } from "./quality-test-timings.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("costs invalidate changed tests, changed or deleted fixtures, and incompatible environments", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gea-timing-inputs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "tests/fixtures"), { recursive: true });
  const write = (file, content) => writeFileSync(join(root, file), content);
  write("tests/one.test.mjs", "one");
  write("tests/two.browser.mjs", "two");
  write("tests/fixtures/profile.mjs", "fixture");
  const environment = {
    platform: "linux",
    node: "24.21.0",
    core: "a".repeat(40),
    fileConcurrency: 3,
  };
  const timings = {
    schemaVersion: 2,
    source: { ...environment, kind: "historical-reference-only" },
    fixtures: { "tests/fixtures/profile.mjs": hash("fixture") },
    files: [
      { file: "tests/one.test.mjs", durationMs: 10, sha256: hash("one"), fixtures: [] },
      {
        file: "tests/two.browser.mjs",
        durationMs: 20,
        sha256: hash("two"),
        fixtures: ["tests/fixtures/profile.mjs"],
      },
    ],
  };
  const read = (value = timings, env = environment) =>
    currentTestTimings({ timings: value, root, environment: env });
  assert.equal(read().files.length, 2);
  write("tests/two.browser.mjs", "changed");
  assert.deepEqual(read().source.invalidated, [
    { file: "tests/two.browser.mjs", reason: "file-changed-or-missing" },
  ]);
  write("tests/two.browser.mjs", "two");
  write("tests/fixtures/profile.mjs", "changed");
  assert.deepEqual(read().source.invalidated, [
    { file: "tests/two.browser.mjs", reason: "fixture-changed-or-missing" },
  ]);
  rmSync(join(root, "tests/fixtures/profile.mjs"));
  assert.equal(read().files.length, 1);
  rmSync(join(root, "tests/one.test.mjs"));
  assert.equal(read().files.length, 0);
  for (const key of Object.keys(environment)) {
    const result = read(timings, { ...environment, [key]: "changed" });
    assert.ok(result.source.invalidated.every((entry) => entry.reason === "environment-changed"));
  }
  assert.ok(
    read({ ...timings, schemaVersion: undefined }).source.invalidated.every(
      (entry) => entry.reason === "unbound-source",
    ),
  );
  for (const files of [
    [timings.files[0], timings.files[0]],
    [{ file: "tests/../escape", durationMs: 1 }],
  ])
    assert.throws(() => read({ ...timings, files }), /QUALITY_TEST_TIMING_INVALID/);
});

test("committed historical data has distinct existing source paths and explicit measurement provenance", () => {
  const timings = JSON.parse(readFileSync(new URL("./quality-test-timings.json", import.meta.url)));
  assert.equal(timings.schemaVersion, 2);
  assert.equal(timings.source.kind, "historical-reference-only");
  assert.equal(timings.source.acceptance, "not-acceptance");
  assert.ok(Number.isSafeInteger(timings.source.runId) && timings.source.runId > 0);
  assert.match(timings.source.head, /^[a-f0-9]{40}$/);
  assert.ok(timings.source.artifacts.length > 0);
  assert.equal(new Set(timings.files.map((entry) => entry.file)).size, timings.files.length);
  const original = (file) =>
    hash(
      execFileSync("git", ["show", timings.source.head + ":" + file], {
        cwd: resolve(import.meta.dirname, ".."),
      }),
    );
  for (const [file, sha256] of Object.entries(timings.fixtures))
    assert.equal(sha256, original(file), file + " must bind the measured fixture bytes");
  for (const entry of timings.files) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      entry.sha256,
      original(entry.file),
      entry.file + " must bind the measured test bytes",
    );
    assert.ok(readFileSync(resolve(import.meta.dirname, "..", entry.file)).length > 0);
    assert.ok(entry.fixtures.every((file) => /^[a-f0-9]{64}$/.test(timings.fixtures[file])));
  }
});

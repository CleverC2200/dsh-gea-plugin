import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

test("the public full-phase selection and contracts run every original full-suite file exactly once", () => {
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  const command = spawnSync(process.execPath, ["scripts/run-quality-full.mjs", "--list"], {
    encoding: "utf8",
  });
  assert.equal(command.status, 0, command.stderr);
  const full = JSON.parse(command.stdout);
  const contracts = scripts["test:contracts"].match(/\b(?:tests|scripts)\/[\w.-]+\.test\.mjs\b/g);
  assert.equal(new Set([...full, ...contracts]).size, full.length + contracts.length);
  for (const file of readdirSync("tests")
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => "tests/" + name))
    assert.equal([...full, ...contracts].filter((item) => item === file).length, 1, file);
  assert.ok(full.includes("scripts/gea-error.test.mjs"));
  for (const file of [
    "delivery-check",
    "delivery-integrity",
    "delivery-readiness",
    "delivery-runtime",
    "delivery-continuation",
  ])
    assert.ok(contracts.includes(`scripts/${file}.test.mjs`));
  assert.doesNotMatch(
    readFileSync("scripts/run-quality-fast.mjs", "utf8"),
    /"test:fixture-inputs"|"test:prompt-execution"|"test:profile-window"/,
  );
  assert.equal(
    scripts.test,
    "node --test --test-concurrency=1 --test-reporter=./scripts/quality-test-reporter.mjs tests/*.test.mjs scripts/gea-error.test.mjs",
  );
});

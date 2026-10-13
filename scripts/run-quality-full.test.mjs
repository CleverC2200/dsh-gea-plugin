import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("the public contract command rejects a conditionally skipped required fixture after full-phase deduplication", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gea-contract-lane-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests"));
  for (const file of ["quality-test-reporter.mjs", "run-quality-full.mjs"])
    copyFileSync(join("scripts", file), join(root, "scripts", file));
  const contracts = scripts["test:contracts"].match(/\b(?:tests|scripts)\/[\w.-]+\.test\.mjs\b/g);
  for (const file of [...contracts, "tests/full-only.test.mjs", "scripts/gea-error.test.mjs"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(
      join(root, file),
      file === "tests/controlled-execution.test.mjs"
        ? 'import test from "node:test"; test("required contract fixture", { skip: process.env.GEA_CONTRACT_FIXTURE === "skip" }, () => { if (process.env.GEA_CONTRACT_FIXTURE === "fail") throw Error("CONTRACT_FIXTURE_FAILURE"); });'
        : `import test from "node:test"; test(${JSON.stringify(file)}, () => {});`,
    );
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = (lane, condition) =>
    spawnSync(process.execPath, ["--run", lane], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, GEA_CONTRACT_FIXTURE: condition },
    });
  const skipped = run("test:contracts", "skip");
  assert.equal(skipped.status, 1, skipped.stdout + skipped.stderr);
  assert.match(skipped.stderr, /QUALITY_REQUIRED_TEST_SKIPPED/);
  const full = run("test:ci-full", "skip");
  assert.equal(full.status, 0, full.stdout + full.stderr);
  assert.doesNotMatch(full.stdout, /required contract fixture/);
  const executed = run("test:contracts", "execute");
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  assert.match(executed.stdout, /required contract fixture/);
  const failed = run("test:contracts", "fail");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /CONTRACT_FIXTURE_FAILURE/);
});

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

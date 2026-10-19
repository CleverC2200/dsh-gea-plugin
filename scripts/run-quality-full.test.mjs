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

test("the manual contracts and complete source suite reject skipped required fixtures", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gea-contract-lane-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "tests"));
  for (const file of [
    "quality-test-reporter.mjs",
    "quality-test-execution.mjs",
    "run-quality-full.mjs",
  ])
    copyFileSync(join("scripts", file), join(root, "scripts", file));
  const contracts = [
    ...scripts["test:contracts"].match(/\b(?:tests|scripts)\/[\w.-]+\.test\.mjs\b/g),
    ...scripts["test:plugin-updates"].match(/\b(?:tests|scripts)\/[\w.-]+\.contract\.mjs\b/g),
  ];
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
  const full = run("test:full", "skip");
  assert.equal(full.status, 1, full.stdout + full.stderr);
  assert.match(full.stderr, /QUALITY_REQUIRED_TEST_SKIPPED/);
  const executed = run("test:contracts", "execute");
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  assert.match(executed.stdout, /required contract fixture/);
  const failed = run("test:contracts", "fail");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /CONTRACT_FIXTURE_FAILURE/);
});

test("the manual source suite includes contracts and browser files exactly once without parsing another command", () => {
  const command = spawnSync(process.execPath, ["scripts/run-quality-full.mjs", "--list"], {
    encoding: "utf8",
  });
  assert.equal(command.status, 0, command.stderr);
  const files = JSON.parse(command.stdout);
  const expected = readdirSync("tests")
    .filter((name) => /\.(?:test|contract|browser)\.mjs$/.test(name))
    .sort()
    .map((name) => "tests/" + name);
  assert.deepEqual(files, [...expected, "scripts/gea-error.test.mjs"]);
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.includes("tests/controlled-execution.test.mjs"));
  assert.ok(files.includes("tests/plugin-update-install.contract.mjs"));
  assert.ok(files.includes("tests/plugin-update-detail.browser.mjs"));
  const scripts = JSON.parse(readFileSync("package.json")).scripts;
  assert.equal(scripts["test:ci-full"], undefined);
  assert.equal(typeof scripts["test:full"], "string");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { runQualityChecks } from "./run-quality-checks.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("the fast CLI runs source checks before SDK-dependent checks and retains skipped results", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gea-fast-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = join(root, "commands.mjs");
  writeFileSync(
    preload,
    `import commands from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
commands.spawnSync = (command, args) => {
  appendFileSync(process.env.CHECK_LOG, JSON.stringify(args)+'\\n');
  return {status: args.includes(process.env.FAIL_CHECK) ? 1 : 0};
};
syncBuiltinESMExports();
`,
  );
  const run = (args, fail) => {
    const log = join(root, "commands-" + args.length + ".jsonl");
    const child = spawnSync(
      process.execPath,
      ["--import", preload, resolve("scripts/run-quality-fast.mjs"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CHECK_LOG: log, FAIL_CHECK: fail ?? "" },
      },
    );
    return {
      child,
      commands: readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
      checks: JSON.parse(readFileSync(join(root, ".runtime/quality-fast.json"))),
    };
  };
  const failed = run([], "format:check");
  assert.equal(failed.child.status, 1, failed.child.stderr);
  assert.deepEqual(
    failed.commands.map((args) => args[1]),
    [
      "lint",
      "format:check",
      "check:knowledge",
      "check:prompt-execution",
      "test:environment",
      "test:release-contract",
    ],
  );
  assert.deepEqual(
    failed.checks.slice(-2).map((entry) => entry.status),
    ["skipped", "skipped"],
  );
  const source = run(["--source-only", "scripts/example.mjs"]);
  assert.equal(source.child.status, 0, source.child.stderr);
  assert.deepEqual(source.commands[0], ["pnpm", "lint", "scripts/example.mjs"]);
  assert.deepEqual(source.commands[1], ["pnpm", "format:check", "scripts/example.mjs"]);
  assert.ok(source.checks.every((entry) => entry.status === "passed"));
  assert.equal(source.commands.length, 6);
});

test("a failed early gate preserves later behavioral observations and final failure", () => {
  const observed = [];
  const result = runQualityChecks([
    {
      name: "fast",
      execute() {
        observed.push("fast");
        throw Error("original debt");
      },
    },
    {
      name: "full",
      execute() {
        observed.push("full");
      },
    },
    {
      name: "browser",
      execute() {
        observed.push("browser");
        throw Error("cancelled");
      },
    },
  ]);
  assert.deepEqual(observed, ["fast", "full", "browser"]);
  assert.deepEqual(
    result.map((row) => row.status),
    ["failed", "passed", "failed"],
  );
  assert.ok(result.some((row) => row.status !== "passed"));
  assert.equal(result[0].error, "original debt");
  const missing = runQualityChecks([{ name: "absent" }]);
  assert.equal(missing[0].status, "failed");
});

test("the actual fast CLI reuses only complete successful checks bound to frozen input and source bytes", (t) => {
  const owned = mkdtempSync(join(tmpdir(), "gea-source-receipt-"));
  t.after(() => rmSync(owned, { recursive: true, force: true }));
  const root = join(owned, "source");
  mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args]);
  git("init", "-q");
  writeFileSync(join(root, ".gitignore"), ".runtime/\n");
  writeFileSync(join(root, "source.mjs"), "export {};\n");
  git("add", ".");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const preload = join(owned, "commands.mjs");
  writeFileSync(
    preload,
    `import commands from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
commands.spawnSync = (_command, args) => {
  appendFileSync(process.env.CHECK_LOG, JSON.stringify(args)+'\\n');
  return {status: args.includes(process.env.FAIL_CHECK) ? 1 : 0};
};
syncBuiltinESMExports();\n`,
  );
  mkdirSync(join(root, ".runtime"));
  const input = "a".repeat(64);
  const receipt = ".runtime/source.json";
  let serial = 0;
  const run = (args, { sha = input, fail = "" } = {}) => {
    const log = join(owned, `commands-${++serial}.jsonl`);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        preload,
        resolve("scripts/run-quality-fast.mjs"),
        ...args,
        "--input-sha256",
        sha,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CHECK_LOG: log, FAIL_CHECK: fail },
      },
    );
    return {
      ...child,
      commands: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [],
    };
  };
  const source = ["--source-only", "--checks-only", "--source-receipt-out", receipt];
  const reuse = ["--checks-only", "--source-receipt-in", receipt];
  const first = run(source);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.commands.length, 4);
  assert.ok(first.commands.every((args) => !args[1].startsWith("test:")));
  const repeated = run(reuse);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(repeated.commands, [["pnpm", "typecheck:official"]]);
  assert.ok(
    JSON.parse(readFileSync(join(root, ".runtime/quality-fast.json")))
      .slice(0, 4)
      .every((check) => check.evidence === "same-frozen-source-receipt"),
  );
  for (const outcome of [run(reuse, { sha: "b".repeat(64) }), run([...source, "source.mjs"])]) {
    assert.equal(outcome.status, 1);
    assert.equal(outcome.commands.length, 0);
  }
  writeFileSync(join(root, "source.mjs"), "export const changed = true;\n");
  assert.match(run(reuse).stderr, /QUALITY_SOURCE_RECEIPT_REJECTED/);
  writeFileSync(join(root, "source.mjs"), "export {};\n");
  assert.equal(run(source, { fail: "lint" }).status, 1);
  assert.match(run(reuse).stderr, /QUALITY_SOURCE_RECEIPT_REJECTED/);
  rmSync(join(root, receipt));
  assert.equal(run(reuse).status, 1);
});

test("the CI static receipt and mandatory environment and release fixtures have disjoint execution ownership", () => {
  const { scripts } = JSON.parse(readFileSync("package.json"));
  const policy = JSON.parse(readFileSync("scripts/ci-test-policy.json"));
  const files = ["test:environment", "test:release-contract"].flatMap((name) =>
    scripts[name].match(/(?:scripts|tests)\/[\w.-]+\.test\.mjs/g),
  );
  assert.deepEqual(files.sort(), [
    "scripts/runtime-environment.test.mjs",
    "tests/optional-companion-manifest.test.mjs",
    "tests/plugin-release.test.mjs",
  ]);
  for (const file of files)
    assert.equal(policy.required.filter((required) => required === file).length, 1);
  assert.match(
    readFileSync(".github/workflows/quality.yml", "utf8"),
    /quality:fast --source-only --checks-only --source-receipt-out/,
  );
});

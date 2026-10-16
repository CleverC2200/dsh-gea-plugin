import { test } from "node:test";
import assert from "node:assert/strict";
import { runQualityChecks } from "./run-quality-checks.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
    ["lint", "format:check", "check:knowledge", "check:prompt-execution"],
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
  assert.equal(source.commands.length, 4);
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

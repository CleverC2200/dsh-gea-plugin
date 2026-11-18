import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./benchmark-sales-plan.mjs", import.meta.url));

test("the sales plan benchmark describes its scenarios without a running client", () => {
  const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--scenario all\|first\|expired\|volume/);
});

test("the sales plan benchmark requires a restart command for a cold start", () => {
  const result = spawnSync(
    process.execPath,
    [script, "--scenario", "first", "--launch-log", "test.log", "--out", "test.json"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /--restart is required for first/);
});

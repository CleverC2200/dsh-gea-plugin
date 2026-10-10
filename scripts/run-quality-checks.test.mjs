import { test } from "node:test";
import assert from "node:assert/strict";
import { runQualityChecks } from "./run-quality-checks.mjs";
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

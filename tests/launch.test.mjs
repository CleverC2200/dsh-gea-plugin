import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("a missing deployment file fails before a profile or server is started", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/start.mjs", "--config", "/nonexistent/gea-deployment.json"],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GEA_CONFIG_FILE/);
  assert.doesNotMatch(result.stdout, /dsh web:/);
});

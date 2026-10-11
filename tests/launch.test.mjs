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
  assert.match(result.stderr, /WINDOW_DECLARATION_REQUIRED/);
  assert.doesNotMatch(result.stdout, /dsh web:/);
  const validation = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import {readDeployment} from './scripts/deployment.mjs'; try { await readDeployment('/nonexistent/gea-deployment.json', {resolveCredentials:false,credentialEnv:{}}); } catch(error) { console.error(error.message); process.exitCode=1; }",
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.notEqual(validation.status, 0);
  assert.match(validation.stderr, /GEA_CONFIG_FILE/);
  assert.doesNotMatch(validation.stdout, /dsh web:/);
});

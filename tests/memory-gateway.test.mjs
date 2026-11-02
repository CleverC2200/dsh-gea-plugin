import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("personal memory public HTTP contracts pass the Python gateway suite", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      "import unittest, sys; suite = unittest.defaultTestLoader.discover('tests'); assert suite.countTestCases() > 0, 'MEMORY_GATEWAY_TESTS_EMPTY'; sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())",
    ],
    { cwd: new URL("../gateway/", import.meta.url), encoding: "utf8", timeout: 120000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

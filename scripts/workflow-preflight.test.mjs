import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./workflow-preflight.mjs", import.meta.url));
test("workflow preflight propagates the validator failure before preparation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/quality.yml"), "name: fixture");
  const validator = join(root, "actionlint");
  writeFileSync(validator, "#!/bin/sh\necho runner context unavailable\nexit 1\n");
  chmodSync(validator, 0o755);
  const checked = spawnSync(process.execPath, [cli, ".github/workflows/quality.yml"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ACTIONLINT: validator },
  });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /WORKFLOW_PREFLIGHT_FAILED.*runner context unavailable/s);
});

test("workflow preflight explains the required tool while unrelated and deleted files need no tool", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-tool-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/quality.yml"), "name: fixture");
  const run = (files) =>
    spawnSync(process.execPath, [cli, ...files], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ACTIONLINT: join(root, "missing-actionlint") },
    });
  const missing = run([".github/workflows/quality.yml"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /WORKFLOW_PREFLIGHT_TOOL_REQUIRED.*actionlint 1\.7\.12.*ACTIONLINT/);
  const unrelated = run(["README.md", ".github/workflows/deleted.yml"]);
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.deepEqual(JSON.parse(unrelated.stdout), {
    purpose: "github-actions-semantics",
    tool: "actionlint",
    files: [],
    status: "not-applicable",
  });
});

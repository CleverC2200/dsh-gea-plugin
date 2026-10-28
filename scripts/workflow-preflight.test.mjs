import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkWorkflows } from "./workflow-preflight.mjs";

const cli = fileURLToPath(new URL("./workflow-preflight.mjs", import.meta.url));
test("source planning checks dependency-free CI contracts before selecting heavyweight workers", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/source-quality.yml", import.meta.url),
    "utf8",
  );
  const preparation = workflow.slice(0, workflow.indexOf("  dependency-policy:"));
  const fast = preparation.indexOf("      - name: Check fast CI contracts\n");
  assert.ok(fast > preparation.indexOf("      - name: Admit source input changes\n"));
  assert.ok(fast < preparation.indexOf("      - name: Classify actual Git changes\n"));
  const step = preparation.slice(fast).split(/\n      - /)[0];
  assert.doesNotMatch(step, /\n        if:|continue-on-error:|pnpm|npm install/);
  assert.match(
    step,
    /node --test --test-concurrency=3 scripts\/workflow-preflight\.test\.mjs scripts\/source-formal-receipt\.test\.mjs/,
  );
  assert.match(
    step,
    /node --test --test-name-pattern=.*a README-only.*title and body edits.*source workflow keeps.*candidate-quality accepts.* scripts\/source-quality\.test\.mjs/,
  );
});

const queueWorkflow =
  "name: fixture\non: push\nconcurrency:\n  group: fixture\n  queue: max\n  cancel-in-progress: false\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n";
const queueFixture = (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-queue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  const file = ".github/workflows/serial-merge.yml";
  const executable = join(root, "actionlint");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.log('1.7.12'); process.exit(0); }
const stdin = args.includes('-');
const file = stdin ? args[args.indexOf('-stdin-filename') + 1] : args.find(x => x.endsWith('.yml'));
const source = stdin ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
const row = source.split('\\n').findIndex(line => line === '  queue: max');
if (row >= 0) {
  console.log(JSON.stringify([{filepath: file, line: row + 1, column: 3, kind: 'syntax-check', message: 'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"'}]));
  process.exit(1);
}
if (source.includes('SECOND_NATIVE_FAILURE') || source.includes('OTHER_NATIVE_FAILURE')) {
  console.log('remaining native semantic error'); process.exit(1);
}
console.log('[]');
`,
  );
  chmodSync(executable, 0o755);
  return {
    root,
    file,
    executable,
    put: (source, name = file) => writeFileSync(join(root, name), source),
  };
};

test("workflow preflight accepts only the literal serial queue and preserves the source", (t) => {
  const fixture = queueFixture(t);
  for (const source of [
    queueWorkflow,
    queueWorkflow.replace("  cancel-in-progress: false\n", ""),
  ]) {
    fixture.put(source);
    const checked = checkWorkflows([fixture.file], fixture);
    assert.equal(checked.status, "passed");
    assert.deepEqual(checked.compatibility, {
      feature: "serial-workflow-concurrency-queue-max",
      files: [fixture.file],
      nativeOriginalExitCode: 1,
      derivedNativeExitCode: 0,
    });
    assert.equal(readFileSync(join(fixture.root, fixture.file), "utf8"), source);
  }
  const other = ".github/workflows/z-other.yml";
  fixture.put(queueWorkflow.replace(/concurrency:[\s\S]*?jobs:/, "jobs:"), other);
  assert.deepEqual(checkWorkflows([fixture.file, other], fixture).files, [fixture.file, other]);
});

test("workflow preflight still rejects unsafe or unsupported queue shapes", (t) => {
  const fixture = queueFixture(t);
  for (const source of [
    queueWorkflow.replace("  cancel-in-progress: false", "  cancel-in-progress: true"),
    queueWorkflow.replace("  cancel-in-progress: false", "  cancel-in-progress: ${{ false }}"),
    queueWorkflow.replace("  group: fixture\n", ""),
    queueWorkflow.replace("  group: fixture", "  group: fixture\n  group: duplicate"),
    queueWorkflow.replace("  cancel-in-progress: false", "  unknown: false"),
    queueWorkflow.replace("  queue: max", "  queue: max\n  queue: max"),
    queueWorkflow.replace(
      "  cancel-in-progress: false",
      "  cancel-in-progress: false\n  cancel-in-progress: false",
    ),
    queueWorkflow.replace("  group: fixture", "  group: |\n    fixture"),
    queueWorkflow.replace("concurrency:", "jobs:\n  nested:\n    concurrency:"),
  ]) {
    fixture.put(source);
    assert.throws(() => checkWorkflows([fixture.file], fixture), /WORKFLOW_PREFLIGHT_FAILED/);
  }
  const other = ".github/workflows/other.yml";
  fixture.put(queueWorkflow, other);
  assert.throws(() => checkWorkflows([other], fixture), /WORKFLOW_PREFLIGHT_FAILED/);
});

test("workflow preflight requires successful remaining native checks for the derived input and other files", (t) => {
  const fixture = queueFixture(t);
  fixture.put(queueWorkflow.replace("echo ok", "SECOND_NATIVE_FAILURE"));
  assert.throws(() => checkWorkflows([fixture.file], fixture), /remaining native semantic error/);
  fixture.put(queueWorkflow);
  const other = ".github/workflows/z-other.yml";
  fixture.put(
    queueWorkflow
      .replace(/concurrency:[\s\S]*?jobs:/, "jobs:")
      .replace("echo ok", "OTHER_NATIVE_FAILURE"),
    other,
  );
  assert.throws(
    () => checkWorkflows([fixture.file, other], fixture),
    /remaining native semantic error/,
  );
});

test("workflow preflight propagates the validator failure before preparation", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-preflight-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/quality.yml"), "name: fixture");
  const validator = join(root, "actionlint");
  writeFileSync(
    validator,
    "#!/bin/sh\ncase $1 in -version) echo 1.7.12; exit 0;; esac\necho runner context unavailable\nexit 1\n",
  );
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

test("workflow preflight rejects a different actionlint version before accepting its syntax result", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/quality.yml"), "name: fixture");
  const validator = join(root, "actionlint");
  writeFileSync(
    validator,
    "#!/bin/sh\ncase $1 in -version) echo 1.7.11; exit 0;; esac\necho unexpected-lint\nexit 9\n",
  );
  chmodSync(validator, 0o755);
  const checked = spawnSync(process.execPath, [cli, ".github/workflows/quality.yml"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ACTIONLINT: validator },
  });
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /WORKFLOW_PREFLIGHT_TOOL_VERSION.*1\.7\.12.*1\.7\.11/);
});

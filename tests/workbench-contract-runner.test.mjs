import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sourcePlugins } from "../scripts/source-composition.mjs";
import { runWorkbenchContracts } from "./fixtures/workbench-contract.mjs";

// This independent Git layout tests runner admission, not Workbench's HTML contracts.
async function fixture(t, body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gea-workbench-subrunner-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "sources");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--quiet");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  const inputs = [];
  for (const plugin of sourcePlugins) {
    const source = join(repository, plugin.repo);
    const dependencies = join(source, "node_modules");
    await mkdir(dependencies, { recursive: true });
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: plugin.name,
        version: "0.0.0",
        type: "module",
        exports: { ".": "./host.js", "./client": "./client.js" },
      }),
    );
    for (const file of ["host.js", "client.js", "cordis.patch.yml", ...plugin.digests]) {
      await mkdir(dirname(join(source, file)), { recursive: true });
      await writeFile(join(source, file), "");
    }
    inputs.push({ repo: plugin.repo, source, dependencies });
  }
  const owner = inputs.find((entry) => entry.repo === "dsh-agent-workbench");
  const files = body === undefined ? [] : ["tests/runner.test.mjs"];
  const witness = join(root, "executed.json");
  await mkdir(join(owner.source, "tests"));
  if (body === undefined) {
    await writeFile(join(owner.source, "tests/.gitkeep"), "");
  } else
    await writeFile(
      join(owner.source, files[0]),
      `import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const record = () => {
  assert.equal(process.cwd(), ${JSON.stringify(owner.source)});
  assert.equal(process.env.GEA_SUBRUNNER_WITNESS, ${JSON.stringify(witness)});
  writeFileSync(process.env.GEA_SUBRUNNER_WITNESS, JSON.stringify({pid: process.pid}));
};
${body}
`,
    );
  git("add", ".");
  git(
    "-c",
    "user.name=Runner Fixture",
    "-c",
    "user.email=runner@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "runner fixture",
  );
  const commit = git("rev-parse", "HEAD");
  const input = join(root, "inputs.json");
  await writeFile(input, JSON.stringify(inputs.map((entry) => ({ ...entry, commit }))));
  for (const [key, value] of Object.entries({
    GEA_TEST_SOURCE_INPUTS: input,
    GEA_SUBRUNNER_WITNESS: witness,
  })) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
  return { files, witness, commit, cwd: owner.source };
}

test("a frozen Workbench subrunner executes child tests within a parent Node test", async (t) => {
  const f = await fixture(t, "test('real child body', () => record());");
  const parentContext = process.env.NODE_TEST_CONTEXT;
  assert.equal(parentContext, "child-v8", "this regression must exercise Node's real test child");
  const receipt = await runWorkbenchContracts(f.files);
  assert.deepEqual(receipt, {
    commit: f.commit,
    cwd: f.cwd,
    files: f.files,
    tests: 1,
  });
  t.diagnostic(JSON.stringify(receipt));
  const { pid } = JSON.parse(await readFile(f.witness, "utf8"));
  assert.notEqual(pid, process.pid, "the accepted count comes from an executed child test body");
  assert.equal(process.env.NODE_TEST_CONTEXT, parentContext, "the parent environment stays intact");
});

for (const [outcome, body, summary] of [
  [
    "failure",
    "test('failing child', () => { record(); assert.fail('real child failure'); });",
    "fail 1",
  ],
  [
    "skipped",
    "record(); test.skip('skipped child', () => assert.fail('must not run'));",
    "skipped 1",
  ],
  [
    "cancelled",
    "test('cancelled child', {timeout: 10}, () => { record(); return new Promise(() => {}); });",
    "cancelled 1",
  ],
  ["todo", "record(); test.todo('unfinished child');", "todo 1"],
])
  test(`a frozen Workbench subrunner refuses actual child ${outcome}`, async (t) => {
    const f = await fixture(t, body);
    await assert.rejects(runWorkbenchContracts(f.files), (failure) => {
      assert.equal(failure.code, "ERR_ASSERTION");
      assert.ok(failure.message.includes(`# ${summary}\n`), failure.message);
      t.diagnostic(failure.message);
      return true;
    });
    const { pid } = JSON.parse(await readFile(f.witness, "utf8"));
    assert.notEqual(pid, process.pid, "rejection must follow actual child execution");
  });

test("a frozen Workbench subrunner refuses a discovery directory with zero child tests", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runWorkbenchContracts(f.files), (failure) => {
    assert.equal(failure.code, "ERR_ASSERTION");
    assert.match(failure.message, /^# tests 0$/m);
    t.diagnostic(failure.message);
    return true;
  });
  await assert.rejects(readFile(f.witness), { code: "ENOENT" });
});

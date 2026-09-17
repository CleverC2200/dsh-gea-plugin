import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  appendFile,
  readFile,
  readdir,
  rm,
  utimes,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runObserved, readRuns, rotate, KIND } from "./dev-observe.mjs";
import { report } from "./dev-observe-report.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "gea-observe-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("original exit, output, numeric metrics and privacy whitelist", async (t) => {
  const root = await fixture(t);
  const logs = join(root, "logs");
  const result = await runObserved({
    command: process.execPath,
    args: [
      "-e",
      "console.log('SECRET-terminal-only'); console.log('Progress: resolved 10, reused 7, downloaded 3, added 10'); process.exit(7)",
    ],
    cwd: root,
    task: "build",
    logDir: logs,
  });
  assert.equal(result.code, 7);
  const [{ start, end }] = await readRuns(logs);
  assert.equal(end.reported.reused, 7);
  assert.equal(end.reported.downloaded, 3);
  assert.equal(end.reported.cacheHit, null);
  assert.equal(end.exitCode, 7);
  assert.equal(
    start.sourceIdentityCoverage.includes("not content identity"),
    true,
  );
  const saved = await readFile(join(logs, (await readdir(logs))[0]), "utf8");
  assert.ok(!saved.includes("SECRET-terminal-only"));
  assert.ok(!saved.includes(root));
  assert.ok(!saved.includes("console.log"));
  assert.equal(Object.hasOwn(start, "env"), false);
  assert.equal(Object.hasOwn(start, "args"), false);
});
test("storage failure never changes command exit", async (t) => {
  const root = await fixture(t);
  const notDir = join(root, "file");
  await writeFile(notDir, "untouched");
  const result = await runObserved({
    command: process.execPath,
    args: ["-e", "process.exit(23)"],
    cwd: root,
    task: "test",
    logDir: notDir,
  });
  assert.equal(result.code, 23);
  assert.equal(await readFile(notDir, "utf8"), "untouched");
});
test("ENOSPC at start or end is fail-open and retains private file permissions", async (t) => {
  const root = await fixture(t);
  const full = async () => {
    throw Object.assign(new Error("simulated full disk"), { code: "ENOSPC" });
  };
  for (const failureAt of ["start", "end"]) {
    const logs = join(root, failureAt);
    const result = await runObserved({
      command: process.execPath,
      args: ["-e", "process.exit(19)"],
      cwd: root,
      task: "test",
      logDir: logs,
      storage: {
        writeFile: failureAt === "start" ? full : writeFile,
        appendFile: failureAt === "end" ? full : appendFile,
      },
    });
    assert.equal(result.code, 19);
    const runs = await readRuns(logs);
    if (failureAt === "end") {
      assert.equal(runs.length, 1);
      assert.equal(runs[0].end, null);
      assert.equal((await stat(runs[0].path)).mode & 0o777, 0o600);
    } else assert.equal(runs.length, 0);
  }
});
test("invalid records are ignored and command spawn failure remains visible", async (t) => {
  const root = await fixture(t);
  const logs = join(root, "logs");
  const result = await runObserved({
    command: join(root, "missing-command"),
    cwd: root,
    task: "test",
    logDir: logs,
  });
  assert.equal(result.code, 127);
  assert.equal(result.spawnFailed, true);
  await writeFile(join(logs, `run-${randomUUID()}.jsonl`), "null\n");
  await writeFile(join(logs, `run-${randomUUID()}.jsonl`), "{truncated");
  const summary = await report(logs);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.observations[0].reported.cacheHit, null);
});
test("parallel runs use separate valid files; explicit parent survives", async (t) => {
  const root = await fixture(t);
  const logs = join(root, "logs");
  const parent = randomUUID();
  await Promise.all(
    Array.from({ length: 6 }, () =>
      runObserved({
        command: process.execPath,
        args: ["-e", ""],
        cwd: root,
        task: "build",
        parentRunId: parent,
        logDir: logs,
      }),
    ),
  );
  const runs = await readRuns(logs);
  assert.equal(runs.length, 6);
  assert.equal(new Set(runs.map((r) => r.start.runId)).size, 6);
  assert.ok(
    runs.every((r) => r.end?.exitCode === 0 && r.start.parentRunId === parent),
  );
  const summary = await report(logs);
  assert.equal(summary.groups[0].samples, 6);
  assert.equal(summary.groups[0].repeatCandidate, true);
});
test("rotation removes only completed owned records and leaves unknown files, active records and symlinks", async (t) => {
  const root = await fixture(t);
  const logs = join(root, "logs");
  await runObserved({
    command: process.execPath,
    args: ["-e", ""],
    cwd: root,
    task: "build",
    logDir: logs,
  });
  const [completed] = await readRuns(logs);
  const old = new Date(Date.now() - 31 * 86400000);
  await utimes(completed.path, old, old);
  const activeId = randomUUID();
  const active = join(logs, `run-${activeId}.jsonl`);
  await writeFile(
    active,
    JSON.stringify({
      kind: KIND,
      schemaVersion: 1,
      runId: activeId,
      event: "start",
      project: "gea",
      task: "test",
    }) + "\n",
  );
  const other = join(logs, "keep.txt");
  await writeFile(other, "do not delete");
  const link = join(logs, `run-${randomUUID()}.jsonl`);
  await symlink(other, link);
  const result = await rotate(logs, { maxBytes: 0 });
  assert.equal(result.removed, 1);
  assert.equal(await readFile(other, "utf8"), "do not delete");
  assert.ok((await readdir(logs)).includes(active.split("/").at(-1)));
  assert.ok((await readdir(logs)).includes(link.split("/").at(-1)));
});
for (const signal of ["SIGTERM", "SIGINT"])
  test(
    `${signal} forwards to command and descendants, stores end event and preserves signal`,
    { timeout: 10000 },
    async (t) => {
      if (process.platform === "win32")
        return t.skip(
          "POSIX signal propagation; Windows needs separate runtime validation",
        );
      const root = await fixture(t);
      const logs = join(root, "logs");
      const ready = join(root, "ready");
      const moduleUrl = new URL("./dev-observe.mjs", import.meta.url).href;
      const grandchild = `require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
      const child = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
      const script = `import {runObserved} from ${JSON.stringify(moduleUrl)}; const r=await runObserved({command:process.execPath,args:['-e',${JSON.stringify(child)}],cwd:${JSON.stringify(root)},task:'test',logDir:${JSON.stringify(logs)}});if(r.signal)process.kill(process.pid,r.signal);else process.exitCode=r.code;`;
      const wrapper = spawn(
        process.execPath,
        ["--input-type=module", "-e", script],
        { stdio: "pipe" },
      );
      t.after(() => {
        if (wrapper.exitCode === null && wrapper.signalCode === null)
          wrapper.kill("SIGTERM");
      });
      const done = new Promise((resolve, reject) => {
        wrapper.on("error", reject);
        wrapper.on("close", (code, signal) => resolve({ code, signal }));
      });
      for (let i = 0; i < 100; i++) {
        if (await readFile(ready, "utf8").catch(() => false)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const descendant = Number(await readFile(ready, "utf8"));
      assert.ok(descendant > 0);
      wrapper.kill(signal);
      const result = await done;
      assert.equal(result.signal, signal);
      const [{ end }] = await readRuns(logs);
      assert.equal(end.cancelled, true);
      assert.equal(end.signal, signal);
      let alive = true;
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(descendant, 0);
        } catch {
          alive = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(alive, false, "grandchild must not survive cancellation");
    },
  );

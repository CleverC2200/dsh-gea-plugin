import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import cp from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finishDevelopmentOutputs, checkDevelopmentOutputs } from "./development-outputs.mjs";
import { developmentTask } from "./development-tasks.mjs";

function taskOutputsFixture(t) {
  const temporary = fs.mkdtempSync(join(os.tmpdir(), "development-finish-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const path = join(temporary, "dsh-agent-manage");
  fs.mkdirSync(path);
  fs.writeFileSync(
    join(path, "package.json"),
    JSON.stringify({
      name: "dsh-agent-manage",
      packageManager: "pnpm@1.0.0",
    }),
  );
  const original = cp.execFileSync;
  t.mock.method(cp, "execFileSync", (file, args, options) =>
    args.join(" ") === "pnpm --version" ? "1.0.0\n" : original(file, args, options),
  );
  const data = { path, root: temporary };
  const root = fs.realpathSync(data.root);
  const taskRoot = join(root, "task-output");
  fs.mkdirSync(taskRoot);
  const generated = join(taskRoot, "runtime");
  fs.mkdirSync(generated);
  fs.writeFileSync(join(generated, "build.js"), "rebuildable");
  const source = join(root, "input.json");
  fs.writeFileSync(source, '{"frozen":"fixture"}');
  const outputs = join(taskRoot, "outputs.json");
  const manifest = {
    schemaVersion: 1,
    task: "fixture-task",
    owner: "fixture-owner",
    roots: [taskRoot],
    items: [{ path: generated, kind: "generated", disposition: "retain" }],
  };
  const save = () => fs.writeFileSync(outputs, JSON.stringify(manifest));
  save();
  return {
    ...data,
    root,
    taskRoot,
    generated,
    source,
    outputs,
    manifest,
    save,
  };
}

test("finish requires a reason and recovery source before retaining generated task output", async (t) => {
  const { path, outputs, manifest, save, source, generated } = taskOutputsFixture(t);
  const pending = await developmentTask("finish", { outputs }, path);
  assert.equal(pending.outputDisposition.status, "needs-disposition");
  assert.ok(pending.outputDisposition.issues.some((issue) => issue.path === generated));
  manifest.items[0].reason = "Active fixture reader; retire when its acceptance ends";
  manifest.items[0].restoreFrom = [join(generated, "build.js")];
  save();
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "needs-disposition",
  );
  manifest.items[0].restoreFrom = [source];
  save();
  const complete = await developmentTask("finish", { outputs }, path);
  assert.equal(complete.outputDisposition.status, "disposition-complete");
  assert.equal(complete.outputDisposition.performsCleanup, false);
  assert.ok(complete.outputDisposition.items[0].allocatedBytes > 0);
  assert.ok(complete.outputDisposition.retainedAllocatedBytes > 0);
  assert.equal(fs.readFileSync(join(generated, "build.js"), "utf8"), "rebuildable");
});

test("finish reports undeclared task output and preserves declared final and original failure evidence", async (t) => {
  const { path, outputs, manifest, save, source, taskRoot } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    reason: "Current acceptance reader",
    restoreFrom: [source],
  });
  const archive = join(taskRoot, "client.dmg");
  const failure = join(taskRoot, "original-failure.json");
  fs.writeFileSync(archive, "final installer");
  fs.writeFileSync(failure, '{"exitCode":1}');
  save();
  const pending = await developmentTask("finish", { outputs }, path);
  assert.equal(pending.outputDisposition.status, "needs-disposition");
  assert.ok(pending.outputDisposition.issues.some((issue) => issue.path === archive));
  manifest.items.push(
    {
      path: archive,
      kind: "artifact",
      disposition: "retain",
      reason: "Final installer",
    },
    {
      path: failure,
      kind: "failure-evidence",
      disposition: "retain",
      reason: "Original failure",
    },
  );
  save();
  const result = await developmentTask("finish", { outputs }, path);
  assert.equal(result.outputDisposition.status, "disposition-complete");
  assert.equal(fs.readFileSync(archive, "utf8"), "final installer");
  assert.equal(fs.readFileSync(failure, "utf8"), '{"exitCode":1}');
});

test("finish requires the original cleanup receipt and actual absence for each removed generated path", async (t) => {
  const { path, root, outputs, manifest, save, source, generated } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    disposition: "remove",
    restoreFrom: [source],
  });
  save();
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "needs-disposition",
  );
  const cleanupReceipt = join(root, "cleanup.json");
  manifest.items[0].cleanupReceipt = cleanupReceipt;
  fs.writeFileSync(
    cleanupReceipt,
    JSON.stringify({
      items: [
        {
          path: join(root, "other"),
          removed: true,
          startedAt: "2026-10-26T15:00:00+08:00",
          completedAt: "2026-10-26T15:01:00+08:00",
        },
      ],
    }),
  );
  save();
  fs.rmSync(generated, { recursive: true });
  const wrongReceipt = await developmentTask("finish", { outputs }, path);
  assert.equal(wrongReceipt.outputDisposition.status, "needs-disposition");
  fs.writeFileSync(
    cleanupReceipt,
    JSON.stringify({
      items: [
        {
          path: generated,
          removed: true,
          startedAt: "2026-10-26T15:00:00+08:00",
          completedAt: "2026-10-26T15:01:00+08:00",
        },
      ],
    }),
  );
  fs.mkdirSync(generated);
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "needs-disposition",
  );
  fs.rmdirSync(generated);
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "disposition-complete",
  );
});

test("finish rejects paths outside the task root and links that escape from declared output", async (t) => {
  const { path, outputs, manifest, save, source, generated, taskRoot } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    reason: "Current acceptance reader",
    restoreFrom: [source],
  });
  manifest.items.push({
    path: source,
    kind: "source",
    disposition: "retain",
    reason: "Frozen source",
  });
  save();
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "needs-disposition",
  );
  manifest.items.pop();
  const link = join(generated, "external-input");
  fs.symlinkSync(source, link);
  save();
  const escape = await developmentTask("finish", { outputs }, path);
  assert.equal(escape.outputDisposition.status, "needs-disposition");
  assert.ok(escape.outputDisposition.issues.some((issue) => issue.path === link));
  fs.unlinkSync(link);
  manifest.items.push({
    path: join(taskRoot, "runtime", "build.js"),
    kind: "source",
    disposition: "retain",
    reason: "Overlaps runtime",
  });
  save();
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "needs-disposition",
  );
});

test("finish consumes original cleanup journals for exact retired roots without widening their parents", async (t) => {
  const { path, root, outputs, manifest, save, source } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    reason: "Active acceptance",
    restoreFrom: [source],
  });
  const retired = join(root, "old-task", "node_modules");
  const cleanupReceipt = join(root, "journal.json");
  fs.mkdirSync(join(root, "old-task"));
  fs.writeFileSync(join(root, "old-task", "user-state"), "protected original state");
  manifest.roots.push(retired);
  manifest.items.push({
    path: retired,
    kind: "generated",
    disposition: "remove",
    restoreFrom: [source],
    cleanupReceipt,
  });
  fs.writeFileSync(
    cleanupReceipt,
    JSON.stringify({
      items: [
        {
          path: retired,
          startedAt: "2026-10-26T15:00:00+08:00",
          removed: true,
          completedAt: "2026-10-26T15:01:00+08:00",
          allocatedBytes: 1024,
        },
      ],
    }),
  );
  save();
  const report = await developmentTask("finish", { outputs }, path);
  assert.equal(report.outputDisposition.status, "disposition-complete");
  assert.equal(
    fs.readFileSync(join(root, "old-task", "user-state"), "utf8"),
    "protected original state",
  );
});

test("finish cannot omit the manifest's task directory to hide other task output", async (t) => {
  const { path, outputs, manifest, save, source, generated, taskRoot } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    reason: "Active acceptance",
    restoreFrom: [source],
  });
  fs.writeFileSync(join(taskRoot, "unlisted.app"), "unlisted runtime");
  manifest.roots = [generated];
  save();
  assert.equal(
    (await developmentTask("finish", { outputs }, path)).outputDisposition.status,
    "needs-disposition",
  );
});

test("the finish CLI exits nonzero for pending output while report remains compatible", async (t) => {
  const { path, root, outputs, manifest, save, source } = taskOutputsFixture(t);
  const bin = join(root, "bin");
  fs.mkdirSync(bin);
  const shim = join(bin, process.platform === "win32" ? "corepack.cmd" : "corepack");
  fs.writeFileSync(
    shim,
    process.platform === "win32" ? "@echo 1.0.0\r\n" : "#!/bin/sh\nprintf '1.0.0\\n'\n",
    { mode: 0o755 },
  );
  const invoke = (action, args = ["--outputs", outputs]) =>
    cp.spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./development-tasks.mjs", import.meta.url)), action, ...args],
      {
        cwd: path,
        encoding: "utf8",
        env: { ...process.env, PATH: bin + delimiter + process.env.PATH },
      },
    );
  const pending = invoke("finish");
  assert.equal(pending.status, 1);
  assert.equal(JSON.parse(pending.stdout).outputDisposition.status, "needs-disposition");
  assert.equal(invoke("report").status, 0);
  Object.assign(manifest.items[0], {
    reason: "Active acceptance",
    restoreFrom: [source],
  });
  save();
  const complete = invoke("finish");
  assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).outputDisposition.status, "disposition-complete");
  assert.equal(JSON.parse(invoke("finish", []).stdout).status, "report-only");
});

function launcherFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "finish-launcher-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = (directory, files) => {
    fs.mkdirSync(directory, { recursive: true });
    for (const [file, bytes] of Object.entries(files)) {
      fs.mkdirSync(join(directory, file, ".."), { recursive: true });
      fs.writeFileSync(join(directory, file), bytes);
    }
    const git = (...args) =>
      cp.execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  const tools = join(root, "versioned-tools");
  const toolingHead = repository(
    tools,
    Object.fromEntries(
      ["plugin-split-development.mjs", "development-outputs.mjs"].map((file) => [
        "scripts/" + file,
        fs.readFileSync(new URL("./" + file, import.meta.url)),
      ]),
    ),
  );
  const names = {
    "dsh-agent-workbench": "@cleverc2200/dsh-agent-workbench",
    "dsh-agent-manage": "dsh-agent-manage",
    "dsh-gea-plugin": "@cleverc2200/gea-dsh-prototype",
  };
  const repositories = Object.entries(names).map(([repo, name]) => {
    const path = join(root, "candidate", "integration", repo);
    const files = { "package.json": JSON.stringify({ name }) };
    if (repo === "dsh-gea-plugin") {
      for (const tool of [
        "build-admission",
        "development-dependencies",
        "development-repositories",
        "pack-raw",
        "package-source-integrity",
      ])
        files[`scripts/${tool}.mjs`] = "export {};\n";
      files["scripts/development-tasks.mjs"] =
        'console.log(JSON.stringify({status:"report-only",cwd:process.cwd()}));\n';
    }
    return { repo, path, head: repository(path, files) };
  });
  const core = repository(join(root, "candidate", "official-latest-standard"), {
    "package.json": '{"name":"fixture-core"}',
  });
  const input = join(root, "input.json");
  fs.writeFileSync(input, JSON.stringify({ repositories, core }));
  const taskRoot = join(root, "task");
  fs.mkdirSync(taskRoot);
  const evidence = join(taskRoot, "original.json");
  fs.writeFileSync(evidence, '{"original":true}');
  const outputs = join(taskRoot, "outputs.json");
  fs.writeFileSync(
    outputs,
    JSON.stringify({
      schemaVersion: 1,
      task: "fixture",
      owner: "fixture-owner",
      roots: [taskRoot],
      items: [
        {
          path: evidence,
          kind: "failure-evidence",
          disposition: "retain",
          reason: "Original failure",
        },
      ],
    }),
  );
  const entry = join(root, "development.mjs");
  fs.symlinkSync(join(tools, "scripts/plugin-split-development.mjs"), entry);
  const invoke = (action, args = []) =>
    cp.spawnSync(process.execPath, [entry, action, "--input", input, ...args], {
      cwd: root,
      encoding: "utf8",
    });
  return { root, tools, toolingHead, input, outputs, repositories, invoke };
}

test("the project finish launcher uses frozen targets and committed tools while requiring task disposition", (t) => {
  const { tools, toolingHead, input, outputs, repositories, invoke } = launcherFixture(t);
  const before = fs.readFileSync(input, "utf8");
  const pending = invoke("finish");
  assert.equal(pending.status, 1);
  assert.equal(
    JSON.parse(pending.stdout.trim().split("\n").at(-1)).outputDisposition.status,
    "needs-disposition",
  );
  const complete = invoke("finish", ["--outputs", outputs]);
  assert.equal(complete.status, 0, complete.stderr);
  const records = complete.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.at(-1).outputDisposition.status, "disposition-complete");
  assert.equal(records.at(-1).toolSource.head, toolingHead);
  assert.equal(records[2].cwd, repositories[2].path);
  assert.equal(fs.readFileSync(input, "utf8"), before);
  assert.equal(invoke("report").status, 0);
  fs.appendFileSync(join(tools, "scripts/development-outputs.mjs"), "\n");
  const dirty = invoke("finish", ["--outputs", outputs]);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /DEVELOPMENT_TOOL_SOURCE_MISMATCH/);
});

test("automatic finish removes declared idle generated output, records it and is idempotent", (t) => {
  const { outputs, manifest, save, source, generated } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    disposition: "cleanup",
    restoreFrom: [source],
  });
  save();
  assert.equal(checkDevelopmentOutputs(outputs).status, "needs-disposition");
  assert.equal(fs.existsSync(generated), true);
  const finished = finishDevelopmentOutputs(outputs);
  assert.equal(
    finished.status,
    "disposition-complete",
    JSON.stringify(finished.issues),
  );
  assert.equal(finished.performsCleanup, true);
  assert.equal(fs.existsSync(generated), false);
  assert.equal(
    finishDevelopmentOutputs(outputs).status,
    "disposition-complete",
  );
  assert.equal(fs.readFileSync(source, "utf8"), '{"frozen":"fixture"}');
});

test("automatic finish preserves an open file", (t) => {
  const { outputs, manifest, save, source, generated } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    disposition: "cleanup",
    restoreFrom: [source],
  });
  save();
  const child = cp.spawn(
    process.execPath,
    [
      "-e",
      "require('fs').openSync(process.argv[1], 'r');setInterval(()=>{},1000)",
      join(generated, "build.js"),
    ],
    { stdio: "ignore" },
  );
  t.after(() => child.kill());
  const result = finishDevelopmentOutputs(outputs);
  assert.equal(result.status, "needs-disposition");
  assert.ok(
    result.issues.some((issue) => /ACTIVE/.test(issue.reason)),
    JSON.stringify(result.issues),
  );
  assert.equal(fs.existsSync(generated), true);
});

test("automatic finish protects source repositories, recovery dependencies and current inputs", (t) => {
  const { outputs, manifest, save, source, generated } = taskOutputsFixture(t);
  Object.assign(manifest.items[0], {
    disposition: "cleanup",
    restoreFrom: [source],
  });
  save();
  assert.ok(
    finishDevelopmentOutputs(outputs, [generated]).issues.some(
      (issue) => issue.reason === "OUTPUT_CURRENT_INPUT",
    ),
  );
  fs.mkdirSync(join(generated, ".git"));
  assert.ok(
    finishDevelopmentOutputs(outputs).issues.some(
      (issue) => issue.reason === "OUTPUT_SOURCE_OR_USER_STATE",
    ),
  );
  assert.equal(fs.existsSync(generated), true);
});

test("automatic finish preserves a recovery source scheduled by another item and an external dependency link", (t) => {
  const { root, outputs, manifest, save, source, generated } =
    taskOutputsFixture(t);
  const input = join(generated, "build.js");
  const sibling = join(root, "reader");
  fs.mkdirSync(sibling);
  fs.symlinkSync(generated, join(sibling, "dependency"));
  Object.assign(manifest.items[0], {
    disposition: "cleanup",
    restoreFrom: [source],
  });
  save();
  assert.ok(
    finishDevelopmentOutputs(outputs, [], [sibling]).issues.some(
      (issue) => issue.reason === "OUTPUT_DEPENDENCY_READER",
    ),
  );
  fs.unlinkSync(join(sibling, "dependency"));
  const artifact = join(manifest.roots[0], "other-build");
  fs.mkdirSync(artifact);
  manifest.items.push({
    path: artifact,
    kind: "generated",
    disposition: "retain",
    reason: "Reader",
    restoreFrom: [input],
  });
  save();
  assert.ok(
    finishDevelopmentOutputs(outputs).issues.some(
      (issue) => issue.reason === "OUTPUT_RECOVERY_DEPENDENCY",
    ),
  );
  assert.equal(fs.existsSync(input), true);
});

test("the project launcher performs automatic cleanup through its committed owner tool", (t) => {
  const { root, outputs, invoke } = launcherFixture(t);
  const manifest = JSON.parse(fs.readFileSync(outputs, "utf8"));
  const path = join(root, "task", "generated");
  fs.mkdirSync(path);
  fs.writeFileSync(join(path, "build.js"), "generated output");
  manifest.items.push({
    path,
    kind: "generated",
    disposition: "cleanup",
    restoreFrom: [join(root, "input.json")],
  });
  fs.writeFileSync(outputs, JSON.stringify(manifest));
  const result = invoke("finish", ["--outputs", outputs]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(fs.existsSync(path), false);
  assert.equal(
    JSON.parse(result.stdout.trim().split("\n").at(-1)).outputDisposition
      .performsCleanup,
    true,
  );
});

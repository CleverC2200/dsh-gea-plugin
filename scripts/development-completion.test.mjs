import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import cp from "node:child_process";
import { join } from "node:path";
import {
  bindTaskPullRequest,
  finishMergedTask,
  registeredTaskOutputs,
  completionWatchPlan,
  completionWatchRequest,
} from "./development-completion.mjs";
import { finishDevelopmentOutputs } from "./development-outputs.mjs";

function fixture(t) {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "merged-finish-")));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const root = join(projectRoot, ".scratch", "task");
  fs.mkdirSync(root, { recursive: true });
  const screenshot = join(root, "acceptance.png");
  const logs = join(root, "process");
  fs.writeFileSync(screenshot, "fixture screenshot");
  fs.mkdirSync(logs);
  fs.writeFileSync(join(logs, "test.log"), "fixture test output");
  const file = join(root, "outputs.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      task: "fixture",
      owner: "fixture",
      roots: [root],
      items: [
        { path: screenshot, kind: "acceptance-evidence", disposition: "cleanup" },
        { path: logs, kind: "process-evidence", disposition: "cleanup" },
      ],
    }),
  );
  const binding = { repository: "CleverC2200/dsh-agent-manage", number: 1, head: "1".repeat(40) };
  const pull = {
    number: 1,
    base: { ref: "main", repo: { full_name: binding.repository } },
    head: { sha: binding.head, repo: { full_name: binding.repository } },
    body: "Important result and actual acceptance boundaries are saved in this PR.",
    merged: false,
  };
  const readPullRequest = async (request) => ({ ...structuredClone(pull), number: request.number });
  const options = {
    file,
    projectRoot,
    readPullRequest,
    ownerThreadId: "fixture-owner",
    activity: {
      complete: true,
      observedAt: new Date().toISOString(),
      protectedPaths: [],
      threads: [],
    },
  };
  const merge = () =>
    Object.assign(pull, {
      merged: true,
      merged_at: new Date().toISOString(),
      merge_commit_sha: "2".repeat(40),
    });
  return { ...options, options, binding, pull, screenshot, logs, root, merge };
}

test("only a merged, frozen PR with its saved summary retires task acceptance and process files", async (t) => {
  const x = fixture(t);
  assert.equal((await finishMergedTask(x.options)).status, "unregistered");
  await bindTaskPullRequest({ ...x.options, binding: x.binding });
  assert.equal(finishDevelopmentOutputs(x.file).status, "needs-disposition");
  assert.equal((await finishMergedTask(x.options)).status, "waiting-for-merge");
  assert.equal(fs.existsSync(x.screenshot), true);
  x.merge();
  assert.equal((await finishMergedTask(x.options)).status, "finished");
  assert.equal(fs.existsSync(x.screenshot), false);
  assert.equal(fs.existsSync(x.logs), false);
  assert.equal(fs.existsSync(x.root), false);
  assert.deepEqual(registeredTaskOutputs(x.projectRoot), []);
});

test("closed but unmerged, unknown state and changed PR content preserve every local file", async (t) => {
  const x = fixture(t);
  await bindTaskPullRequest({ ...x.options, binding: x.binding });
  x.pull.state = "closed";
  assert.equal((await finishMergedTask(x.options)).status, "waiting-for-merge");
  assert.equal(
    (
      await finishMergedTask({
        ...x.options,
        readPullRequest: async () => {
          throw Error("offline");
        },
      })
    ).status,
    "retained",
  );
  x.merge();
  x.pull.body += " modified";
  assert.equal((await finishMergedTask(x.options)).reason, "COMPLETION_PR_CHANGED");
  assert.equal(fs.existsSync(x.screenshot), true);
});

test("a task group waits for every PR and skips an open acceptance file", async (t) => {
  const x = fixture(t);
  await bindTaskPullRequest({ ...x.options, binding: x.binding });
  await bindTaskPullRequest({ ...x.options, binding: { ...x.binding, number: 2 } });
  x.merge();
  const readPullRequest = async (row) => ({
    ...x.pull,
    number: row.number,
    merged: row.number === 1,
  });
  assert.equal(
    (await finishMergedTask({ ...x.options, readPullRequest })).status,
    "waiting-for-merge",
  );
  const fd = fs.openSync(x.screenshot, "r");
  try {
    assert.equal((await finishMergedTask(x.options)).status, "retained");
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.existsSync(x.screenshot), true);
  assert.equal((await finishMergedTask(x.options)).status, "finished");
});

test("published clean linked worktrees retire without force while local changes remain protected", async (t) => {
  const x = fixture(t);
  const provider = join(x.projectRoot, "provider");
  const tree = join(x.projectRoot, ".parallel", "source");
  fs.mkdirSync(provider);
  const git = (...args) =>
    cp.execFileSync("git", ["-C", provider, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  fs.writeFileSync(join(provider, "source.txt"), "published source");
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
  x.binding.head = git("rev-parse", "HEAD");
  x.pull.head.sha = x.binding.head;
  git("worktree", "add", "--detach", tree);
  const shared = join(x.projectRoot, "main-dependencies");
  fs.mkdirSync(shared);
  fs.writeFileSync(join(shared, "keep"), "active dependency");
  fs.symlinkSync(shared, join(tree, "node_modules"), "dir");
  x.options.protectedPaths = [shared];
  await bindTaskPullRequest({
    ...x.options,
    binding: x.binding,
    worktrees: [{ path: tree, repository: x.binding.repository, head: x.binding.head }],
  });
  x.merge();
  fs.writeFileSync(join(tree, "necessary-unpublished.txt"), "keep");
  assert.equal((await finishMergedTask(x.options)).reason, "COMPLETION_UNPUBLISHED_FILES");
  assert.equal(fs.readFileSync(join(tree, "necessary-unpublished.txt"), "utf8"), "keep");
  fs.unlinkSync(join(tree, "necessary-unpublished.txt"));
  const home = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "finish-reader-home-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(join(home, ".agents/skills"), { recursive: true });
  const skill = join(home, ".agents/skills/current-task");
  fs.symlinkSync(tree, skill, "dir");
  t.mock.method(os, "homedir", () => home);
  assert.equal((await finishMergedTask(x.options)).reason, "OUTPUT_DEPENDENCY_READER");
  assert.equal(fs.existsSync(tree), true);
  fs.unlinkSync(skill);
  assert.equal((await finishMergedTask(x.options)).status, "finished");
  assert.equal(fs.existsSync(tree), false);
  assert.equal(fs.readFileSync(join(shared, "keep"), "utf8"), "active dependency");
  assert.equal(fs.readFileSync(join(provider, "source.txt"), "utf8"), "published source");
});

test("automatic completion requires fresh native task activity and protects another active owner", async (t) => {
  const x = fixture(t);
  await bindTaskPullRequest({ ...x.options, binding: x.binding });
  x.merge();
  assert.equal(
    (await finishMergedTask({ ...x.options, activity: undefined })).reason,
    "COMPLETION_CURRENT_TASKS_UNKNOWN",
  );
  const activity = {
    ...x.options.activity,
    threads: [{ id: "fixture-owner", status: "active", cwd: x.projectRoot }],
    executorThreadId: "another-background-thread",
  };
  assert.equal(
    (await finishMergedTask({ ...x.options, activity })).reason,
    "COMPLETION_OWNER_ACTIVE",
  );
  assert.equal(fs.existsSync(x.screenshot), true);
  activity.threads[0].status = "idle";
  assert.equal((await finishMergedTask({ ...x.options, activity })).status, "finished");
});

test("registration requires an active independent native watch and reuses it for the PR group", async (t) => {
  const x = fixture(t);
  const first = await bindTaskPullRequest({ ...x.options, binding: x.binding });
  assert.equal(first.status, "watch-required");
  assert.equal(first.watch.request.kind, "cron");
  assert.equal(first.watch.request.destination, "local");
  assert.equal(first.watch.request.targetThreadId, undefined);
  assert.equal(completionWatchPlan(x.projectRoot, x.file).action, "check");
  const automationDirectory = join(x.projectRoot, "native-automations");
  const directory = join(automationDirectory, "fixture-watch");
  fs.mkdirSync(directory, { recursive: true });
  const request = completionWatchRequest(x.projectRoot, x.file);
  const config = {
    id: "fixture-watch",
    kind: "cron",
    status: "ACTIVE",
    execution_environment: "local",
    cwds: [x.projectRoot],
    prompt: request.prompt,
  };
  const writeConfig = () =>
    fs.writeFileSync(
      join(directory, "automation.toml"),
      Object.entries(config)
        .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
        .join("\n"),
    );
  const options = { ...x.options, binding: x.binding, watchId: config.id, automationDirectory };
  for (const [key, value] of [
    ["status", "PAUSED"],
    ["kind", "heartbeat"],
    ["prompt", "a different task"],
    ["cwds", ["/different-project"]],
  ]) {
    const previous = config[key];
    config[key] = value;
    writeConfig();
    await assert.rejects(bindTaskPullRequest(options), /COMPLETION_INDEPENDENT_WATCH_REQUIRED/);
    config[key] = previous;
  }
  writeConfig();
  assert.equal((await bindTaskPullRequest(options)).status, "tracking");
  const second = await bindTaskPullRequest({
    ...options,
    watchId: undefined,
    binding: { ...x.binding, number: 2 },
  });
  assert.equal(second.status, "tracking");
  assert.equal(second.pullRequests, 2);
  assert.deepEqual(second.watch, { automationId: config.id });
  assert.equal(completionWatchPlan(x.projectRoot, x.file).automationId, config.id);
  x.merge();
  assert.equal((await finishMergedTask(x.options)).status, "finished");
  assert.equal(completionWatchPlan(x.projectRoot, x.file).action, "stop");
  assert.equal(fs.existsSync(x.root), false);
});

test("empty task watches stop before activity collection without creating local files", (t) => {
  const x = fixture(t);
  assert.equal(completionWatchPlan(x.projectRoot, x.file).action, "stop");
  fs.rmSync(x.root, { recursive: true });
  assert.equal(completionWatchPlan(x.projectRoot, x.file).action, "stop");
  assert.equal(fs.existsSync(x.root), false);
  assert.throws(
    () => completionWatchPlan(x.projectRoot, join(x.projectRoot, "outside.json")),
    /COMPLETION_TASK_SCOPE_REQUIRED/,
  );
});

test("completed tasks stop watching while explicitly retained user data stays intact", async (t) => {
  const x = fixture(t);
  const kept = join(x.root, "necessary-source.txt");
  fs.writeFileSync(kept, "necessary unpublished content");
  const manifest = JSON.parse(fs.readFileSync(x.file, "utf8"));
  manifest.items.push({
    path: kept,
    kind: "source",
    disposition: "retain",
    reason: "not published",
  });
  fs.writeFileSync(x.file, JSON.stringify(manifest));
  await bindTaskPullRequest({ ...x.options, binding: x.binding });
  x.merge();
  assert.equal((await finishMergedTask(x.options)).status, "finished");
  assert.equal(fs.readFileSync(kept, "utf8"), "necessary unpublished content");
  assert.equal(fs.existsSync(x.screenshot), false);
  assert.equal(JSON.parse(fs.readFileSync(x.file, "utf8")).completion, undefined);
  assert.equal(completionWatchPlan(x.projectRoot, x.file).action, "stop");
  assert.deepEqual(registeredTaskOutputs(x.projectRoot), []);
});

import fs from "node:fs";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import {
  assertIdle,
  finishDevelopmentOutputs,
  userDependencyRoots,
} from "./development-outputs.mjs";

const execute = promisify(cp.execFile);
const repositories = new Set([
  "CleverC2200/dsh-agent-workbench",
  "CleverC2200/dsh-agent-manage",
  "CleverC2200/dsh-gea-plugin",
]);
const inside = (root, path) => {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
};
const digest = (body) => createHash("sha256").update(body).digest("hex");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export async function readCompletionPullRequest(binding) {
  if (
    !repositories.has(binding.repository) ||
    !Number.isSafeInteger(binding.number) ||
    binding.number < 1
  )
    throw Error("COMPLETION_PR_REQUIRED");
  const { stdout } = await execute(
    "gh",
    ["api", `repos/${binding.repository}/pulls/${binding.number}`],
    { timeout: 30_000, maxBuffer: 2 * 1024 ** 2 },
  );
  return JSON.parse(stdout);
}

function taskScope(file, projectRoot) {
  if (!isAbsolute(file) || !isAbsolute(projectRoot) || fs.realpathSync(file) !== file)
    throw Error("COMPLETION_PHYSICAL_PATH_REQUIRED");
  const roots = [join(projectRoot, ".scratch"), join(projectRoot, ".parallel")];
  const manifest = read(file);
  if (
    !roots.some((root) => inside(root, file)) ||
    !manifest.roots?.every((path) => roots.some((root) => inside(root, path)))
  )
    throw Error("COMPLETION_TASK_SCOPE_REQUIRED");
  return manifest;
}

export async function bindTaskPullRequest({
  file,
  projectRoot,
  binding,
  worktrees = [],
  readPullRequest = readCompletionPullRequest,
  ownerThreadId = process.env.CODEX_THREAD_ID,
}) {
  if (typeof ownerThreadId !== "string" || !ownerThreadId)
    throw Error("COMPLETION_OWNER_THREAD_REQUIRED");
  const manifest = taskScope(file, projectRoot);
  const pull = await readPullRequest(binding);
  if (
    pull.number !== binding.number ||
    pull.base?.repo?.full_name !== binding.repository ||
    pull.base.ref !== "main" ||
    pull.head?.repo?.full_name !== binding.repository ||
    pull.head.sha !== binding.head ||
    !/^[a-f0-9]{40}$/.test(binding.head) ||
    !pull.body?.trim()
  )
    throw Error("COMPLETION_PR_BINDING_MISMATCH");
  const previous = manifest.completion?.pullRequests ?? [];
  manifest.completion = {
    ...manifest.completion,
    ownerThreadId,
    pullRequests: [
      ...previous.filter(
        (row) => row.repository !== binding.repository || row.number !== binding.number,
      ),
      { ...binding, summarySha256: digest(pull.body) },
    ],
    worktrees: [
      ...new Map(
        [...(manifest.completion?.worktrees ?? []), ...worktrees].map((row) => [row.path, row]),
      ).values(),
    ],
  };
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return {
    status: "tracking",
    task: manifest.task,
    pullRequests: manifest.completion.pullRequests.length,
  };
}

function retireWorktree(row, manifest, projectRoot, protectedPaths) {
  if (
    !isAbsolute(row.path) ||
    !inside(join(projectRoot, ".parallel"), row.path) ||
    protectedPaths.some((path) => inside(path, row.path) || inside(row.path, path))
  )
    throw Error("COMPLETION_WORKTREE_PROTECTED");
  if (!fs.existsSync(row.path)) return;
  if (fs.realpathSync(row.path) !== row.path || !fs.lstatSync(join(row.path, ".git")).isFile())
    throw Error("COMPLETION_LINKED_WORKTREE_REQUIRED");
  if (
    !manifest.completion.pullRequests.some(
      (pull) => pull.repository === row.repository && pull.head === row.head,
    )
  )
    throw Error("COMPLETION_WORKTREE_NOT_PUBLISHED");
  const git = (...args) =>
    cp.execFileSync("git", ["-C", row.path, ...args], { encoding: "utf8" }).trim();
  const modules = join(row.path, "node_modules");
  const borrowed =
    fs.existsSync(modules) &&
    fs.lstatSync(modules).isSymbolicLink() &&
    protectedPaths.some((path) => inside(path, fs.realpathSync(modules))) &&
    !git("ls-files", "--", "node_modules");
  const changes = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter((line) => line && !(borrowed && line === "?? node_modules"));
  const ignored = git("ls-files", "--others", "--ignored", "--exclude-standard")
    .split("\n")
    .filter((line) => line && !(borrowed && line === "node_modules"));
  if (git("rev-parse", "HEAD") !== row.head || changes.length || ignored.length)
    throw Error("COMPLETION_UNPUBLISHED_FILES");
  const gitdir = git("rev-parse", "--absolute-git-dir");
  if (fs.existsSync(join(gitdir, "index.lock")) || fs.existsSync(join(gitdir, "locked")))
    throw Error("COMPLETION_GIT_LOCKED");
  assertIdle(row.path, [projectRoot, ...userDependencyRoots()], row.path);
  const common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const link = borrowed ? fs.readlinkSync(modules) : null;
  if (borrowed) fs.unlinkSync(modules);
  try {
    cp.execFileSync("git", ["--git-dir", common, "worktree", "remove", "--", row.path], {
      cwd: projectRoot,
      stdio: "pipe",
    });
  } catch (error) {
    if (link && fs.existsSync(row.path) && !fs.existsSync(modules))
      fs.symlinkSync(link, modules, "dir");
    throw error;
  }
}

function removeTaskMetadata(file) {
  const state = file + ".finish-state";
  if (fs.existsSync(state)) {
    if (fs.readdirSync(state).some((name) => name !== "owner.json"))
      throw Error("COMPLETION_TRANSACTION_PENDING");
    fs.unlinkSync(join(state, "owner.json"));
    fs.rmdirSync(state);
  }
  if (fs.existsSync(file + ".finish-lock")) throw Error("COMPLETION_TRANSACTION_PENDING");
  if (fs.existsSync(file + ".cleanup.json")) fs.unlinkSync(file + ".cleanup.json");
  fs.unlinkSync(file);
  if (!fs.readdirSync(dirname(file)).length) fs.rmdirSync(dirname(file));
}

export async function finishMergedTask({
  file,
  projectRoot,
  protectedPaths = [],
  readPullRequest = readCompletionPullRequest,
  activity,
}) {
  try {
    const observed = Date.parse(activity?.observedAt);
    if (
      activity?.complete !== true ||
      !Array.isArray(activity.protectedPaths) ||
      !Array.isArray(activity.threads) ||
      !activity.protectedPaths.every(isAbsolute) ||
      !Number.isFinite(observed) ||
      Date.now() - observed > 120_000 ||
      observed > Date.now() + 5_000
    )
      throw Error("COMPLETION_CURRENT_TASKS_UNKNOWN");
    protectedPaths = [...protectedPaths, ...activity.protectedPaths];
    const manifest = taskScope(file, projectRoot);
    const bindings = manifest.completion?.pullRequests;
    if (!bindings?.length) return { status: "unregistered" };
    if (typeof manifest.completion.ownerThreadId !== "string")
      throw Error("COMPLETION_OWNER_THREAD_REQUIRED");
    const activeThreads = activity.threads.filter(
      (thread) => !["idle", "notLoaded", "archived"].includes(thread.status),
    );
    if (
      activeThreads.some(
        (thread) =>
          thread.id === manifest.completion.ownerThreadId &&
          thread.id !== activity.executorThreadId,
      )
    )
      throw Error("COMPLETION_OWNER_ACTIVE");
    protectedPaths.push(
      ...activeThreads
        .map((thread) => thread.cwd)
        .filter(
          (path) =>
            typeof path === "string" &&
            [join(projectRoot, ".parallel"), join(projectRoot, ".scratch")].some((root) =>
              inside(root, path),
            ),
        ),
    );
    for (const binding of bindings) {
      const pull = await readPullRequest(binding);
      if (
        pull.number !== binding.number ||
        pull.base?.repo?.full_name !== binding.repository ||
        pull.base.ref !== "main" ||
        pull.head?.repo?.full_name !== binding.repository ||
        pull.head.sha !== binding.head ||
        !pull.body?.trim() ||
        digest(pull.body) !== binding.summarySha256
      )
        throw Error("COMPLETION_PR_CHANGED");
      if (
        pull.merged !== true ||
        !Number.isFinite(Date.parse(pull.merged_at)) ||
        !/^[a-f0-9]{40}$/.test(pull.merge_commit_sha ?? "")
      )
        return { status: "waiting-for-merge", task: manifest.task };
    }
    const result = finishDevelopmentOutputs(file, protectedPaths, [projectRoot], true);
    if (result.status !== "disposition-complete")
      return { status: "retained", task: manifest.task, issues: result.issues };
    for (const row of manifest.completion.worktrees ?? [])
      retireWorktree(row, manifest, projectRoot, protectedPaths);
    if (read(file).items.every((item) => item.disposition === "remove")) removeTaskMetadata(file);
    return {
      status: "finished",
      task: manifest.task,
      pullRequests: bindings.map(({ repository, number }) => ({ repository, number })),
    };
  } catch (error) {
    return { status: "retained", reason: error.message };
  }
}

export function registeredTaskOutputs(projectRoot) {
  const files = [];
  const visit = (root) => {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isFile() && entry.name === "outputs.json") {
        try {
          if (read(path).completion?.pullRequests?.length) files.push(path);
        } catch {}
      } else if (
        entry.isDirectory() &&
        !["node_modules", ".git", "lib", "tree", "snapshots"].includes(entry.name) &&
        !entry.name.endsWith(".skills")
      )
        visit(path);
    }
  };
  visit(join(projectRoot, ".scratch"));
  visit(join(projectRoot, ".parallel"));
  return files;
}

import fs from "node:fs";
import os from "node:os";
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

function watchMarker(file) {
  return `completion-watch:${digest(file).slice(0, 24)}`;
}

export function completionWatchRequest(projectRoot, file) {
  const marker = watchMarker(file);
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const activity = join(
    projectRoot,
    ".development/main",
    `finish-activity-${digest(file).slice(0, 12)}.json`,
  );
  const command = `node ${quote(join(projectRoot, "tools/development.mjs"))}`;
  return {
    mode: "create",
    kind: "cron",
    executionEnvironment: "local",
    destination: "local",
    name: `PR收尾 ${digest(file).slice(0, 12)}`,
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
    notificationPolicy: "failed_runs_only",
    projectId: null,
    rrule: "FREQ=MINUTELY;INTERVAL=5",
    status: "ACTIVE",
    prompt: [
      `本机项目 ${projectRoot} 的独立 PR 收尾任务。唯一标记 ${marker}。只处理清单 ${file}，不发送消息到原聊天。`,
      `先在项目根运行 ${command} watch-plan --outputs ${quote(file)}。action=stop 表示清单已退场或未登记，不读取聊天、不写活动快照，直接停止本检查。`,
      `停止检查时，只读检查本机 $CODEX_HOME/automations（未设置时 ~/.codex/automations）中 kind=cron 且 prompt 包含完整标记 ${marker} 的配置，通过原生 automation_update mode=delete 删除匹配的检查；不得直接修改自动任务文件。`,
      "action=check 时，用原生 list_threads history/codex 完整分页读取当前 host 未归档聊天直到 nextCursor 为空，再用 recent 确认 unavailableHosts/unavailableSources 为空。失败或不完整时保留文件，不能伪造无活动任务。只提取 id/status/cwd，不读取正文。",
      `将 complete=true、本次 UTC observedAt、完整 threads 写入 ${activity}。protectedPaths 只含 active 或未知状态且 cwd 位于本项目 .parallel/.scratch 下的具体路径，不把整个项目根当成任务路径。用普通文件写入，不用 apply_patch。`,
      `在项目根运行 ${command} finish-merged --outputs ${quote(file)} --activity ${quote(activity)}。只用这个入口，不删其他目录、不改数据库、不停止进程，不重发合并或安装。保留在用环境及 GitHub 未覆盖的必要改动。`,
      `无论执行成功或失败，都删除本轮临时文件 ${activity}。返回 watch.action=stop 时立即按唯一标记删除本检查；等待合并、占用或必要改动导致保留时，下次继续核对同一清单。重要结果和边界保存在对应 PR，本地不另建报告。`,
    ].join("\n"),
  };
}

function activeCompletionWatch(projectRoot, file, id, directory) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id ?? "")) return false;
  try {
    const config = fs.readFileSync(join(directory, id, "automation.toml"), "utf8");
    const value = (key) => {
      const line = config.split("\n").find((line) => line.startsWith(key + " = "));
      return line ? JSON.parse(line.slice(key.length + 3)) : null;
    };
    return (
      value("id") === id &&
      value("kind") === "cron" &&
      value("status") === "ACTIVE" &&
      value("execution_environment") === "local" &&
      value("cwds")?.includes(projectRoot) &&
      value("prompt") === completionWatchRequest(projectRoot, file).prompt &&
      !/^target_thread_id\s*=/m.test(config)
    );
  } catch {
    return false;
  }
}

export function completionWatchPlan(projectRoot, file) {
  if (
    !isAbsolute(file ?? "") ||
    ![".scratch", ".parallel"].some((root) => inside(join(projectRoot, root), file))
  )
    throw Error("COMPLETION_TASK_SCOPE_REQUIRED");
  if (!fs.existsSync(file)) return { action: "stop", outputs: file };
  const manifest = taskScope(file, projectRoot);
  return {
    action: manifest.completion?.pullRequests?.length ? "check" : "stop",
    outputs: file,
    automationId: manifest.completion?.watchAutomationId ?? null,
  };
}

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
  watchId,
  automationDirectory = join(process.env.CODEX_HOME ?? join(os.homedir(), ".codex"), "automations"),
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
  const id = watchId ?? manifest.completion.watchAutomationId;
  const watching = activeCompletionWatch(projectRoot, file, id, automationDirectory);
  if (watchId && !watching) throw Error("COMPLETION_INDEPENDENT_WATCH_REQUIRED");
  if (watching) manifest.completion.watchAutomationId = id;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return {
    status: watching ? "tracking" : "watch-required",
    task: manifest.task,
    pullRequests: manifest.completion.pullRequests.length,
    watch: watching
      ? { automationId: id }
      : {
          projectRoot,
          tool: "automation_update",
          instruction:
            "用 list_projects 找到 projectRoot 的 projectId，复用或创建以下独立原生检查，再用 bind-pr --watch-id <返回的id> 完成登记。不要创建 heartbeat。",
          request: completionWatchRequest(projectRoot, file),
        },
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
    const disposition = read(file);
    if (disposition.items.every((item) => item.disposition === "remove")) removeTaskMetadata(file);
    else {
      delete disposition.completion;
      fs.writeFileSync(file, JSON.stringify(disposition, null, 2) + "\n");
    }
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

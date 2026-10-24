import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const binding = ["id", "repository", "pr", "head", "base", "actor"];
const fullSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

function admission(request, policy) {
  if (
    !request ||
    !binding.every((key) => request[key]) ||
    !fullSha(request.head) ||
    !Number.isSafeInteger(request.pr) ||
    request.pr < 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(request.repository) ||
    request.base !== "main" ||
    !Number.isFinite(request.enqueuedAt)
  )
    return "invalid_request";
  if (!policy.approvals.some((approval) => binding.every((key) => approval[key] === request[key])))
    return "unauthorized";
  if (request.cancelled) return "cancelled";
  return null;
}

function pullRejection(pr, request) {
  if (pr.draft) return "draft";
  if (pr.state !== "open") return "closed";
  if (pr.head.repo?.full_name !== request.repository) return "fork";
  if (pr.base.ref !== request.base || pr.base.repo.full_name !== request.repository)
    return "base_changed";
  return null;
}

export function createGitHubReader(readJson) {
  const path = (request) => {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(request.repository) ||
      !Number.isSafeInteger(request.pr) ||
      request.pr < 1 ||
      request.base !== "main"
    )
      throw new Error("invalid GitHub target");
    return `repos/${request.repository}`;
  };
  const commit = (request, sha) => {
    if (!fullSha(sha)) throw new Error("invalid commit SHA");
    return `${path(request)}/commits/${sha}`;
  };
  return {
    readPullRequest: async (request) => readJson(`${path(request)}/pulls/${request.pr}`),
    readBranch: async (request) => readJson(`${path(request)}/branches/main`),
    readProtection: async (request) => readJson(`${path(request)}/branches/main/protection`),
    readCommit: async (request, sha) => readJson(commit(request, sha)),
    readCheckWorkflow: async (request, suiteId) => {
      if (!Number.isSafeInteger(suiteId) || suiteId < 1) throw new Error("invalid check suite");
      return readJson(`${path(request)}/actions/runs?check_suite_id=${suiteId}&per_page=100`);
    },
    readChecks: async (request, sha) => {
      const check_runs = [];
      for (let page = 1; page <= 100; page++) {
        const result = await readJson(
          `${commit(request, sha)}/check-runs?per_page=100&filter=all&page=${page}`,
        );
        check_runs.push(...result.check_runs);
        if (check_runs.length >= result.total_count) return { check_runs };
        if (!result.check_runs.length) break;
      }
      throw new Error("incomplete check pagination");
    },
  };
}

export async function readSerialMergeChecks(request, api, head, workflow) {
  const protection = await api.readProtection(request);
  const required = protection.required_status_checks;
  if (
    !required?.strict ||
    !required.checks?.length ||
    !protection.enforce_admins?.enabled ||
    required.checks.some((check) => !Number.isSafeInteger(check.app_id) || check.app_id < 1)
  )
    return { status: "unverified", receipts: [] };
  if (
    workflow &&
    !required.checks.some(
      (check) =>
        check.context === workflow.requiredCheck && check.app_id === workflow.requiredCheckAppId,
    )
  )
    return { status: "unverified", receipts: [] };
  const checks = await api.readChecks(request, head);
  const receipts = [];
  for (const check of required.checks) {
    const candidates = checks.check_runs
      .filter(
        (run) =>
          run.name === check.context && run.head_sha === head && run.app?.id === check.app_id,
      )
      .sort((a, b) => b.id - a.id);
    let receipt;
    for (const candidate of candidates) {
      if (workflow) {
        if (!candidate.check_suite?.id) continue;
        const runs = await api.readCheckWorkflow(request, candidate.check_suite.id);
        if (
          !runs.workflow_runs?.some(
            (run) =>
              run.workflow_id === workflow.sourceWorkflowId &&
              run.path === workflow.sourceWorkflowPath &&
              run.event === "pull_request" &&
              run.head_sha === head &&
              run.head_branch === request.sourceBranch &&
              run.repository?.id === workflow.repositoryId &&
              run.head_repository?.id === workflow.repositoryId &&
              run.pull_requests?.some(
                (pull) =>
                  pull.number === request.pr &&
                  pull.head?.repo?.id === workflow.repositoryId &&
                  pull.base?.repo?.id === workflow.repositoryId &&
                  pull.head.ref === request.sourceBranch &&
                  pull.base.ref === "main",
              ),
          )
        )
          continue;
      }
      receipt = candidate;
      break;
    }
    receipts.push(receipt);
  }
  if (
    receipts.some(
      (run) =>
        run?.status === "completed" &&
        [
          "failure",
          "cancelled",
          "timed_out",
          "action_required",
          "startup_failure",
          "stale",
        ].includes(run.conclusion),
    )
  )
    return { status: "failed", receipts };
  return {
    status: receipts.every((run) => run?.status === "completed" && run.conclusion === "success")
      ? "passed"
      : "pending",
    receipts,
  };
}

export async function runSerialMerge(input, policy, api, now = Date.now()) {
  if (
    !Array.isArray(policy.approvals) ||
    !Number.isSafeInteger(policy.capacity) ||
    policy.capacity < 1 ||
    policy.capacity > 100 ||
    !Number.isFinite(policy.budgetMs) ||
    policy.budgetMs <= 0
  )
    throw new Error("invalid controller policy");
  const state = structuredClone({ queue: [], active: null, finished: [], ...input });
  const result = (decision) => ({ mode: "dry-run", state, decision });
  const finish = (reason) => {
    const request = state.active.request;
    state.finished.push({ request, reason });
    state.active = null;
    return result({ action: "finished", requestId: request.id, reason });
  };
  const seenIds = new Set(state.finished.map((item) => item.request.id));
  const seenHeads = new Set();
  if (state.active) {
    seenIds.add(state.active.request.id);
    seenHeads.add(
      `${state.active.request.repository}/${state.active.request.pr}/${state.active.request.head}`,
    );
  }
  const admitted = [];
  for (const request of state.queue.sort(
    (a, b) => a.enqueuedAt - b.enqueuedAt || a.id.localeCompare(b.id),
  )) {
    const key = `${request.repository}/${request.pr}/${request.head}`;
    const reason =
      admission(request, policy) ||
      (seenIds.has(request.id) || seenHeads.has(key) ? "duplicate" : null) ||
      (admitted.length + Number(Boolean(state.active)) >= policy.capacity ? "capacity" : null);
    if (reason) state.finished.push({ request, reason });
    else {
      admitted.push(request);
      seenIds.add(request.id);
      seenHeads.add(key);
    }
  }
  state.queue = admitted;
  if (!state.active) {
    const request = state.queue.shift();
    if (!request) return result({ action: "idle" });
    state.active = { request, phase: "queued", startedAt: now };
  }
  const active = state.active;
  const pause = (reason) => result({ action: "paused", requestId: active.request.id, reason });
  try {
    if (!["queued", "updating", "checking", "reconciling"].includes(active.phase))
      return pause("invalid_active_phase");
    if (active.outcome === "failed") return finish("operation_failed");
    if (active.phase === "reconciling") {
      const pr = await api.readPullRequest(active.request);
      if (pr.merged && pr.head.sha === active.head && fullSha(pr.merge_commit_sha))
        return finish("merged");
      return pause("merge_outcome_unknown");
    }
    const denied = admission(active.request, policy);
    if (denied && active.phase !== "updating") return finish(denied);
    if (now - active.startedAt >= policy.budgetMs && active.phase !== "updating")
      return finish("timeout");
    const pr = await api.readPullRequest(active.request);
    const rejected = pullRejection(pr, active.request);
    if (rejected && active.phase !== "updating") return finish(rejected);
    const branch = await api.readBranch(active.request);
    if (active.phase === "updating") {
      if (pr.head.sha === active.head) {
        if (
          denied ||
          rejected ||
          now - active.startedAt >= policy.budgetMs ||
          active.outcome === "unknown"
        )
          return pause("update_outcome_unknown");
        return result({ action: "wait_update", requestId: active.request.id });
      }
      const commit = await api.readCommit(active.request, pr.head.sha);
      if (
        commit.parents.length !== 2 ||
        commit.parents[0].sha !== active.head ||
        commit.parents[1].sha !== active.base
      )
        return pause("update_outcome_unknown");
      const approval = policy.approvals.find((item) =>
        binding.every((key) => item[key] === active.request[key]),
      );
      if (approval?.updatedHead !== pr.head.sha) return pause("update_source_unverified");
      active.head = pr.head.sha;
      active.phase = "checking";
      if (denied) return finish(denied);
      if (rejected) return finish(rejected);
      if (branch.commit.sha !== active.base) return finish("base_advanced");
      return result({ action: "wait_checks", requestId: active.request.id, head: active.head });
    }
    if (active.phase === "checking") {
      const approval = policy.approvals.find((item) =>
        binding.every((key) => item[key] === active.request[key]),
      );
      if (active.head !== active.request.head && approval?.updatedHead !== active.head)
        return finish("updated_head_not_approved");
      if (pr.head.sha !== active.head) return finish("head_changed");
      if (branch.commit.sha !== active.base) return finish("base_advanced");
      const checks = await readSerialMergeChecks(active.request, api, active.head, policy.workflow);
      if (checks.status === "unverified") return finish("protection_unverified");
      if (checks.status === "failed") return finish("checks_failed");
      if (pr.mergeable_state !== "clean" || checks.status !== "passed")
        return result({ action: "wait_checks", requestId: active.request.id, head: active.head });
      const currentPull = await api.readPullRequest(active.request);
      const currentBranch = await api.readBranch(active.request);
      const rejectedCurrent = pullRejection(currentPull, active.request);
      if (rejectedCurrent) return finish(rejectedCurrent);
      if (currentPull.head.sha !== active.head) return finish("head_changed");
      if (currentBranch.commit.sha !== active.base) return finish("base_advanced");
      active.phase = "reconciling";
      return result({
        action: "would_merge",
        requestId: active.request.id,
        sha: active.head,
        base: active.base,
      });
    }
    if (pr.head.sha !== active.request.head) return finish("head_changed");
    active.base = branch.commit.sha;
    active.head = pr.head.sha;
    if (pr.mergeable_state !== "behind") {
      if (pr.mergeable_state === "dirty") return finish("not_mergeable");
      if (!pr.mergeable_state || pr.mergeable_state === "unknown")
        return result({ action: "wait_mergeability", requestId: active.request.id });
      active.phase = "checking";
      return result({ action: "wait_checks", requestId: active.request.id, head: active.head });
    }
    active.phase = "updating";
    return result({
      action: "would_update",
      requestId: active.request.id,
      expected_head_sha: active.head,
      base: active.base,
    });
  } catch {
    if (["updating", "reconciling"].includes(active.phase))
      return pause("read_failed_during_reconciliation");
    return finish("read_failed");
  }
}

async function main(args) {
  const [mode, file] = args;
  if (args.length !== 2 || !["--fixture", "--github"].includes(mode))
    throw new Error("Use --fixture input.json or --github input.json");
  const input = JSON.parse(readFileSync(file, "utf8"));
  const readJson = async (endpoint) => {
    if (mode === "--fixture") {
      if (!Object.hasOwn(input.responses, endpoint)) throw new Error("missing fixture endpoint");
      return structuredClone(input.responses[endpoint]);
    }
    try {
      return JSON.parse(
        execFileSync("gh", ["api", "--method", "GET", endpoint], {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {
      throw new Error("GitHub read failed");
    }
  };
  const reader = createGitHubReader(readJson);
  let observation;
  if (mode === "--github") {
    const request = input.state.active?.request ?? input.state.queue[0];
    if (!request) throw new Error("GitHub observation requires a request");
    const actor = await readJson("user");
    const pr = await reader.readPullRequest(request);
    const branch = await reader.readBranch(request);
    const protection = await reader.readProtection(request);
    const checks = await reader.readChecks(request, pr.head.sha);
    observation = {
      at: new Date().toISOString(),
      authenticatedActor: actor.login,
      repository: request.repository,
      pr: pr.number,
      state: pr.state,
      draft: pr.draft,
      head: pr.head.sha,
      headRepository: pr.head.repo?.full_name,
      baseRef: pr.base.ref,
      observedBase: branch.commit.sha,
      strict: protection.required_status_checks?.strict,
      required: protection.required_status_checks?.checks,
      checks: checks.check_runs.map((run) => ({
        id: run.id,
        name: run.name,
        head: run.head_sha,
        appId: run.app?.id,
        status: run.status,
        conclusion: run.conclusion,
      })),
    };
    if (actor.login !== request.actor) input.policy.approvals = [];
  }
  const output = await runSerialMerge(input.state, input.policy, reader, input.now);
  if (observation) output.observation = observation;
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      error.message === "Use --fixture input.json or --github input.json"
        ? error.message + "\n"
        : "Serial merge dry-run failed; no GitHub write was attempted\n",
    );
    process.exitCode = 1;
  });
}

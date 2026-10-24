import { readFileSync } from "node:fs";
import {
  createGitHubReader,
  readSerialMergeChecks,
  runSerialMerge,
} from "./serial-merge-controller.mjs";

const policy = JSON.parse(readFileSync(new URL("./serial-merge-policy.json", import.meta.url)));

function sourceRunMatches(run, request, head) {
  return (
    run.workflow_id === policy.sourceWorkflowId &&
    run.path === policy.sourceWorkflowPath &&
    run.event === "pull_request" &&
    run.head_sha === head &&
    run.head_branch === request.sourceBranch &&
    run.repository?.id === policy.repositoryId &&
    run.head_repository?.id === policy.repositoryId &&
    run.actor?.id === policy.botId &&
    run.actor.type === "Bot" &&
    run.actor.login === policy.appSlug + "[bot]" &&
    run.pull_requests?.some(
      (pull) =>
        pull.id === request.pullId &&
        pull.number === request.pr &&
        pull.head?.repo?.id === policy.repositoryId &&
        pull.base?.repo?.id === policy.repositoryId &&
        pull.head.ref === request.sourceBranch &&
        pull.base.ref === "main",
    )
  );
}

async function updateProof(envelope, api, runtime) {
  const active = envelope.state.active;
  const pull = await api.readPullRequest(envelope.request);
  if (pull.head.sha === active.head) return null;
  const listed = await runtime.readJson(
    `repos/${policy.repository}/actions/workflows/${policy.sourceWorkflowId}/runs?event=pull_request&branch=${encodeURIComponent(envelope.request.sourceBranch)}&head_sha=${pull.head.sha}&per_page=100`,
  );
  for (const candidate of listed.workflow_runs) {
    if (
      !sourceRunMatches(candidate, envelope.request, pull.head.sha) ||
      envelope.intent.beforeRuns.includes(candidate.id)
    )
      continue;
    const first = await runtime.readJson(
      `repos/${policy.repository}/actions/runs/${candidate.id}/attempts/1`,
    );
    const created = Date.parse(first.created_at);
    if (
      first.id !== candidate.id ||
      first.run_attempt !== 1 ||
      !sourceRunMatches(first, envelope.request, pull.head.sha) ||
      !Number.isFinite(created) ||
      created < Math.floor(envelope.intent.at / 1000) * 1000 ||
      created > runtime.clock.now() ||
      created > active.startedAt + policy.budgetMs
    )
      continue;
    return {
      runId: first.id,
      attempt: 1,
      actorId: first.actor.id,
      head: first.head_sha,
      base: active.base,
      originalHead: active.head,
      createdAt: first.created_at,
    };
  }
  return null;
}

export async function executeSerialMerge(input, runtime) {
  const identity = await runtime.identity();
  const self = identity.self;
  if (
    !identity.enabled ||
    self.repository.id !== policy.repositoryId ||
    self.repository.full_name !== policy.repository ||
    self.head_branch !== "main" ||
    self.path !== policy.controllerWorkflowPath ||
    self.event !== "workflow_dispatch" ||
    self.head_sha !== identity.checkoutSha ||
    self.actor.id !== identity.actorId ||
    self.actor.login !== identity.actor ||
    self.actor.type !== "User" ||
    identity.eventSenderId !== identity.actorId
  )
    return { status: "rejected", reason: "trusted_main_required" };
  let history;
  try {
    history = await runtime.restore();
  } catch {
    return { status: "paused", reason: "history_unavailable" };
  }
  try {
    for (let index = 0; index < history.records.length; index++) {
      const previous = history.records[index];
      if (!previous.state.active || (previous.intent && previous.state.active.outcome !== "failed"))
        continue;
      const terminal = structuredClone(previous);
      const reason =
        terminal.state.active.outcome === "failed"
          ? "operation_failed"
          : "interrupted_without_pending_write";
      terminal.state = {
        queue: [],
        active: null,
        finished: [{ request: terminal.request, reason }],
      };
      terminal.owner = {
        runId: self.id,
        attempt: self.run_attempt,
        controllerSha: identity.checkoutSha,
      };
      terminal.revision++;
      const receipt = await runtime.checkpoint(terminal, "terminal");
      if (!Number.isSafeInteger(receipt?.id) || receipt.id < 1)
        throw Error("checkpoint_not_acknowledged");
      history.records[index] = terminal;
    }
  } catch {
    return { status: "paused", reason: "persistence_unavailable" };
  }
  const ownPrior = history.records.find((record) => record.request.id === String(self.id));
  const persistExisting = async (record, status, reason) => {
    const checkpoint = structuredClone(record);
    checkpoint.revision++;
    checkpoint.owner = {
      runId: self.id,
      attempt: self.run_attempt,
      controllerSha: identity.checkoutSha,
    };
    const receipt = await runtime.checkpoint(
      checkpoint,
      checkpoint.state.active ? "state" : "terminal",
    );
    if (!Number.isSafeInteger(receipt?.id) || receipt.id < 1)
      return { status: "paused", reason: "persistence_unavailable", requestId: record.request.id };
    return { status, reason, requestId: record.request.id };
  };
  const reject = async (reason, status = "rejected") => {
    if (ownPrior?.state.active)
      return persistExisting(ownPrior, "paused", "prior_write_unresolved");
    if (ownPrior) return persistExisting(ownPrior, "finished", "already_finished");
    const request = {
      id: String(self.id),
      repository: policy.repository,
      actor: identity.actor,
      actorId: identity.actorId,
    };
    const record = {
      schemaVersion: 1,
      request,
      revision: 1,
      noWrite: true,
      owner: { runId: self.id, attempt: self.run_attempt, controllerSha: identity.checkoutSha },
      state: { queue: [], active: null, finished: [{ request, reason }] },
    };
    const receipt = await runtime.checkpoint(record, "terminal");
    if (!Number.isSafeInteger(receipt?.id) || receipt.id < 1)
      return { status: "paused", reason: "persistence_unavailable" };
    return { status, reason };
  };
  let permission;
  try {
    permission = await runtime.readJson(
      `repos/${policy.repository}/collaborators/${encodeURIComponent(identity.actor)}/permission`,
    );
  } catch {
    return reject("read_failed");
  }
  if (
    !["write", "maintain", "admin"].includes(permission.permission) ||
    permission.user.id !== identity.actorId
  )
    return reject("actor_not_authorized");
  const pending = history.records.filter(
    (record) => record.state.active && record.state.active.outcome !== "failed",
  );
  if (pending.length > 1) return reject("ambiguous_prior_writes", "paused");
  const recoveryId =
    input.operation === "recover" ? String(input.recoveryRequestId) : String(self.id);
  let envelope = history.records.find((record) => record.request.id === recoveryId);
  if (pending.some((record) => record.request.id !== recoveryId))
    return reject("prior_write_unresolved", "paused");
  if (input.operation === "recover" && !["maintain", "admin"].includes(permission.permission))
    return reject("recovery_not_authorized");
  if (input.operation === "recover" && !envelope) return reject("recovery_request_missing");
  const api = createGitHubReader(runtime.readJson);
  let request;
  if (envelope) {
    envelope = structuredClone(envelope);
    request = envelope.request;
    if (!envelope.state.active) return persistExisting(envelope, "finished", "already_finished");
    envelope.owner = {
      runId: self.id,
      attempt: self.run_attempt,
      controllerSha: identity.checkoutSha,
    };
  } else {
    if (
      input.operation !== "enqueue" ||
      !Number.isSafeInteger(Number(input.pr)) ||
      Number(input.pr) < 1 ||
      !/^[a-f0-9]{40}$/.test(input.head ?? "") ||
      policy.blockedPullRequests.includes(Number(input.pr))
    )
      return reject("request_not_admitted");
    request = {
      id: String(self.id),
      repository: policy.repository,
      pr: Number(input.pr),
      head: input.head,
      base: "main",
      actor: identity.actor,
      actorId: identity.actorId,
      enqueuedAt: runtime.clock.now(),
    };
    let pull;
    try {
      pull = await api.readPullRequest(request);
    } catch {
      return reject("read_failed");
    }
    request.sourceBranch = pull.head.ref;
    request.pullId = pull.id;
    envelope = {
      schemaVersion: 1,
      request,
      revision: 0,
      owner: { runId: self.id, attempt: self.run_attempt, controllerSha: identity.checkoutSha },
      state: { queue: [request], active: null, finished: [] },
    };
    let initial;
    try {
      initial = await readSerialMergeChecks(request, api, request.head, policy);
    } catch {
      return reject("read_failed");
    }
    if (initial.status !== "passed") {
      envelope.state = {
        queue: [],
        active: null,
        finished: [{ request, reason: "initial_checks_not_ready" }],
      };
      envelope.revision++;
      const receipt = await runtime.checkpoint(envelope, "terminal");
      if (!Number.isSafeInteger(receipt?.id) || receipt.id < 1)
        return { status: "paused", reason: "persistence_unavailable", requestId: request.id };
      return { status: "finished", reason: "initial_checks_not_ready", requestId: request.id };
    }
  }
  const save = async (kind) => {
    envelope.revision++;
    const receipt = await runtime.checkpoint(envelope, kind);
    if (!Number.isSafeInteger(receipt?.id) || receipt.id < 1)
      throw Error("persistence_unavailable");
  };
  try {
    while (true) {
      if (runtime.signal.aborted) {
        if (envelope.state.active) envelope.state.active.request.cancelled = true;
        else
          envelope.state.queue.forEach((item) => {
            item.cancelled = true;
          });
      }
      const active = envelope.state.active;
      if (
        active?.phase === "updating" &&
        active.outcome !== "failed" &&
        envelope.intent?.operation === "update"
      ) {
        const proof = await updateProof(envelope, api, runtime);
        if (proof) envelope.proof = proof;
      }
      const approval = {
        ...request,
        ...(envelope.proof ? { updatedHead: envelope.proof.head } : {}),
      };
      const result = await runSerialMerge(
        envelope.state,
        { approvals: [approval], capacity: 1, budgetMs: policy.budgetMs, workflow: policy },
        api,
        runtime.clock.now(),
      );
      envelope.state = result.state;
      const decision = result.decision;
      if (["would_update", "would_merge"].includes(decision.action)) {
        await runtime.guardWrites(request);
        const operation = decision.action === "would_update" ? "update" : "merge";
        const before =
          operation === "update"
            ? await runtime.readJson(
                `repos/${policy.repository}/actions/workflows/${policy.sourceWorkflowId}/runs?event=pull_request&branch=${encodeURIComponent(request.sourceBranch)}&per_page=100`,
              )
            : { workflow_runs: [] };
        envelope.intent = {
          operation,
          head: operation === "update" ? decision.expected_head_sha : decision.sha,
          base: decision.base,
          at: runtime.clock.now(),
          beforeRuns: before.workflow_runs.map((run) => run.id),
        };
        await save("intent");
        if (runtime.signal.aborted)
          return { status: "paused", reason: "cancelled_after_intent", requestId: request.id };
        const written = await runtime[operation](request, envelope.intent.head);
        envelope.state.active.outcome = written.outcome;
        await save("state");
        continue;
      }
      if (["finished", "idle"].includes(decision.action)) {
        await save("terminal");
        return {
          status: "finished",
          reason: decision.reason ?? envelope.state.finished.at(-1)?.reason,
          requestId: request.id,
        };
      }
      const expired = runtime.clock.now() - envelope.state.active.startedAt >= policy.budgetMs;
      if (runtime.signal.aborted || (decision.action === "paused" && expired)) {
        await save("state");
        return { status: "paused", reason: decision.reason ?? "cancelled", requestId: request.id };
      }
      if (envelope.state.active.phase === "checking" && envelope.intent?.operation === "update") {
        envelope.intent = null;
        delete envelope.state.active.outcome;
        await save("state");
      }
      await runtime.clock.sleep(policy.pollMs, runtime.signal);
    }
  } catch {
    if (!envelope.intent) {
      const reason = runtime.signal.aborted ? "cancelled" : "read_failed";
      envelope.state = { queue: [], active: null, finished: [{ request, reason }] };
      try {
        await save("terminal");
        return { status: "finished", reason, requestId: request.id };
      } catch {}
    }
    return { status: "paused", reason: "unconfirmed_or_unavailable", requestId: request.id };
  }
}

import { sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const policy = JSON.parse(readFileSync(new URL("./serial-merge-policy.json", import.meta.url)));

export function createSerialMergeRuntime({
  context,
  event,
  privateKey,
  githubToken,
  journalFactory,
  fetch = globalThis.fetch,
  clock = { now: Date.now, sleep: (ms, signal) => sleep(ms, undefined, { signal }) },
  signal = new AbortController().signal,
  mask = () => {},
}) {
  let token;
  let expires = 0;
  let journal;
  let permit;
  const http = async (path, method, authentication, body) => {
    const response = await fetch("https://api.github.com/" + path, {
      method,
      headers: {
        authorization: "Bearer " + authentication,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    return { status: response.status, data: await response.json() };
  };
  const appToken = async () => {
    if (token && expires - clock.now() > 120000) return token;
    if (context.appId !== policy.appId || context.installationId !== policy.installationId)
      throw Error("app_identity_mismatch");
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: String(policy.appId),
        iat: Math.floor(clock.now() / 1000) - 60,
        exp: Math.floor(clock.now() / 1000) + 540,
      });
    const jwt =
      claims + "." + sign("RSA-SHA256", Buffer.from(claims), privateKey).toString("base64url");
    mask(jwt);
    const app = await http("app", "GET", jwt);
    if (app.status !== 200 || app.data.id !== policy.appId || app.data.slug !== policy.appSlug)
      throw Error("app_identity_mismatch");
    const minted = await http(
      `app/installations/${policy.installationId}/access_tokens`,
      "POST",
      jwt,
      {
        repositories: ["dsh-gea-plugin"],
        permissions: {
          contents: "write",
          pull_requests: "write",
          checks: "read",
          administration: "read",
        },
      },
    );
    expires = Date.parse(minted.data.expires_at);
    if (
      minted.status !== 201 ||
      typeof minted.data.token !== "string" ||
      !Number.isFinite(expires) ||
      expires - clock.now() <= 120000
    )
      throw Error("app_token_unavailable");
    token = minted.data.token;
    mask(token);
    return token;
  };
  const readJson = async (path) => {
    if (!path.startsWith(`repos/${policy.repository}/`)) throw Error("read_target_rejected");
    const response = await http(
      path,
      "GET",
      path.includes("/actions/") ? githubToken : await appToken(),
    );
    if (response.status !== 200) throw Error("github_read_failed");
    return response.data;
  };
  const guardWrites = async (request) => {
    if (
      !context.enabled ||
      signal.aborted ||
      !Number.isSafeInteger(context.rulesetId) ||
      context.rulesetId < 1
    )
      throw Error("writer_not_enabled");
    const self = await readJson(`repos/${policy.repository}/actions/runs/${context.runId}`);
    if (
      self.status !== "in_progress" ||
      self.repository?.id !== policy.repositoryId ||
      self.path !== policy.controllerWorkflowPath ||
      self.event !== "workflow_dispatch" ||
      self.head_branch !== "main" ||
      context.ref !== "refs/heads/main" ||
      self.head_sha !== context.checkoutSha ||
      self.run_attempt !== context.attempt ||
      self.actor.id !== context.actorId ||
      event.sender?.id !== context.actorId
    )
      throw Error("trusted_main_required");
    for (const actor of [{ actor: context.actor, actorId: context.actorId }, request]) {
      const permission = await readJson(
        `repos/${policy.repository}/collaborators/${encodeURIComponent(actor.actor)}/permission`,
      );
      if (
        !["write", "maintain", "admin"].includes(permission.permission) ||
        permission.user.id !== actor.actorId
      )
        throw Error("actor_not_authorized");
    }
    const protection = await readJson(`repos/${policy.repository}/branches/main/protection`);
    if (
      !protection.required_status_checks?.strict ||
      !protection.enforce_admins?.enabled ||
      !protection.required_status_checks.checks?.some(
        (check) =>
          check.context === policy.requiredCheck && check.app_id === policy.requiredCheckAppId,
      ) ||
      protection.required_pull_request_reviews?.bypass_pull_request_allowances?.apps?.some(
        (app) => app.id === policy.appId || app.slug === policy.appSlug,
      )
    )
      throw Error("quality_protection_required");
    const ruleset = await readJson(`repos/${policy.repository}/rulesets/${context.rulesetId}`);
    const bypass = ruleset.bypass_actors;
    if (
      ruleset.id !== context.rulesetId ||
      ruleset.enforcement !== "active" ||
      ruleset.target !== "branch" ||
      JSON.stringify(ruleset.conditions?.ref_name?.include) !==
        JSON.stringify(["refs/heads/main"]) ||
      ruleset.conditions.ref_name.exclude?.length ||
      ruleset.rules?.length !== 1 ||
      ruleset.rules[0].type !== "update" ||
      bypass?.length !== 1 ||
      bypass[0].actor_type !== "Integration" ||
      bypass[0].actor_id !== policy.appId ||
      bypass[0].bypass_mode !== "pull_request"
    )
      throw Error("single_writer_ruleset_required");
  };
  const write = async (operation, request, head) => {
    if (
      !permit ||
      permit.requestId !== request.id ||
      permit.pr !== request.pr ||
      permit.operation !== operation ||
      permit.head !== head ||
      request.repository !== policy.repository ||
      !Number.isSafeInteger(request.pr) ||
      request.pr < 1 ||
      policy.blockedPullRequests.includes(request.pr) ||
      !/^[a-f0-9]{40}$/.test(head)
    )
      throw Error("intent_required");
    const deadline = permit.deadline;
    permit = null;
    let authentication;
    try {
      if (!Number.isFinite(deadline) || signal.aborted || clock.now() >= deadline)
        return { outcome: "failed" };
      await guardWrites(request);
      authentication = await appToken();
      if (signal.aborted || clock.now() >= deadline) return { outcome: "failed" };
    } catch {
      return { outcome: "failed" };
    }
    try {
      const response = await http(
        `repos/${policy.repository}/pulls/${request.pr}/${operation === "update" ? "update-branch" : "merge"}`,
        "PUT",
        authentication,
        operation === "update" ? { expected_head_sha: head } : { sha: head, merge_method: "merge" },
      );
      if (
        (operation === "update" && response.status === 202) ||
        (operation === "merge" && response.status === 200 && response.data.merged === true)
      )
        return { outcome: "accepted", httpStatus: response.status };
      return {
        outcome: [400, 401, 403, 404, 405, 409, 422, 429].includes(response.status)
          ? "failed"
          : "unknown",
        httpStatus: response.status,
      };
    } catch {
      return { outcome: "unknown" };
    }
  };
  return {
    readJson,
    clock,
    signal,
    async identity() {
      const self = await readJson(`repos/${policy.repository}/actions/runs/${context.runId}`);
      if (context.ref !== "refs/heads/main" || self.run_attempt !== context.attempt)
        throw Error("trusted_main_required");
      const owner = {
        runId: self.id,
        attempt: self.run_attempt,
        workflowId: self.workflow_id,
        controllerSha: context.checkoutSha,
      };
      journal = journalFactory({ owner, self, readJson, githubToken, policy });
      return { ...context, self, eventSenderId: event.sender?.id };
    },
    async checkpoint(record, kind) {
      const receipt = await journal.checkpoint(record, kind);
      if (!Number.isSafeInteger(receipt?.id) || receipt.id < 1)
        throw Error("checkpoint_not_acknowledged");
      permit =
        kind === "intent"
          ? {
              requestId: record.request.id,
              pr: record.request.pr,
              operation: record.intent.operation,
              head: record.intent.head,
              deadline: record.state.active.startedAt + policy.budgetMs,
            }
          : null;
      return receipt;
    },
    restore: () => journal.restore(),
    guardWrites,
    update: (request, head) => write("update", request, head),
    merge: (request, head) => write("merge", request, head),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createSerialMergeRuntime } from "./serial-merge-runtime.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function fixture() {
  let now = 1000000;
  let tokens = 0;
  let checkpointDelay = 0;
  const calls = [];
  const overrides = new Map();
  const self = {
    id: 100,
    run_attempt: 1,
    workflow_id: 55,
    path: ".github/workflows/serial-merge.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: "a".repeat(40),
    status: "in_progress",
    repository: { id: 1365221347, full_name: "CleverC2200/dsh-gea-plugin" },
    actor: { id: 42, login: "maintainer", type: "User" },
  };
  const context = {
    controllerWorkflowId: 55,
    runId: 100,
    attempt: 1,
    actor: "maintainer",
    actorId: 42,
    checkoutSha: self.head_sha,
    ref: "refs/heads/main",
    enabled: true,
    appId: 5451618,
    installationId: 174718575,
    rulesetId: 10,
  };
  const response = (data, status = 200) => Response.json(data, { status });
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    calls.push({ path, ...options });
    if (overrides.has(path)) {
      const value = overrides.get(path);
      return response(value.data, value.status);
    }
    if (path === "/app") return response({ id: 5451618, slug: "cleverc2200-gea-serial-merge" });
    if (path === "/app/installations/174718575/access_tokens") {
      tokens++;
      return response(
        { token: "fixture-app-token-" + tokens, expires_at: new Date(now + 300000).toISOString() },
        201,
      );
    }
    if (path.endsWith("/actions/runs/100")) return response(self);
    if (path.endsWith("/branches/main/protection"))
      return response({
        enforce_admins: { enabled: true },
        required_status_checks: {
          strict: true,
          checks: [{ context: "candidate-quality", app_id: 15368 }],
        },
        required_pull_request_reviews: { bypass_pull_request_allowances: { apps: [] } },
      });
    if (path.endsWith("/permission")) return response({ permission: "write", user: { id: 42 } });
    if (path.endsWith("/rulesets/10"))
      return response({
        id: 10,
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: [{ type: "update", parameters: { update_allows_fetch_and_merge: false } }],
        bypass_actors: [
          { actor_type: "Integration", actor_id: 5451618, bypass_mode: "pull_request" },
        ],
      });
    if (options.method === "PUT") return response({ merged: true, sha: "e".repeat(40) });
    return response({ ok: true });
  };
  const journalFactory = () => ({
    checkpoint: async () => {
      now += checkpointDelay;
      return { id: 7 };
    },
    restore: async () => ({ records: [] }),
  });
  const runtime = createSerialMergeRuntime({
    context,
    event: { sender: { id: 42 } },
    githubToken: "fixture-actions-read-token",
    privateKey,
    fetch,
    journalFactory,
    clock: { now: () => now, sleep: async () => {} },
    signal: new AbortController().signal,
  });
  return {
    runtime,
    calls,
    self,
    context,
    overrides,
    delayCheckpoint: (milliseconds) => {
      checkpointDelay = milliseconds;
    },
    advance: () => {
      now += 250000;
    },
  };
}

test("Actions reads use only GITHUB_TOKEN while the four-permission App token refreshes before expiry", async () => {
  const f = fixture();
  await f.runtime.identity();
  await f.runtime.readJson("repos/CleverC2200/dsh-gea-plugin/branches/main/protection");
  f.advance();
  await f.runtime.readJson("repos/CleverC2200/dsh-gea-plugin/branches/main/protection");
  const actions = f.calls.find((call) => call.path.endsWith("/actions/runs/100"));
  assert.equal(actions.headers.authorization, "Bearer fixture-actions-read-token");
  const minted = f.calls.filter((call) => call.path.endsWith("/access_tokens"));
  assert.equal(minted.length, 2);
  assert.deepEqual(JSON.parse(minted[0].body), {
    repositories: ["dsh-gea-plugin"],
    permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      administration: "read",
    },
  });
  assert.equal(f.calls.at(-1).headers.authorization, "Bearer fixture-app-token-2");
});

test("only an acknowledged matching intent permits one allowed repository write", async () => {
  const f = fixture();
  await f.runtime.identity();
  const request = {
    id: "100",
    repository: "CleverC2200/dsh-gea-plugin",
    pr: 300,
    actor: "maintainer",
    actorId: 42,
    base: "main",
    head: "b".repeat(40),
  };
  await assert.rejects(f.runtime.merge(request, request.head), /intent_required/);
  await f.runtime.guardWrites(request);
  const record = {
    schemaVersion: 1,
    request,
    revision: 1,
    state: {
      active: { phase: "reconciling", request, head: request.head, startedAt: 1000000 },
      queue: [],
      finished: [],
    },
    intent: { operation: "merge", head: request.head },
  };
  await f.runtime.checkpoint(record, "intent");
  assert.equal((await f.runtime.merge(request, request.head)).outcome, "accepted");
  await assert.rejects(f.runtime.merge(request, request.head), /intent_required/);
  assert.deepEqual(
    f.calls
      .filter((call) => call.method === "PUT")
      .map((call) => [call.path, JSON.parse(call.body)]),
    [
      [
        "/repos/CleverC2200/dsh-gea-plugin/pulls/300/merge",
        { sha: request.head, merge_method: "merge" },
      ],
    ],
  );
  await assert.rejects(f.runtime.update({ ...request, repository: "other/repo" }, request.head));
  await assert.rejects(f.runtime.update({ ...request, pr: 197 }, request.head));
});

test("the production workflow keeps dispatch SHA checkout and confines private-key input to the main environment action", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/serial-merge.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /ref: main/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: gea-serial-merge/);
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read/);
  assert.match(
    workflow,
    /corepack pnpm --ignore-workspace install --frozen-lockfile --ignore-scripts/,
  );
  assert.match(workflow, /uses: \.\/\.github\/actions\/serial-merge/);
  assert.match(workflow, /app-private-key: \$\{\{ secrets\.GEA_MERGE_APP_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(workflow, /pull_request_target|contents: write|actions: write/);
});

test("changed single-writer rules, quality protection or a cancelled service run prevent an intent from reaching GitHub writes", async () => {
  for (const condition of ["ruleset", "fetch", "quality", "cancelled"]) {
    const f = fixture();
    if (["ruleset", "fetch"].includes(condition))
      f.overrides.set("/repos/CleverC2200/dsh-gea-plugin/rulesets/10", {
        data: {
          id: 10,
          enforcement: "active",
          target: "branch",
          conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
          rules: [
            {
              type: "update",
              parameters: { update_allows_fetch_and_merge: condition === "fetch" },
            },
          ],
          bypass_actors: [
            {
              actor_type: "Integration",
              actor_id: condition === "ruleset" ? 15368 : 5451618,
              bypass_mode: "pull_request",
            },
          ],
        },
      });
    if (condition === "quality")
      f.overrides.set("/repos/CleverC2200/dsh-gea-plugin/branches/main/protection", {
        data: {
          enforce_admins: { enabled: true },
          required_status_checks: {
            strict: true,
            checks: [{ context: "candidate-quality", app_id: 5451618 }],
          },
        },
      });
    if (condition === "cancelled") f.self.status = "completed";
    await f.runtime.identity();
    const request = {
      id: "100",
      repository: "CleverC2200/dsh-gea-plugin",
      pr: 300,
      actor: "maintainer",
      actorId: 42,
    };
    const sha = "b".repeat(40);
    await f.runtime.checkpoint(
      {
        request,
        state: { active: { startedAt: 1000000 } },
        intent: { operation: "merge", head: sha },
      },
      "intent",
    );
    assert.equal((await f.runtime.merge(request, sha)).outcome, "failed");
    assert.equal(
      f.calls.some((call) => call.method === "PUT"),
      false,
    );
  }
});

test("known write rejection releases while a lost or server-error response remains unknown and is never retried", async () => {
  for (const status of [422, 503]) {
    const f = fixture();
    await f.runtime.identity();
    const request = {
      id: "100",
      repository: "CleverC2200/dsh-gea-plugin",
      pr: 300,
      actor: "maintainer",
      actorId: 42,
    };
    const sha = "b".repeat(40);
    f.overrides.set("/repos/CleverC2200/dsh-gea-plugin/pulls/300/update-branch", {
      status,
      data: { message: "fixture" },
    });
    await f.runtime.checkpoint(
      {
        request,
        state: { active: { startedAt: 1000000 } },
        intent: { operation: "update", head: sha },
      },
      "intent",
    );
    assert.equal(
      (await f.runtime.update(request, sha)).outcome,
      status === 422 ? "failed" : "unknown",
    );
    await assert.rejects(f.runtime.update(request, sha), /intent_required/);
    assert.equal(f.calls.filter((call) => call.method === "PUT").length, 1);
  }
});

test("an intent upload that exhausts the active budget cannot cause a late App write", async () => {
  const f = fixture();
  await f.runtime.identity();
  f.delayCheckpoint(2700001);
  const request = {
    id: "100",
    repository: "CleverC2200/dsh-gea-plugin",
    pr: 300,
    actor: "maintainer",
    actorId: 42,
  };
  const head = "b".repeat(40);
  await f.runtime.checkpoint(
    { request, state: { active: { startedAt: 1000000 } }, intent: { operation: "merge", head } },
    "intent",
  );
  assert.equal((await f.runtime.merge(request, head)).outcome, "failed");
  assert.equal(
    f.calls.some((call) => call.method === "PUT"),
    false,
  );
});

test("recreating the controller workflow cannot silently replace the frozen history identity", async () => {
  const f = fixture();
  f.self.workflow_id = 56;
  await assert.rejects(f.runtime.identity(), /controller_workflow_mismatch/);
  assert.equal(
    f.calls.some((call) => call.method === "PUT"),
    false,
  );
});

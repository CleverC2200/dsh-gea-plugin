import { createSerialMergeArtifacts } from "../../../scripts/serial-merge-artifacts.mjs";

const repository = "CleverC2200/dsh-gea-plugin";
const branch = "codex/gea-ci-s1-artifact-probe-20261024";
const workflow = ".github/workflows/serial-merge-artifact-probe.yml";
const token = process.env.GITHUB_TOKEN;
const runId = Number(process.env.GITHUB_RUN_ID);
const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
if (
  process.env.GITHUB_REPOSITORY !== repository ||
  process.env.GITHUB_REF !== "refs/heads/" + branch ||
  process.env.GITHUB_EVENT_NAME !== "push" ||
  !token ||
  !process.env.RUNNER_TEMP
)
  throw Error("artifact_probe_scope_required");

const readJson = async (endpoint) => {
  if (!endpoint.startsWith(`repos/${repository}/actions/`))
    throw Error("artifact_probe_endpoint_rejected");
  const response = await fetch("https://api.github.com/" + endpoint, {
    headers: {
      authorization: "Bearer " + token,
      accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("artifact_probe_read_failed: " + response.status);
  return response.json();
};
const self = await readJson(`repos/${repository}/actions/runs/${runId}/attempts/${attempt}`);
if (
  self.id !== runId ||
  self.run_attempt !== attempt ||
  self.path !== workflow ||
  self.head_sha !== process.env.GITHUB_SHA ||
  self.head_branch !== branch ||
  self.event !== "push" ||
  self.repository?.id !== 1365221347 ||
  self.head_repository?.id !== 1365221347
)
  throw Error("artifact_probe_identity_mismatch");

const { DefaultArtifactClient } =
  await import("../serial-merge/node_modules/@actions/artifact/lib/artifact.js");
const owner = { runId, attempt, workflowId: self.workflow_id, controllerSha: self.head_sha };
const store = createSerialMergeArtifacts({
  artifact: new DefaultArtifactClient(),
  readJson,
  githubToken: token,
  directory: process.env.RUNNER_TEMP,
  owner,
  policy: {
    repository,
    repositoryId: 1365221347,
    controllerWorkflowPath: workflow,
    controllerWorkflowId: self.workflow_id,
    retentionDays: 30,
    maxHistoryRuns: 1000,
  },
  controllerBranch: branch,
  controllerEvent: "push",
});
const request = (process.env.INPUT_REQUEST ?? "").split("\n")[0].trim();
const previous = /^serial-artifact-read:([1-9]\d*)$/.exec(request);
if (
  request.startsWith("serial-artifact-read:") &&
  (!previous || !Number.isSafeInteger(Number(previous[1])))
)
  throw Error("artifact_probe_previous_run_required");
if (previous) {
  const { records } = await store.restore();
  const record = records.find((item) => item.request.id === previous[1]);
  if (
    !record ||
    record.owner.runId !== Number(previous[1]) ||
    record.revision !== 1 ||
    record.state.active?.phase !== "updating" ||
    record.intent?.operation !== "update"
  )
    throw Error("artifact_probe_previous_checkpoint_missing");
  const terminal = {
    ...record,
    revision: record.revision + 1,
    state: {
      queue: [],
      active: null,
      finished: [{ request: record.request, reason: "artifact_probe_complete" }],
    },
  };
  const receipt = await store.checkpoint(terminal, "terminal");
  console.log(
    JSON.stringify({
      mode: "read",
      previousRunId: Number(previous[1]),
      previousControllerSha: record.owner.controllerSha,
      owner,
      revision: terminal.revision,
      artifactId: receipt.id,
    }),
  );
} else {
  const head = self.head_sha;
  const request = {
    id: String(runId),
    repository,
    pr: 1,
    head,
    base: "main",
    actor: self.actor.login,
    actorId: self.actor.id,
    enqueuedAt: Date.now(),
    sourceBranch: branch,
    pullId: 1,
  };
  const record = {
    schemaVersion: 1,
    request,
    owner,
    revision: 1,
    probe: true,
    state: {
      queue: [],
      active: { request, phase: "updating", head, base: head, startedAt: Date.now() },
      finished: [],
    },
    intent: { operation: "update", head, base: head, at: Date.now(), beforeRuns: [] },
  };
  const receipt = await store.checkpoint(record, "intent");
  console.log(
    JSON.stringify({ mode: "write", owner, revision: record.revision, artifactId: receipt.id }),
  );
}

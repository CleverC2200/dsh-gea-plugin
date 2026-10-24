import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  lstatSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";

const artifactName =
  /^gea-serial-([1-9]\d*)-([1-9]\d*)-([1-9]\d*)-([1-9]\d*)-(intent|state|terminal)$/;
const validId = (value) => Number.isSafeInteger(value) && value > 0;
const fullSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function createSerialMergeArtifacts({
  artifact,
  readJson,
  githubToken,
  directory,
  owner,
  policy,
  controllerBranch = "main",
  controllerEvent = "workflow_dispatch",
  now = Date.now,
}) {
  const repository = policy.repository;
  const base = `repos/${repository}/actions`;
  const prefix = base + "/artifacts/";
  const retentionDays = policy.retentionDays;
  const [repositoryOwner, repositoryName] = repository.split("/");
  const root = resolve(directory);
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !validId(policy.repositoryId) ||
    !validId(policy.maxHistoryRuns) ||
    policy.maxHistoryRuns > 1000 ||
    !validId(retentionDays) ||
    !validId(owner?.runId) ||
    !validId(owner.attempt) ||
    !validId(owner.workflowId) ||
    (policy.controllerWorkflowId !== undefined &&
      policy.controllerWorkflowId !== owner.workflowId) ||
    !fullSha(owner.controllerSha) ||
    !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(policy.controllerWorkflowPath)
  )
    throw Error("invalid_artifact_policy");
  mkdirSync(root, { recursive: true });
  const trustedRun = (run) => {
    if (
      !validId(run?.id) ||
      !validId(run.run_attempt) ||
      run.workflow_id !== owner.workflowId ||
      run.path !== policy.controllerWorkflowPath ||
      run.head_branch !== controllerBranch ||
      run.event !== controllerEvent ||
      run.repository?.id !== policy.repositoryId ||
      run.repository.full_name !== repository ||
      run.head_repository?.id !== policy.repositoryId ||
      !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")
    )
      throw Error("untrusted_controller_run");
    return run;
  };
  const attempts = new Map();
  const attempt = async (id, number) => {
    const key = id + "/" + number;
    if (!attempts.has(key)) attempts.set(key, readJson(`${base}/runs/${id}/attempts/${number}`));
    const run = trustedRun(await attempts.get(key));
    if (run.id !== id || run.run_attempt !== number) throw Error("controller_attempt_mismatch");
    return run;
  };
  const validMetadata = (metadata, host) =>
    metadata &&
    validId(metadata.id) &&
    metadata.expired === false &&
    validId(metadata.size_in_bytes) &&
    /^sha256:[a-f0-9]{64}$/.test(metadata.digest ?? "") &&
    Number.isFinite(Date.parse(metadata.created_at)) &&
    Date.parse(metadata.expires_at) > Math.max(now(), Date.parse(metadata.created_at)) &&
    metadata.workflow_run?.id === host.id &&
    metadata.workflow_run.repository_id === policy.repositoryId &&
    metadata.workflow_run.head_repository_id === policy.repositoryId &&
    metadata.workflow_run.head_branch === controllerBranch &&
    metadata.workflow_run.head_sha === host.head_sha;
  const list = async (path, key) => {
    const values = [],
      seen = new Set();
    let total;
    for (let page = 1; ; page++) {
      const data = await readJson(`${path}?per_page=100&page=${page}`);
      if (
        !Number.isSafeInteger(data.total_count) ||
        data.total_count < 0 ||
        data.total_count > policy.maxHistoryRuns ||
        !Array.isArray(data[key]) ||
        (total !== undefined && total !== data.total_count)
      )
        throw Error("history_incomplete");
      total = data.total_count;
      for (const item of data[key]) {
        if (!validId(item.id) || seen.has(item.id)) throw Error("history_ambiguous");
        seen.add(item.id);
        values.push(item);
      }
      if (values.length === total) return values;
      if (!data[key].length || values.length > total) throw Error("history_incomplete");
    }
  };
  const neverStarted = async (id, number) => {
    const run = await attempt(id, number);
    const skipped = run.status === "completed" && run.conclusion === "skipped";
    const queued =
      ["queued", "requested", "pending", "waiting"].includes(run.status) && run.conclusion === null;
    if (!skipped && !queued) return false;
    const jobs = await list(`${base}/runs/${id}/attempts/${number}/jobs`, "jobs");
    return (
      (queued || jobs.length > 0) &&
      jobs.every(
        (job) =>
          job.runner_id === null &&
          Array.isArray(job.steps) &&
          job.steps.length === 0 &&
          (skipped
            ? job.status === "completed" && job.conclusion === "skipped"
            : ["queued", "requested", "pending", "waiting"].includes(job.status) &&
              job.conclusion === null),
      )
    );
  };
  const validate = (record, kind) => {
    const request = record?.request;
    const state = record?.state;
    const noWrite = record?.noWrite === true;
    const identity = noWrite
      ? ["id", "repository", "actor", "actorId"]
      : [
          "id",
          "repository",
          "pr",
          "head",
          "base",
          "actor",
          "actorId",
          "enqueuedAt",
          "sourceBranch",
          "pullId",
        ];
    const sameRequest = (item) => item && identity.every((key) => item[key] === request[key]);
    if (
      record?.schemaVersion !== 1 ||
      typeof request?.id !== "string" ||
      !/^[1-9]\d*$/.test(request.id) ||
      !validId(Number(request.id)) ||
      request.repository !== repository ||
      typeof request.actor !== "string" ||
      !request.actor ||
      !validId(request.actorId) ||
      !validId(record.revision) ||
      !validId(record.owner?.runId) ||
      !validId(record.owner?.attempt) ||
      !validId(record.owner?.workflowId) ||
      !fullSha(record.owner?.controllerSha) ||
      !["intent", "state", "terminal"].includes(kind) ||
      !Array.isArray(state?.queue) ||
      !Array.isArray(state?.finished) ||
      !state.queue.every(sameRequest) ||
      !state.finished.every(
        (item) => sameRequest(item.request) && typeof item.reason === "string" && item.reason,
      ) ||
      (state.active !== null &&
        (!sameRequest(state.active?.request) ||
          !["queued", "updating", "checking", "reconciling"].includes(state.active.phase) ||
          !fullSha(state.active.head) ||
          !fullSha(state.active.base) ||
          !Number.isFinite(state.active.startedAt))) ||
      (kind === "terminal" &&
        (state.active !== null || state.queue.length || !state.finished.length))
    )
      throw Error("invalid_checkpoint");
    if (noWrite) {
      if (
        kind !== "terminal" ||
        record.intent ||
        Object.keys(request).some((key) => !identity.includes(key))
      )
        throw Error("invalid_checkpoint");
    } else if (
      !validId(request.pr) ||
      !fullSha(request.head) ||
      request.base !== "main" ||
      !validId(request.pullId) ||
      !Number.isFinite(request.enqueuedAt) ||
      typeof request.sourceBranch !== "string" ||
      !request.sourceBranch ||
      /[\0\r\n]/.test(request.sourceBranch)
    )
      throw Error("invalid_checkpoint");
    if (
      record.intent &&
      (!fullSha(record.intent.head) ||
        !fullSha(record.intent.base) ||
        !["update", "merge"].includes(record.intent.operation) ||
        !Number.isFinite(record.intent.at) ||
        !Array.isArray(record.intent.beforeRuns) ||
        !record.intent.beforeRuns.every(validId))
    )
      throw Error("invalid_checkpoint");
    const active = state.active;
    if (
      active &&
      ((active.outcome !== undefined &&
        !["accepted", "unknown", "failed"].includes(active.outcome)) ||
        (!record.intent &&
          active.outcome !== "failed" &&
          (["updating", "reconciling"].includes(active.phase) || active.outcome !== undefined)) ||
        (record.intent &&
          (record.intent.operation === "merge"
            ? active.phase !== "reconciling"
            : !["updating", "checking"].includes(active.phase))))
    )
      throw Error("invalid_checkpoint");
    if (
      kind === "intent" &&
      (!record.intent ||
        state.active?.phase !==
          (record.intent.operation === "update" ? "updating" : "reconciling") ||
        active.head !== record.intent.head ||
        active.base !== record.intent.base)
    )
      throw Error("invalid_checkpoint");
  };
  const store = {
    async save(record, kind) {
      const checkpoint = { ...record, owner };
      validate(checkpoint, kind);
      const host = await attempt(owner.runId, owner.attempt);
      if (host.head_sha !== owner.controllerSha) throw Error("controller_sha_mismatch");
      const name = `gea-serial-${record.request.id}-${record.revision}-${owner.runId}-${owner.attempt}-${kind}`;
      const temporary = mkdtempSync(join(root, "upload-"));
      try {
        const file = join(temporary, "state.json");
        const bytes = JSON.stringify(checkpoint);
        if (Buffer.byteLength(bytes) > 131072) throw Error("checkpoint_too_large");
        writeFileSync(file, bytes, { mode: 0o600 });
        const uploaded = await artifact.uploadArtifact(name, [file], temporary, {
          retentionDays,
          compressionLevel: 0,
        });
        if (!Number.isSafeInteger(uploaded.id) || uploaded.id < 1)
          throw Error("checkpoint_not_uploaded");
        const remote = await readJson(prefix + uploaded.id);
        if (
          !validMetadata(remote, host) ||
          remote.id !== uploaded.id ||
          remote.name !== name ||
          remote.digest !== "sha256:" + uploaded.digest ||
          remote.size_in_bytes !== uploaded.size
        )
          throw Error("checkpoint_not_acknowledged");
        return { id: remote.id, name, digest: remote.digest ?? null };
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
    async read(metadata) {
      if (
        !Number.isSafeInteger(metadata.id) ||
        metadata.id < 1 ||
        metadata.expired ||
        !Number.isSafeInteger(metadata.workflow_run?.id)
      )
        throw Error("checkpoint_not_readable");
      const remote = await readJson(prefix + metadata.id);
      const match = artifactName.exec(remote?.name ?? "");
      if (
        !match ||
        !match.slice(1, 5).every((value) => validId(Number(value))) ||
        remote.id !== metadata.id ||
        remote.name !== metadata.name ||
        remote.workflow_run?.id !== metadata.workflow_run.id
      )
        throw Error("checkpoint_not_readable");
      const host = await attempt(Number(match[3]), Number(match[4]));
      if (!validMetadata(remote, host)) throw Error("checkpoint_not_readable");
      const temporary = mkdtempSync(join(root, "download-"));
      try {
        const downloaded = await artifact.downloadArtifact(remote.id, {
          path: temporary,
          expectedHash: remote.digest.replace(/^sha256:/, ""),
          findBy: {
            token: githubToken,
            workflowRunId: remote.workflow_run.id,
            repositoryOwner,
            repositoryName,
          },
        });
        if (downloaded?.digestMismatch !== false) throw Error("checkpoint_digest_mismatch");
        if (downloaded.downloadPath !== temporary || readdirSync(temporary).join() !== "state.json")
          throw Error("invalid_checkpoint_file");
        const file = join(temporary, "state.json");
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072)
          throw Error("invalid_checkpoint_file");
        const record = JSON.parse(readFileSync(file, "utf8"));
        if (
          !match ||
          record.schemaVersion !== 1 ||
          record.request?.id !== match[1] ||
          record.revision !== Number(match[2]) ||
          record.owner?.runId !== Number(match[3]) ||
          record.owner.attempt !== Number(match[4]) ||
          record.owner.runId !== remote.workflow_run.id ||
          !/^[a-f0-9]{40}$/.test(record.owner.controllerSha ?? "") ||
          (match[5] === "terminal" && record.state?.active)
        )
          throw Error("invalid_checkpoint");
        if (
          record.owner.controllerSha !== host.head_sha ||
          record.owner.workflowId !== host.workflow_id
        )
          throw Error("invalid_checkpoint");
        validate(record, match[5]);
        return record;
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
    async restore() {
      const self = await attempt(owner.runId, owner.attempt);
      if (self.head_sha !== owner.controllerSha) throw Error("controller_sha_mismatch");
      const latest = new Map();
      const revisions = new Set();
      const runs = await list(`${base}/workflows/${owner.workflowId}/runs`, "workflow_runs");
      if (!runs.some((run) => run.id === owner.runId)) runs.push(self);
      for (const candidate of runs) {
        if (typeof candidate.head_branch !== "string" || typeof candidate.event !== "string")
          throw Error("history_incomplete");
        if (candidate.head_branch !== controllerBranch || candidate.event !== controllerEvent)
          continue;
        const run = trustedRun(candidate.id === owner.runId ? self : candidate);
        if (run.run_attempt > policy.maxHistoryRuns) throw Error("history_incomplete");
        const uploaded = (await list(`${base}/runs/${run.id}/artifacts`, "artifacts")).filter(
          (item) => item.name.startsWith("gea-serial-"),
        );
        const covered = new Set();
        for (const metadata of uploaded) {
          const match = artifactName.exec(metadata.name);
          if (
            !match ||
            !match.slice(1, 5).every((value) => validId(Number(value))) ||
            Number(match[3]) !== run.id ||
            Number(match[4]) > run.run_attempt ||
            metadata.workflow_run?.id !== run.id
          )
            throw Error("invalid_checkpoint");
          const host = await attempt(run.id, Number(match[4]));
          if (
            metadata.workflow_run.repository_id !== policy.repositoryId ||
            metadata.workflow_run.head_repository_id !== policy.repositoryId ||
            metadata.workflow_run.head_branch !== controllerBranch ||
            metadata.workflow_run.head_sha !== host.head_sha
          )
            throw Error("invalid_checkpoint");
          covered.add(Number(match[4]));
          const identity = match[1] + "/" + match[2];
          if (revisions.has(identity)) throw Error("checkpoint_ambiguous");
          revisions.add(identity);
          const previous = latest.get(match[1]);
          if (!previous || previous.revision < Number(match[2]))
            latest.set(match[1], { revision: Number(match[2]), metadata });
        }
        for (let number = 1; number <= run.run_attempt; number++) {
          if (covered.has(number) || (run.id === owner.runId && number === owner.attempt)) continue;
          if (!(await neverStarted(run.id, number))) throw Error("checkpoint_missing");
        }
      }
      const records = [];
      for (const item of latest.values()) records.push(await store.read(item.metadata));
      return { records };
    },
  };
  store.checkpoint = store.save;
  return store;
}

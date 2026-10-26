import { isDeepStrictEqual, parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import policy from "./serial-merge-policy.json" with { type: "json" };

const requireValue = (value, reason) => {
  if (!value) throw Error("SOURCE_FORMAL_RECEIPT_REJECTED: " + reason);
};
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const same = isDeepStrictEqual;
function validateContext(context) {
  requireValue(
    context?.repository === policy.repository &&
      context.repositoryId === policy.repositoryId &&
      /^[\w.-]+\/[\w.-]+$/.test(context.sourceRepository ?? "") &&
      positive(context.sourceRepositoryId) &&
      positive(context.pr) &&
      positive(context.runId) &&
      positive(context.runAttempt) &&
      sha(context.head) &&
      sha(context.base) &&
      sha(context.diffBase) &&
      context.target === "main" &&
      typeof context.branch === "string" &&
      context.branch.length > 0,
    "current pull request inputs",
  );
}
function validatePlan(context, plan, matrix) {
  requireValue(
    plan?.head === context.head &&
      plan.base === context.diffBase &&
      ["docs", "resources", "code"].includes(plan.mode) &&
      plan.engineering === (plan.mode === "code") &&
      plan["dependency-review"] === (plan.mode === "code") &&
      Array.isArray(plan.files) &&
      plan.files.every((file) => typeof file === "string" && file.length > 0) &&
      typeof matrix?.parallel === "boolean" &&
      same(matrix.shards, matrix.parallel ? ["1", "2"] : ["single"]) &&
      (!matrix.parallel || plan.engineering),
    "formal plan and worker assignment",
  );
}
export function recordSourceInput({ context, plan, matrix, validate }) {
  validateContext(context);
  requireValue(validate === "true", "metadata cannot record formal inputs");
  validatePlan(context, plan, matrix);
  return {
    schemaVersion: 1,
    workflowId: policy.sourceWorkflowId,
    workflowPath: policy.sourceWorkflowPath,
    context,
    plan,
    matrix,
  };
}
const prefix = `/repos/${policy.repository}/actions`;
const pending = new Set(["queued", "requested", "pending", "in_progress", "waiting"]);
const stepResult = (job, name) => {
  const steps = job?.steps?.filter((step) => step.name === name);
  requireValue(steps?.length === 1, "missing or duplicate formal step: " + name);
  return steps[0].status === "completed" ? steps[0].conclusion : null;
};
async function pages(read, path, key) {
  const items = [];
  let total;
  for (let page = 1; total === undefined || items.length < total; page++) {
    const body = await read(path + `${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    requireValue(
      positive(body?.total_count + 1) &&
        body.total_count <= 1000 &&
        Array.isArray(body[key]) &&
        body[key].length <= 100 &&
        (total === undefined || body.total_count === total),
      "incomplete pagination",
    );
    total ??= body.total_count;
    requireValue(body[key].length === Math.min(100, total - items.length), "incomplete pagination");
    items.push(...body[key]);
  }
  requireValue(
    new Set(items.map((item) => item.id)).size === items.length &&
      items.every((item) => positive(item.id)),
    "duplicate or invalid API item",
  );
  return items;
}
function bindRun(run, context) {
  requireValue(
    positive(run?.id) &&
      positive(run.run_attempt) &&
      run.workflow_id === policy.sourceWorkflowId &&
      run.path === policy.sourceWorkflowPath &&
      run.repository?.full_name === context.repository &&
      run.repository.id === context.repositoryId &&
      run.head_repository?.full_name === context.sourceRepository &&
      run.head_repository.id === context.sourceRepositoryId &&
      run.event === "pull_request" &&
      run.head_sha === context.head &&
      run.head_branch === context.branch &&
      Number.isFinite(Date.parse(run.created_at)),
    "run identity",
  );
  const prs = run.pull_requests?.filter((pr) => pr.number === context.pr);
  requireValue(
    prs?.length === 1 &&
      prs[0].head?.sha === context.head &&
      prs[0].head.ref === context.branch &&
      prs[0].head.repo?.id === context.sourceRepositoryId &&
      prs[0].base?.repo?.id === context.repositoryId,
    "pull request identity",
  );
  return prs[0];
}
async function readJobs(read, run, context) {
  const jobs = await pages(
    read,
    `${prefix}/runs/${run.id}/attempts/${run.run_attempt}/jobs`,
    "jobs",
  );
  requireValue(
    jobs.every(
      (job) =>
        job.run_id === run.id &&
        job.run_attempt === run.run_attempt &&
        job.head_sha === context.head &&
        typeof job.name === "string",
    ),
    "job identity",
  );
  requireValue(new Set(jobs.map((job) => job.name)).size === jobs.length, "duplicate job");
  return jobs;
}
function classification(run, jobs) {
  const plans = jobs.filter((job) => job.name === "source-plan");
  requireValue(plans.length <= 1, "duplicate source plan");
  if (!plans.length || !plans[0].steps?.length) {
    requireValue(pending.has(run.status), "formal source is unknown");
    return "pending";
  }
  const plan = plans[0];
  const admission = stepResult(plan, "Admit source input changes");
  const classify = stepResult(plan, "Classify actual Git changes");
  if (
    admission === "success" &&
    classify === "skipped" &&
    plan.status === "completed" &&
    plan.conclusion === "success"
  )
    return "metadata";
  if (classify && classify !== "skipped") return "formal";
  requireValue(pending.has(run.status), "formal source is unknown");
  return "pending";
}
async function inspect({ context, read }) {
  validateContext(context);
  const current = await read(`${prefix}/runs/${context.runId}`);
  const currentPr = bindRun(current, context);
  requireValue(
    current.id === context.runId &&
      current.run_attempt === context.runAttempt &&
      currentPr.base.sha === context.base &&
      currentPr.base.ref === context.target,
    "current metadata input changed",
  );
  requireValue(
    classification(current, await readJobs(read, current, context)) === "metadata",
    "current run is not admitted metadata",
  );
  const runs = await pages(
    read,
    `${prefix}/workflows/${policy.sourceWorkflowId}/runs?event=pull_request&head_sha=${context.head}`,
    "workflow_runs",
  );
  requireValue(
    runs.some((run) => run.id === context.runId),
    "current run missing from history",
  );
  requireValue(
    runs.every(
      (run) =>
        Number.isFinite(Date.parse(run.created_at)) &&
        run.workflow_id === policy.sourceWorkflowId &&
        run.path === policy.sourceWorkflowPath &&
        run.event === "pull_request" &&
        run.head_sha === context.head &&
        Array.isArray(run.pull_requests),
    ),
    "workflow history identity",
  );
  runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const listed of runs) {
    if (listed.id === context.runId) continue;
    if (!listed.pull_requests.some((pr) => pr.number === context.pr)) {
      requireValue(listed.pull_requests.length > 0, "history pull request missing");
      continue;
    }
    const run = await read(`${prefix}/runs/${listed.id}`);
    requireValue(
      run?.id === listed.id && run.created_at === listed.created_at,
      "substituted formal run",
    );
    const pr = bindRun(run, context);
    const jobs = await readJobs(read, run, context);
    const kind = classification(run, jobs);
    if (kind === "metadata") continue;
    if (kind === "pending" || pending.has(run.status)) return null;
    requireValue(
      run.status === "completed" && run.conclusion === "success",
      "latest formal run did not succeed",
    );
    requireValue(
      pr.base.sha === context.base && pr.base.ref === context.target,
      "formal base or target changed",
    );
    requireValue(
      jobs.every((job) => job.status === "completed"),
      "formal jobs incomplete",
    );
    const gate = jobs.find((job) => job.name === "candidate-quality");
    requireValue(
      gate?.conclusion === "success" &&
        stepResult(gate, "Require successful applicable checks") === "success",
      "formal admission missing",
    );
    const artifacts = await pages(read, `${prefix}/runs/${run.id}/artifacts`, "artifacts");
    const matches = artifacts.filter(
      (artifact) => artifact.name === `source-inputs-${run.run_attempt}`,
    );
    requireValue(
      matches.length === 1 &&
        matches[0].expired === false &&
        positive(matches[0].size_in_bytes) &&
        matches[0].size_in_bytes <= 1048576,
      "formal input artifact missing",
    );
    const artifact = matches[0],
      owner = artifact.workflow_run;
    requireValue(
      owner?.id === run.id &&
        owner.repository_id === context.repositoryId &&
        owner.head_repository_id === context.sourceRepositoryId &&
        owner.head_sha === context.head &&
        owner.head_branch === context.branch,
      "artifact identity",
    );
    return {
      selection: {
        schemaVersion: 1,
        context,
        runId: run.id,
        runAttempt: run.run_attempt,
        artifactId: artifact.id,
        artifactName: artifact.name,
      },
      jobs,
    };
  }
  throw Error("SOURCE_FORMAL_RECEIPT_REJECTED: no formal source");
}
export async function lookupFormalSource({
  context,
  read,
  now = () => performance.now(),
  pause = (ms) => new Promise((done) => setTimeout(done, ms)),
  timeoutMs = 4200000,
  intervalMs = 15000,
}) {
  requireValue(
    typeof read === "function" && positive(timeoutMs) && positive(intervalMs),
    "lookup inputs",
  );
  const deadline = now() + timeoutMs;
  while (true) {
    const found = await inspect({ context, read });
    if (found) return found.selection;
    const remaining = deadline - now();
    requireValue(remaining > 0, "formal wait timeout");
    await pause(Math.min(intervalMs, remaining));
    requireValue(now() < deadline, "formal wait timeout");
  }
}
export async function verifyFormalSource({ context, selection, receipt, read }) {
  validateContext(context);
  requireValue(
    receipt?.schemaVersion === 1 &&
      receipt.workflowId === policy.sourceWorkflowId &&
      receipt.workflowPath === policy.sourceWorkflowPath &&
      selection?.schemaVersion === 1 &&
      same(selection.context, context) &&
      same(receipt.context, {
        ...context,
        runId: selection.runId,
        runAttempt: selection.runAttempt,
      }),
    "receipt identity",
  );
  validatePlan(context, receipt.plan, receipt.matrix);
  const fresh = await inspect({ context, read });
  requireValue(fresh && same(fresh.selection, selection), "formal source changed after lookup");
  const skippedWorker =
    "matrix.shard == 'single' && 'source-checks' || format('source-checks ({0})', matrix.shard)";
  const expected = new Map([
    ["source-plan", "success"],
    ["candidate-quality", "success"],
    ["dependency-review", receipt.plan["dependency-review"] ? "success" : "skipped"],
    ...(receipt.plan.mode === "docs"
      ? [[skippedWorker, "skipped"]]
      : receipt.matrix.shards.map((id) => [
          id === "single" ? "source-checks" : `source-checks (${id})`,
          "success",
        ])),
  ]);
  requireValue(
    fresh.jobs.length === expected.size &&
      fresh.jobs.every(
        (job) => expected.get(job.name) === job.conclusion && job.status === "completed",
      ),
    "formal job coverage",
  );
  const sourcePlan = fresh.jobs.find((job) => job.name === "source-plan");
  for (const name of [
    "Admit source input changes",
    "Classify actual Git changes",
    "Record formal source inputs",
    "Keep formal source input receipt",
  ])
    requireValue(stepResult(sourcePlan, name) === "success", "formal input not recorded");
  if (receipt.matrix.parallel)
    requireValue(
      stepResult(
        fresh.jobs.find((job) => job.name === "candidate-quality"),
        "Require complete source-check execution",
      ) === "success",
      "formal worker aggregation missing",
    );
  return { verified: true, runId: selection.runId, runAttempt: selection.runAttempt };
}

async function readGitHub(path) {
  requireValue(path.startsWith(prefix + "/"), "read endpoint");
  let response;
  try {
    response = await fetch(new URL(path, "https://api.github.com"), {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: "Bearer " + process.env.GITHUB_TOKEN,
      },
    });
  } catch {
    throw Error("SOURCE_FORMAL_RECEIPT_API_READ_FAILED");
  }
  requireValue(response.ok, "API read failed: " + response.status);
  try {
    return await response.json();
  } catch {
    throw Error("SOURCE_FORMAL_RECEIPT_API_RESPONSE_REQUIRED");
  }
}
function currentContext() {
  requireValue(
    process.env.GITHUB_EVENT_NAME === "pull_request" &&
      process.env.GITHUB_REPOSITORY === policy.repository,
    "PR workflow required",
  );
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const context = {
    repository: event.repository?.full_name,
    repositoryId: event.repository?.id,
    sourceRepository: pr?.head?.repo?.full_name,
    sourceRepositoryId: pr?.head?.repo?.id,
    pr: event.number,
    head: pr?.head?.sha,
    base: pr?.base?.sha,
    diffBase: git("merge-base", pr.base.sha, pr.head.sha),
    target: pr?.base?.ref,
    branch: pr?.head?.ref,
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  };
  validateContext(context);
  requireValue(git("rev-parse", "HEAD") === context.head, "checkout head changed");
  return context;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: {
        phase: { type: "string" },
        plan: { type: "string" },
        output: { type: "string" },
        selection: { type: "string" },
        receipt: { type: "string" },
      },
    });
    const context = currentContext();
    const json = (file) => JSON.parse(readFileSync(file, "utf8"));
    let result;
    if (values.phase === "record") {
      requireValue(
        ["true", "false"].includes(process.env.SOURCE_MATRIX_PARALLEL),
        "matrix output required",
      );
      result = recordSourceInput({
        context,
        plan: json(values.plan),
        matrix: {
          parallel: process.env.SOURCE_MATRIX_PARALLEL === "true",
          shards: JSON.parse(process.env.SOURCE_MATRIX_SHARDS),
        },
        validate: process.env.SOURCE_EVENT_VALIDATE,
      });
    } else if (values.phase === "lookup") {
      requireValue(process.env.GITHUB_TOKEN, "read token required");
      result = await lookupFormalSource({ context, read: readGitHub });
      requireValue(process.env.GITHUB_OUTPUT, "workflow lookup outputs required");
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `run-id=${result.runId}\nrun-attempt=${result.runAttempt}\nartifact-id=${result.artifactId}\nartifact-name=${result.artifactName}\n`,
      );
    } else if (values.phase === "verify") {
      requireValue(process.env.GITHUB_TOKEN, "read token required");
      result = await verifyFormalSource({
        context,
        selection: json(values.selection),
        receipt: json(values.receipt),
        read: readGitHub,
      });
    } else throw Error("SOURCE_FORMAL_RECEIPT_PHASE_REQUIRED");
    if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

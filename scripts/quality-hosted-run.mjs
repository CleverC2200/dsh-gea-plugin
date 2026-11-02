export async function readHostedRun({
  repository,
  runId,
  runAttempt,
  headSha,
  token,
  apiBase = "https://api.github.com",
  perPage = 100,
  jobFilter = "attempt",
}) {
  const base = new URL(apiBase);
  if (
    (base.origin !== "https://api.github.com" &&
      !(
        base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    repository.split("/").some((part) => [".", ".."].includes(part)) ||
    !Number.isSafeInteger(Number(runId)) ||
    Number(runId) < 1 ||
    !Number.isSafeInteger(Number(runAttempt)) ||
    Number(runAttempt) < 1 ||
    !/^[a-f0-9]{40}$/.test(headSha) ||
    !["attempt", "latest"].includes(jobFilter) ||
    !Number.isInteger(perPage) ||
    perPage < 1 ||
    perPage > 100
  )
    throw Error("HOSTED_API_INPUT_REQUIRED");
  const expected = { repository, runId: Number(runId), runAttempt: Number(runAttempt), headSha };
  const prefix = `/repos/${repository}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`;
  const get = async (path) => {
    let response;
    try {
      response = await fetch(new URL(path, base), {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
      });
    } catch {
      throw Error("HOSTED_API_READ_FAILED");
    }
    if (!response.ok) throw Error("HOSTED_API_READ_FAILED: " + response.status);
    try {
      return await response.json();
    } catch {
      throw Error("HOSTED_API_RESPONSE_REQUIRED");
    }
  };
  const run = await get(prefix);
  const jobs = [];
  const jobsPrefix =
    jobFilter === "latest" ? `/repos/${repository}/actions/runs/${expected.runId}` : prefix;
  let totalCount, pageCount;
  for (let page = 1; page === 1 || page <= pageCount; page++) {
    const body = await get(
      jobsPrefix +
        `/jobs?per_page=${perPage}&page=${page}${jobFilter === "latest" ? "&filter=latest" : ""}`,
    );
    if (
      !body ||
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 0 ||
      !Array.isArray(body.jobs) ||
      body.jobs.length > perPage ||
      (totalCount !== undefined && body.total_count !== totalCount)
    )
      throw Error("HOSTED_JOBS_INCOMPLETE");
    totalCount ??= body.total_count;
    pageCount ??= Math.max(1, Math.ceil(totalCount / perPage));
    jobs.push(...body.jobs);
  }
  const snapshot = {
    schemaVersion: 1,
    expected,
    ...(jobFilter === "latest" ? { jobFilter } : {}),
    run,
    jobs,
    observedAt: new Date().toISOString(),
    pagination: { complete: jobs.length === totalCount, totalCount, pageCount, perPage },
  };
  verifyHostedSnapshot(snapshot);
  return snapshot;
}

export function verifyHostedSnapshot(snapshot) {
  const { expected, run, jobs, pagination } = snapshot ?? {};
  if (
    snapshot?.schemaVersion !== 1 ||
    !expected ||
    !run ||
    !Number.isSafeInteger(expected.runId) ||
    !Number.isSafeInteger(expected.runAttempt) ||
    !/^[a-f0-9]{40}$/.test(expected.headSha) ||
    run.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.head_sha !== expected.headSha ||
    (run.repository?.full_name &&
      run.repository.full_name.toLowerCase() !== expected.repository.toLowerCase())
  )
    throw Error("HOSTED_INPUT_MISMATCH");
  if (
    !Array.isArray(jobs) ||
    !pagination ||
    pagination.complete !== true ||
    !Number.isSafeInteger(pagination.totalCount) ||
    pagination.totalCount < 0 ||
    jobs.length !== pagination.totalCount ||
    !Number.isInteger(pagination.perPage) ||
    pagination.perPage < 1 ||
    pagination.perPage > 100 ||
    pagination.pageCount !== Math.max(1, Math.ceil(pagination.totalCount / pagination.perPage)) ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length
  )
    throw Error("HOSTED_JOBS_INCOMPLETE");
  for (const job of jobs)
    if (
      !Number.isSafeInteger(job.id) ||
      job.id < 1 ||
      job.run_id !== expected.runId ||
      (snapshot.jobFilter === "latest"
        ? !Number.isSafeInteger(job.run_attempt) ||
          job.run_attempt < 1 ||
          job.run_attempt > expected.runAttempt
        : job.run_attempt !== expected.runAttempt) ||
      job.head_sha !== expected.headSha
    )
      throw Error("HOSTED_INPUT_MISMATCH");
}

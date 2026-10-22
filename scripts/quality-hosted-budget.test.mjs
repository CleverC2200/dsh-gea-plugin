import test from "node:test";
import assert from "node:assert/strict";
import {
  assessHostedBudget,
  assessSourceBudget,
  readHostedRun,
  waitForHostedRun,
} from "./quality-hosted-budget.mjs";
import { createServer } from "node:http";
import { once } from "node:events";

const expected = {
  repository: "CleverC2200/dsh-gea-plugin",
  runId: 123,
  runAttempt: 1,
  headSha: "a".repeat(40),
};
const at = (milliseconds) =>
  new Date(Date.parse("2026-10-15T00:00:00Z") + milliseconds).toISOString();
function snapshot(durationMs = 600000) {
  const job = (id, name, start, end) => ({
    id,
    name,
    run_id: expected.runId,
    run_attempt: expected.runAttempt,
    head_sha: expected.headSha,
    status: "completed",
    conclusion: "success",
    started_at: at(start),
    completed_at: at(end),
  });
  return {
    schemaVersion: 1,
    expected: { ...expected },
    observedAt: at(durationMs + 5000),
    pagination: { complete: true, totalCount: 3, pageCount: 1, perPage: 100 },
    run: {
      id: expected.runId,
      run_attempt: 1,
      head_sha: expected.headSha,
      status: "completed",
      conclusion: "success",
      created_at: at(-1000),
      run_started_at: at(0),
      updated_at: at(durationMs),
    },
    jobs: [
      job(1, "scope", 1000, 2000),
      job(2, "gates", 3000, durationMs - 1000),
      job(3, "candidate-quality", durationMs - 1000, durationMs),
    ],
  };
}
const assess = (value, options = {}) =>
  assessHostedBudget({
    snapshot: value,
    requiredJobs: ["scope", "gates"],
    finalJobName: "candidate-quality",
    mode: "completed",
    now: value.observedAt,
    ...options,
  });

test("daily source budgets distinguish functional success, slow completion and missing time", () => {
  const value = snapshot(600001);
  value.jobs[0].name = "source-plan";
  value.jobs[1].name = "source-checks";
  const result = assessSourceBudget(value, { mode: "completed", now: value.observedAt });
  assert.equal(result.functional.status, "passed");
  assert.equal(result.performance.status, "failed");
  assert.equal(result.completedMeasurement, true);
  value.jobs[1].completed_at = null;
  assert.equal(
    assessSourceBudget(value, { mode: "completed", now: value.observedAt }).performance.status,
    "unknown",
  );
});

test("source budget never reports functional success for missing plan or shard evidence", () => {
  const value = snapshot();
  value.jobs[0].name = "source-plan";
  value.jobs[1].name = "source-checks (1)";
  assert.equal(assessSourceBudget(value, { now: value.observedAt }).functional.status, "failed");
  value.jobs[1].name = "source-checks";
  value.jobs.splice(0, 1);
  value.pagination.totalCount = value.jobs.length;
  assert.equal(assessSourceBudget(value, { now: value.observedAt }).functional.status, "failed");
});

test("in-gate source reports preserve a failed final admission", () => {
  const value = snapshot();
  value.jobs[0].name = "source-plan";
  value.jobs[1].name = "source-checks";
  value.run.status = "in_progress";
  value.run.conclusion = null;
  value.jobs[2].status = "in_progress";
  value.jobs[2].conclusion = null;
  value.jobs[2].completed_at = null;
  const options = { mode: "in-gate", now: value.observedAt };
  assert.equal(
    assessSourceBudget(value, { ...options, admission: "success" }).functional.status,
    "passed",
  );
  assert.equal(
    assessSourceBudget(value, { ...options, admission: "failure" }).functional.status,
    "failed",
  );
  assert.equal(assessSourceBudget(value, options).functional.status, "unknown");
});

test("source budget accepts the workflow's skipped dependency-review job", () => {
  const value = snapshot();
  value.jobs[0].name = "source-plan";
  value.jobs[1].name = "source-checks";
  value.jobs.push({ ...value.jobs[1], id: 4, name: "dependency-review", conclusion: "skipped" });
  value.pagination.totalCount = 4;
  assert.equal(assessSourceBudget(value, { now: value.observedAt }).functional.status, "passed");
});

async function restFixture(t, change = (response) => response) {
  const data = snapshot();
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    requests.push({
      path: url.pathname,
      query: url.search,
      authorization: request.headers.authorization,
    });
    const page = Number(url.searchParams.get("page"));
    const perPage = Number(url.searchParams.get("per_page"));
    const body = url.pathname.endsWith("/jobs")
      ? {
          total_count: data.jobs.length,
          jobs: data.jobs.slice((page - 1) * perPage, page * perPage),
        }
      : data.run;
    const result = change({ body: structuredClone(body), status: 200, page, path: url.pathname });
    response.writeHead(result.status, {
      "Content-Type": "application/json",
      Connection: "close",
      ...result.headers,
    });
    response.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { apiBase: `http://127.0.0.1:${server.address().port}`, requests };
}

test("one waiter retains the original attempt and returns terminal or actionable results", async (t) => {
  for (const [status, conclusion] of [
    ["completed", "success"],
    ["completed", "failure"],
    ["completed", "cancelled"],
    ["waiting", null],
  ]) {
    let reads = 0;
    const api = await restFixture(t, (response) => {
      if (!response.path.endsWith("/jobs")) {
        reads++;
        response.body.status = reads === 1 ? "in_progress" : status;
        response.body.conclusion = reads === 1 ? null : conclusion;
      }
      return response;
    });
    const result = await waitForHostedRun({
      ...expected,
      apiBase: api.apiBase,
      intervalMs: 1,
      timeoutMs: 2000,
    });
    assert.equal(reads, 2);
    assert.equal(result.run.status, status);
    assert.equal(result.run.conclusion, conclusion);
    assert.equal(result.expected.runAttempt, 1);
    assert.equal(assess(result).passed, conclusion === "success");
  }
});

test("the waiter stops on API errors, unknown states and its deadline", async (t) => {
  for (const [status, httpStatus, error] of [
    ["in_progress", 200, /HOSTED_WAIT_TIMEOUT/],
    ["unrecognized", 200, /HOSTED_RUN_STATUS_REQUIRED/],
    ["in_progress", 403, /HOSTED_API_READ_FAILED/],
  ]) {
    const api = await restFixture(t, (response) => {
      response.status = httpStatus;
      response.body.status = status;
      return response;
    });
    await assert.rejects(
      waitForHostedRun({ ...expected, apiBase: api.apiBase, intervalMs: 1, timeoutMs: 50 }),
      error,
    );
  }
});

test("the public hosted reader fetches every attempt-specific jobs page through real HTTP", async (t) => {
  const api = await restFixture(t);
  const result = await readHostedRun({
    ...expected,
    token: "fixture-token",
    apiBase: api.apiBase,
    perPage: 1,
  });
  assert.deepEqual(
    result.jobs.map((job) => job.id),
    [1, 2, 3],
  );
  assert.equal(result.pagination.complete, true);
  assert.equal(result.pagination.pageCount, 3);
  assert.equal(result.pagination.totalCount, 3);
  assert.equal(api.requests.length, 4);
  assert.ok(api.requests.every((request) => request.path.includes("/actions/runs/123/attempts/1")));
  assert.ok(api.requests.every((request) => request.authorization === "Bearer fixture-token"));
  assert.ok(!JSON.stringify(result).includes("fixture-token"));
});

test("the public hosted reader rejects API failures, incomplete pages and stale attempt identities over real HTTP", async (t) => {
  for (const [name, change] of [
    [
      "old run head",
      (r) => {
        if (!r.path.endsWith("/jobs")) r.body.head_sha = "b".repeat(40);
      },
    ],
    [
      "old run attempt",
      (r) => {
        if (!r.path.endsWith("/jobs")) r.body.run_attempt = 2;
      },
    ],
    [
      "wrong run",
      (r) => {
        if (!r.path.endsWith("/jobs")) r.body.id = 456;
      },
    ],
    [
      "old job attempt",
      (r) => {
        if (r.page === 2) r.body.jobs[0].run_attempt = 2;
      },
    ],
    [
      "old job head",
      (r) => {
        if (r.page === 2) r.body.jobs[0].head_sha = "b".repeat(40);
      },
    ],
    [
      "wrong job run",
      (r) => {
        if (r.page === 2) r.body.jobs[0].run_id = 456;
      },
    ],
    [
      "incomplete page",
      (r) => {
        if (r.page === 3) r.body.jobs = [];
      },
    ],
    [
      "duplicate job page",
      (r) => {
        if (r.page === 2) r.body.jobs[0].id = 1;
      },
    ],
    [
      "count drift",
      (r) => {
        if (r.page === 2) r.body.total_count = 4;
      },
    ],
    [
      "missing count",
      (r) => {
        if (r.page === 1) delete r.body.total_count;
      },
    ],
    [
      "API status",
      (r) => {
        r.status = 503;
      },
    ],
    [
      "invalid JSON",
      (r) => {
        r.body = "{";
      },
    ],
    [
      "redirect",
      (r) => {
        r.status = 302;
        r.headers = { Location: "/unexpected" };
      },
    ],
  ])
    await t.test(name, async (t) => {
      const api = await restFixture(t, (response) => {
        change(response);
        return response;
      });
      await assert.rejects(
        readHostedRun({ ...expected, token: "fixture-token", apiBase: api.apiBase, perPage: 1 }),
        /HOSTED_/,
      );
    });
});

test("completed hosted budgets keep functional success separate at the exact ten-minute boundary", () => {
  for (const [milliseconds, status] of [
    [599999, "passed"],
    [600000, "passed"],
    [600001, "failed"],
  ]) {
    const result = assess(snapshot(milliseconds));
    assert.equal(result.functional.status, "passed");
    assert.equal(result.performance.status, status);
    assert.equal(result.performance.workflowToDecisionMs, milliseconds);
    assert.equal(result.performance.triggerToDecisionMs, milliseconds + 1000);
    assert.equal(result.performance.initialSchedulingWaitMs, 1000);
    assert.equal(result.performance.triggerQueueMs, 1000);
    assert.equal(result.completedMeasurement, true);
    assert.equal(result.passed, status === "passed");
  }
});

test("an in-progress final decision stays separate from the later completed workflow and cleanup time", () => {
  const running = snapshot(600000);
  running.run.status = "in_progress";
  running.run.conclusion = null;
  running.run.updated_at = at(590000);
  Object.assign(running.jobs[2], { status: "in_progress", conclusion: null, completed_at: null });
  running.observedAt = at(599999);
  const decision = assess(running, { mode: "in-gate", now: at(599999) });
  assert.equal(decision.passed, true);
  assert.equal(decision.completedMeasurement, false);
  assert.equal(decision.performance.workflowToDecisionMs, 599999);
  assert.equal(decision.functional.scope, "required-upstream-and-current-final");
  assert.equal(decision.performance.completionAt, null);
  const completed = snapshot(620000);
  completed.jobs[1].completed_at = at(599000);
  completed.jobs[2].started_at = at(599000);
  const later = assess(completed, { gateDecision: decision.gateDecision });
  assert.equal(later.functional.status, "passed");
  assert.equal(later.performance.status, "failed");
  assert.equal(later.performance.postGateMs, 20001);
  assert.equal(later.completedMeasurement, true);
  assert.equal(later.passed, false);
});

test("missing, malformed, impossible and inverted hosted clocks stay unknown rather than becoming zero or passing", () => {
  for (const [name, mutate] of [
    [
      "missing run start",
      (s) => {
        delete s.run.run_started_at;
      },
    ],
    [
      "bad update",
      (s) => {
        s.run.updated_at = "unknown";
      },
    ],
    [
      "timezone missing",
      (s) => {
        s.run.created_at = "2026-10-15 00:00:00";
      },
    ],
    [
      "impossible calendar date",
      (s) => {
        s.run.created_at = "2026-02-30T00:00:00Z";
      },
    ],
    [
      "trigger after workflow",
      (s) => {
        s.run.created_at = at(1);
      },
    ],
    [
      "job before workflow",
      (s) => {
        s.jobs[0].started_at = at(-1);
      },
    ],
    [
      "inverted job",
      (s) => {
        s.jobs[0].completed_at = at(999);
      },
    ],
    [
      "missing job finish",
      (s) => {
        s.jobs[1].completed_at = null;
      },
    ],
    [
      "job finish after completion",
      (s) => {
        s.jobs[2].completed_at = at(600001);
      },
    ],
    [
      "future workflow",
      (s) => {
        s.observedAt = at(599000);
      },
    ],
  ]) {
    const value = snapshot();
    mutate(value);
    const result = assess(value);
    assert.equal(result.functional.status, "passed", name);
    assert.equal(result.performance.status, "unknown", name);
    assert.equal(result.passed, false, name);
    assert.ok(result.performance.reasons.length > 0, name);
  }
});

test("public budget assessment refuses partial or stale saved API snapshots independently of clock values", () => {
  for (const [name, mutate] of [
    [
      "old run attempt",
      (s) => {
        s.run.run_attempt = 2;
      },
    ],
    [
      "old head",
      (s) => {
        s.run.head_sha = "b".repeat(40);
      },
    ],
    [
      "old job attempt",
      (s) => {
        s.jobs[0].run_attempt = 2;
      },
    ],
    [
      "missing pagination",
      (s) => {
        delete s.pagination;
      },
    ],
    [
      "incomplete pagination",
      (s) => {
        s.pagination.complete = false;
      },
    ],
    [
      "declared missing job",
      (s) => {
        s.pagination.totalCount = 4;
      },
    ],
    [
      "duplicate job id",
      (s) => {
        s.jobs[1].id = s.jobs[0].id;
      },
    ],
  ]) {
    const value = snapshot();
    mutate(value);
    const result = assess(value);
    assert.equal(result.functional.status, "unknown", name);
    assert.equal(result.performance.status, "unknown", name);
    assert.equal(result.performance.workflowToDecisionMs, null, name);
    assert.equal(result.passed, false, name);
  }
});

test("failed, cancelled, skipped or missing required jobs cannot turn a short workflow into functional success", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", null]) {
    const value = snapshot(599999);
    value.jobs[1].conclusion = conclusion;
    const result = assess(value);
    assert.equal(result.functional.status, "failed");
    assert.equal(result.performance.status, "passed");
    assert.equal(result.passed, false);
  }
  const missing = snapshot();
  missing.jobs.splice(1, 1);
  missing.pagination.totalCount = 2;
  assert.equal(assess(missing).functional.status, "failed");
  const duplicate = snapshot();
  duplicate.jobs.push({ ...duplicate.jobs[1], id: 4 });
  duplicate.pagination.totalCount = 4;
  assert.equal(assess(duplicate).functional.status, "failed");
  assert.throws(() => assess(snapshot(), { requiredJobs: [] }), /HOSTED_BUDGET_INPUT_REQUIRED/);
  assert.throws(() => assess(snapshot(), { mode: "unknown" }), /HOSTED_BUDGET_INPUT_REQUIRED/);
});

test("a completed workflow cannot borrow a running job clock or a different attempt's earlier gate", () => {
  const value = snapshot();
  value.jobs.push({
    ...value.jobs[1],
    id: 4,
    name: "optional-running",
    status: "in_progress",
    conclusion: null,
  });
  value.pagination.totalCount = 4;
  const incomplete = assess(value);
  assert.equal(incomplete.functional.status, "passed");
  assert.equal(incomplete.performance.status, "unknown");
  assert.equal(incomplete.passed, false);
  const oldGate = assess(snapshot(), {
    gateDecision: { ...expected, runAttempt: 2, finalJobId: 3, at: at(599999) },
  });
  assert.equal(oldGate.performance.status, "unknown");
  assert.equal(oldGate.performance.postGateMs, null);
  const completedAsRunning = assess(snapshot(), { mode: "in-gate" });
  assert.equal(completedAsRunning.passed, false);
  assert.equal(completedAsRunning.completedMeasurement, false);
});

test("documentation and dependency-review N/A jobs accept only absence or explicit skips while applicable jobs remain mandatory", () => {
  const absent = snapshot(10000);
  absent.jobs.splice(1, 1);
  absent.pagination.totalCount--;
  for (const name of [
    "gates",
    "prepare-" + "a".repeat(40),
    "macos-isolation",
    "plan-test-shards",
    "test-shards",
    "Dependency review",
  ]) {
    const options = { requiredJobs: ["scope"], notApplicableJobs: [name] };
    assert.equal(assess(absent, options).passed, true);
    for (const conclusion of ["skipped", "success", "failure", "cancelled"]) {
      const value = structuredClone(absent);
      value.jobs.push({ ...value.jobs[0], id: 4, name, conclusion });
      value.pagination.totalCount++;
      assert.equal(
        assess(value, options).passed,
        conclusion === "skipped",
        name + ":" + conclusion,
      );
    }
  }
  const required = snapshot(10000);
  required.jobs[1].name = "Dependency review";
  required.jobs[1].conclusion = "skipped";
  assert.equal(assess(required, { requiredJobs: ["scope", "Dependency review"] }).passed, false);
});

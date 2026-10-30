import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  recordSourceInput,
  lookupFormalSource,
  verifyFormalSource,
} from "./source-formal-receipt.mjs";

const context = {
  repository: "CleverC2200/dsh-gea-plugin",
  repositoryId: 1365221347,
  sourceRepository: "CleverC2200/dsh-gea-plugin",
  sourceRepositoryId: 1365221347,
  pr: 215,
  head: "a".repeat(40),
  base: "b".repeat(40),
  diffBase: "c".repeat(40),
  target: "main",
  branch: "codex/receipt-test",
  runId: 200,
  runAttempt: 1,
};
const plan = {
  head: context.head,
  base: context.diffBase,
  mode: "docs",
  engineering: false,
  "dependency-review": false,
  files: ["README.md"],
};
const matrix = { parallel: false, shards: ["single"] };
const sourceWorkflow = readFileSync(
  new URL("../.github/workflows/source-quality.yml", import.meta.url),
  "utf8",
);

test("formal input records the event base separately from its merge base and rejects metadata sources", () => {
  const receipt = recordSourceInput({ context, plan, matrix, validate: "true" });
  assert.equal(receipt.context.base, "b".repeat(40));
  assert.equal(receipt.plan.base, "c".repeat(40));
  assert.deepEqual(receipt.matrix, { parallel: false, shards: ["single"] });
  assert.equal(receipt.workflowId, 391523453);
  for (const validate of ["false", "", undefined])
    assert.throws(() => recordSourceInput({ context, plan, matrix, validate }));
  assert.throws(() =>
    recordSourceInput({ context, plan: { ...plan, head: context.base }, matrix, validate: "true" }),
  );
});

function hosted(workflow = sourceWorkflow) {
  const jobsSource = workflow.split("\njobs:\n")[1];
  assert.ok(jobsSource, "source workflow declares jobs");
  const declaredJobs = [...jobsSource.matchAll(/^  ([^\s:#][^:\n]*):[^\n]*$/gm)];
  const names = declaredJobs.map((match, index) => {
    const block = jobsSource.slice(match.index, declaredJobs[index + 1]?.index);
    const name = block.match(/^    name: (.+)$/m)?.[1] ?? match[1];
    return name.startsWith("${{ ") && name.endsWith(" }}") ? name.slice(4, -3) : name;
  });
  const step = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
  const run = (id, metadata = false) => ({
    id,
    run_attempt: 1,
    workflow_id: 391523453,
    path: ".github/workflows/source-quality.yml",
    event: "pull_request",
    head_sha: context.head,
    head_branch: context.branch,
    repository: { full_name: context.repository, id: context.repositoryId },
    head_repository: { full_name: context.sourceRepository, id: context.sourceRepositoryId },
    pull_requests: [
      {
        number: 215,
        head: { sha: context.head, ref: context.branch, repo: { id: context.sourceRepositoryId } },
        base: { sha: context.base, ref: "main", repo: { id: context.repositoryId } },
      },
    ],
    created_at: id === 100 ? "2026-10-26T01:00:00Z" : "2026-10-26T02:00:00Z",
    status: metadata ? "in_progress" : "completed",
    conclusion: metadata ? null : "success",
  });
  const runs = [run(200, true), run(100)];
  const makeJobs = (id, metadata = false) => {
    const defined = [
      {
        name: "source-plan",
        conclusion: "success",
        steps: [
          step("Admit source input changes"),
          step("Classify actual Git changes", metadata ? "skipped" : "success"),
          step("Record formal source inputs"),
          step("Keep formal source input receipt"),
        ],
      },
      {
        name: "matrix.shard == 'single' && 'source-checks' || format('source-checks ({0})', matrix.shard)",
        conclusion: "skipped",
        steps: [],
      },
      { name: "dependency-review", conclusion: "skipped", steps: [] },
      {
        name: "candidate-quality",
        conclusion: "success",
        steps: [
          step("Require successful applicable checks"),
          step("Require complete source-check execution", "skipped"),
        ],
      },
      { name: "dependency-policy", conclusion: "skipped", steps: [] },
    ];
    return names
      .map(
        (name) =>
          defined.find((job) => job.name === name) ?? {
            name,
            conclusion: "success",
            steps: [],
          },
      )
      .map((job, index) => ({
        ...job,
        id: id * 10 + index,
        run_id: id,
        run_attempt: 1,
        head_sha: context.head,
        status: "completed",
      }));
  };
  const jobs = { 100: makeJobs(100), 200: makeJobs(200, true) };
  const artifact = {
    id: 1000,
    name: "source-inputs-1",
    size_in_bytes: 2048,
    expired: false,
    workflow_run: {
      id: 100,
      repository_id: context.repositoryId,
      head_repository_id: context.sourceRepositoryId,
      head_sha: context.head,
      head_branch: context.branch,
    },
  };
  const calls = [];
  const read = async (path) => {
    calls.push(path);
    const url = new URL(path, "https://api.github.com");
    let result;
    if (url.pathname.endsWith("/workflows/391523453/runs"))
      result = { total_count: runs.length, workflow_runs: runs };
    else if (url.pathname.endsWith("/artifacts"))
      result = { total_count: 1, artifacts: [artifact] };
    else if (url.pathname.endsWith("/jobs")) {
      const id = Number(url.pathname.match(/runs\/(\d+)/)[1]);
      result = { total_count: jobs[id].length, jobs: jobs[id] };
    } else {
      const id = Number(url.pathname.match(/runs\/(\d+)$/)[1]);
      result = runs.find((value) => value.id === id);
    }
    return structuredClone(result);
  };
  return {
    runs,
    jobs,
    artifact,
    calls,
    read,
    makeJobs,
    run,
    step,
    receipt: () =>
      recordSourceInput({ context: { ...context, runId: 100 }, plan, matrix, validate: "true" }),
  };
}

test("metadata verifies complete formal docs evidence and the exact native artifact", async () => {
  const f = hosted();
  const selection = await lookupFormalSource({ context, read: f.read });
  assert.equal(selection.runId, 100);
  assert.equal(selection.runAttempt, 1);
  assert.equal(selection.artifactId, 1000);
  assert.equal(selection.artifactName, "source-inputs-1");
  assert.deepEqual(
    await verifyFormalSource({ context, selection, receipt: f.receipt(), read: f.read }),
    { verified: true, runId: 100, runAttempt: 1 },
  );
});

test("metadata rejects a workflow job that has no formal receipt coverage", async () => {
  for (const job of ["newly-required-policy", "New_Policy"]) {
    const f = hosted(
      sourceWorkflow +
        `\n  ${job}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo checked\n`,
    );
    const selection = await lookupFormalSource({ context, read: f.read });
    await assert.rejects(
      verifyFormalSource({ context, selection, receipt: f.receipt(), read: f.read }),
      /formal job coverage/,
    );
  }
});

test("the current caller and previous metadata runs cannot become formal evidence", async () => {
  const f = hosted();
  f.jobs[200] = f.makeJobs(200);
  await assert.rejects(lookupFormalSource({ context, read: f.read }));
});

test("pending formal execution is waited for without restarting a run and metadata history is ignored", async () => {
  const f = hosted();
  f.runs.unshift({ ...f.run(190, true), created_at: "2026-10-26T01:30:00Z" });
  f.jobs[190] = f.makeJobs(190, true);
  f.runs.find((run) => run.id === 100).status = "in_progress";
  f.runs.find((run) => run.id === 100).conclusion = null;
  let time = 0,
    pauses = 0;
  const selection = await lookupFormalSource({
    context,
    read: f.read,
    now: () => time,
    pause: async (ms) => {
      time += ms;
      pauses++;
      Object.assign(
        f.runs.find((run) => run.id === 100),
        { status: "completed", conclusion: "success" },
      );
    },
    intervalMs: 10,
    timeoutMs: 100,
  });
  assert.equal(selection.runId, 100);
  assert.equal(pauses, 1);
  assert.ok(f.calls.every((path) => path.startsWith("/repos/CleverC2200/dsh-gea-plugin/actions/")));
});

test("latest formal failures, cancellations and unknown results never fall back to an older success", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null, "unknown"]) {
    const f = hosted();
    f.runs.push({ ...f.run(150), created_at: "2026-10-26T01:30:00Z", conclusion });
    f.jobs[150] = f.makeJobs(150);
    await assert.rejects(lookupFormalSource({ context, read: f.read }));
  }
  const f = hosted();
  f.runs.push({ ...f.run(150), created_at: "2026-10-26T01:30:00Z" });
  f.jobs[150] = [];
  await assert.rejects(lookupFormalSource({ context, read: f.read }));
});

test("missing artifacts, admission, complete jobs and successful worker aggregation reject verification", async () => {
  for (const mutate of [
    (f) => {
      f.artifact.name = "source-inputs-2";
    },
    (f) => {
      f.artifact.expired = true;
    },
    (f) => {
      f.jobs[100].find((job) => job.name === "candidate-quality").steps[0].conclusion = "skipped";
    },
    (f) => {
      f.jobs[100].find((job) => job.name.startsWith("matrix.shard")).conclusion = "success";
    },
    (f) => {
      f.jobs[100].push({ ...f.jobs[100][0], id: 9999, name: "unexpected-job" });
    },
    (f) => {
      f.jobs[100].splice(
        f.jobs[100].findIndex((job) => job.name === "dependency-policy"),
        1,
      );
    },
    (f) => {
      f.jobs[100].find((job) => job.name === "dependency-policy").conclusion = "success";
    },
  ]) {
    const f = hosted();
    const selection = await lookupFormalSource({ context, read: f.read });
    mutate(f);
    await assert.rejects(
      verifyFormalSource({ context, selection, receipt: f.receipt(), read: f.read }),
    );
  }
  const f = hosted();
  f.jobs[100].splice(
    f.jobs[100].findIndex((job) => job.name.startsWith("matrix.shard")),
    1,
    ...[1, 2].map((shard) => ({
      ...f.makeJobs(100).find((job) => job.name.startsWith("matrix.shard")),
      id: 1100 + shard,
      name: `source-checks (${shard})`,
      conclusion: "success",
    })),
  );
  f.jobs[100].find((job) => job.name === "dependency-review").conclusion = "success";
  f.jobs[100].find((job) => job.name === "dependency-policy").conclusion = "success";
  const receipt = recordSourceInput({
    context: { ...context, runId: 100 },
    plan: { ...plan, mode: "code", engineering: true, "dependency-review": true },
    matrix: { parallel: true, shards: ["1", "2"] },
    validate: "true",
  });
  const selection = await lookupFormalSource({ context, read: f.read });
  await assert.rejects(verifyFormalSource({ context, selection, receipt, read: f.read }));
  f.jobs[100].find((job) => job.name === "candidate-quality").steps[1].conclusion = "success";
  assert.equal(
    (await verifyFormalSource({ context, selection, receipt, read: f.read })).verified,
    true,
  );
  for (const conclusion of ["skipped", "failure", "cancelled"]) {
    f.jobs[100].find((job) => job.name === "dependency-policy").conclusion = conclusion;
    await assert.rejects(
      verifyFormalSource({ context, selection, receipt, read: f.read }),
      /formal job coverage/,
    );
  }
});

test("receipt and fresh API identities bind head, both bases, target, source, workflow, PR and attempt", async () => {
  for (const [key, value] of Object.entries({
    repository: "other/repo",
    repositoryId: 9,
    sourceRepository: "other/repo",
    sourceRepositoryId: 9,
    pr: 9,
    head: "d".repeat(40),
    base: "d".repeat(40),
    diffBase: "d".repeat(40),
    target: "release",
    branch: "other",
    runId: 9,
    runAttempt: 2,
  })) {
    const f = hosted();
    const selection = await lookupFormalSource({ context, read: f.read });
    const receipt = f.receipt();
    receipt.context[key] = value;
    await assert.rejects(verifyFormalSource({ context, selection, receipt, read: f.read }), key);
  }
  for (const mutate of [
    (f) => {
      f.runs[1].workflow_id++;
    },
    (f) => {
      f.runs[1].path = ".github/workflows/other.yml";
    },
    (f) => {
      f.runs[1].event = "workflow_dispatch";
    },
    (f) => {
      f.runs[1].head_sha = "d".repeat(40);
    },
    (f) => {
      f.runs[1].pull_requests[0].base.sha = "d".repeat(40);
    },
    (f) => {
      f.runs[1].pull_requests[0].base.ref = "release";
    },
    (f) => {
      f.runs[1].pull_requests = [];
    },
    (f) => {
      f.runs[1].head_repository.full_name = "other/repo";
    },
    (f) => {
      f.artifact.workflow_run.id = 9;
    },
    (f) => {
      f.jobs[100][0].run_attempt = 2;
    },
  ]) {
    const f = hosted();
    const selection = await lookupFormalSource({ context, read: f.read });
    mutate(f);
    await assert.rejects(
      verifyFormalSource({ context, selection, receipt: f.receipt(), read: f.read }),
    );
  }
});

test("verification reselects the latest formal event and attempt after native artifact download", async () => {
  for (const mutate of [
    (f) => {
      f.runs.push({ ...f.run(150), created_at: "2026-10-26T01:30:00Z", conclusion: "failure" });
      f.jobs[150] = f.makeJobs(150);
    },
    (f) => {
      f.runs[1].run_attempt = 2;
      f.jobs[100].forEach((job) => {
        job.run_attempt = 2;
      });
      f.artifact.name = "source-inputs-2";
    },
    (f) => {
      f.runs[1].status = "in_progress";
      f.runs[1].conclusion = null;
    },
  ]) {
    const f = hosted();
    const selection = await lookupFormalSource({ context, read: f.read });
    mutate(f);
    await assert.rejects(
      verifyFormalSource({ context, selection, receipt: f.receipt(), read: f.read }),
    );
  }
});

test("all API pages are consumed and missing, duplicate or failed reads cannot grant success", async () => {
  const f = hosted();
  for (let id = 300; id < 400; id++)
    f.runs.push({ ...f.run(id), pull_requests: [{ number: 999 }] });
  const paginated = async (path) => {
    const body = await f.read(path);
    if (body.workflow_runs) {
      const page = Number(new URL(path, "https://api.github.com").searchParams.get("page"));
      body.workflow_runs = body.workflow_runs.slice((page - 1) * 100, page * 100);
    }
    return body;
  };
  assert.equal((await lookupFormalSource({ context, read: paginated })).runId, 100);
  assert.ok(f.calls.some((path) => path.includes("page=2")));
  await assert.rejects(
    lookupFormalSource({
      context,
      read: async (path) => {
        const body = await paginated(path);
        if (path.includes("page=2")) body.workflow_runs = [];
        return body;
      },
    }),
  );
  await assert.rejects(
    lookupFormalSource({
      context,
      read: async () => {
        throw Error("read failed");
      },
    }),
  );
  const duplicate = hosted();
  duplicate.jobs[100].push(duplicate.jobs[100][0]);
  await assert.rejects(lookupFormalSource({ context, read: duplicate.read }));
});

test("formal waiting has a bounded clock and rejects timeouts or unknown run status", async () => {
  const f = hosted();
  f.runs[1].status = "in_progress";
  let time = 0;
  await assert.rejects(
    lookupFormalSource({
      context,
      read: f.read,
      now: () => time,
      pause: async (ms) => {
        time += ms;
      },
      timeoutMs: 20,
      intervalMs: 10,
    }),
    /timeout/,
  );
  f.runs[1].status = "unknown";
  await assert.rejects(lookupFormalSource({ context, read: f.read }));
});

test("malformed event ordering and substituted run responses cannot conceal the latest formal result", async () => {
  const f = hosted();
  f.runs.push({ ...f.run(150), created_at: "invalid" });
  f.jobs[150] = f.makeJobs(150);
  await assert.rejects(lookupFormalSource({ context, read: f.read }));
  const swapped = hosted();
  swapped.runs.push({
    ...swapped.run(150),
    created_at: "2026-10-26T01:30:00Z",
    conclusion: "failure",
  });
  swapped.jobs[150] = swapped.makeJobs(150);
  await assert.rejects(
    lookupFormalSource({
      context,
      read: (path) =>
        swapped.read(path.endsWith("/runs/150") ? path.replace("/runs/150", "/runs/100") : path),
    }),
  );
});

test("the record CLI binds the checked out commit and emits a native artifact input without network access", (t) => {
  const root = mkdtempSync(join(tmpdir(), "formal-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Receipt fixture");
  git("config", "user.email", "receipt@example.invalid");
  writeFileSync(join(root, "README.md"), "Before\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "README.md"), "After\n");
  git("add", ".");
  git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD");
  const event = {
    number: 215,
    repository: { full_name: context.repository, id: context.repositoryId },
    pull_request: {
      head: {
        sha: head,
        ref: context.branch,
        repo: { full_name: context.sourceRepository, id: context.sourceRepositoryId },
      },
      base: {
        sha: base,
        ref: "main",
        repo: { full_name: context.repository, id: context.repositoryId },
      },
    },
  };
  writeFileSync(join(root, "event.json"), JSON.stringify(event));
  writeFileSync(join(root, "plan.json"), JSON.stringify({ ...plan, head, base }));
  const invoke = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./source-formal-receipt.mjs", import.meta.url)),
        "--phase",
        "record",
        "--plan",
        "plan.json",
        "--output",
        "source-input.json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY: context.repository,
          GITHUB_EVENT_PATH: join(root, "event.json"),
          GITHUB_RUN_ID: "100",
          GITHUB_RUN_ATTEMPT: "1",
          SOURCE_EVENT_VALIDATE: "true",
          SOURCE_MATRIX_PARALLEL: "false",
          SOURCE_MATRIX_SHARDS: '["single"]',
        },
      },
    );
  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(join(root, "source-input.json"), "utf8"));
  assert.equal(receipt.context.head, head);
  assert.equal(receipt.context.base, base);
  assert.equal(receipt.context.runId, 100);
  event.pull_request.head.sha = base;
  writeFileSync(join(root, "event.json"), JSON.stringify(event));
  assert.notEqual(invoke().status, 0);
});

test("native input artifacts have a small positive bounded size before download", async () => {
  for (const size of [0, -1, undefined, 1048577, 1.5]) {
    const f = hosted();
    f.artifact.size_in_bytes = size;
    await assert.rejects(lookupFormalSource({ context, read: f.read }));
  }
});

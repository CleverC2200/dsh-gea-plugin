import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  globSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./source-quality.mjs", import.meta.url));
function fixture(t, files, changed, { repoName } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "source-quality-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = repoName ? join(directory, repoName) : directory;
  mkdirSync(root, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Source quality test");
  git("config", "user.email", "source-quality@example.invalid");
  const put = (entries) => {
    for (const [file, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      if (content === null) rmSync(join(root, file));
      else writeFileSync(join(root, file), content);
    }
  };
  put(files);
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  put(changed);
  git("add", ".");
  git("commit", "-qm", "change");
  const head = git("rev-parse", "HEAD");
  const event = join(root, ".git/event.json");
  writeFileSync(
    event,
    JSON.stringify({ pull_request: { base: { ref: "main", sha: base }, head: { sha: head } } }),
  );
  const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event };
  delete env.SOURCE_HEAD_SHA;
  delete env.SOURCE_BASE_SHA;
  return {
    root,
    git,
    base,
    head,
    env,
    run: (phase, extra = {}) =>
      spawnSync(process.execPath, [cli, "--phase", phase], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...extra },
      }),
  };
}

test("a README-only pull request needs no engineering checks, including Markdown hard breaks", (t) => {
  const repo = fixture(
    t,
    { "README.md": "Before\n", "unrelated.js": "broken syntax !" },
    { "README.md": "After  \nHard break\n" },
  );
  const result = repo.run("plan");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "docs");
});

test("GEA source checks pass the fixed SDK path to browser test consumers", (t) => {
  const repo = fixture(
    t,
    { "src/client.ts": "export const value = 1;\n" },
    { "src/client.ts": "export const value = 2;\n" },
    { repoName: "candidate/dsh-gea-plugin" },
  );
  const reader = join(repo.root, "../../source/dsh-agent-workbench/scripts/source-checks.mjs");
  mkdirSync(dirname(reader), { recursive: true });
  writeFileSync(
    reader,
    `import { execFileSync } from 'node:child_process';
export function sourceChecks(_result, phase) {
  if (process.env.SOURCE_TEST_FAILURE === 'true') throw Error('fixture-check-failed');
  if (phase === 'affected-check') execFileSync(process.execPath, ['--input-type=module', '-e',
    'import assert from "node:assert/strict"; import {resolve} from "node:path"; assert.equal(process.env.GEA_PLUGIN_UPDATE_SDK, resolve("../../official-latest-standard"));'
  ], {stdio: 'inherit'});
}`,
  );
  mkdirSync(join(repo.root, ".runtime"));
  const selection = { files: ["tests/example.browser.mjs"], head: repo.head };
  writeFileSync(join(repo.root, ".runtime/source-checks-plan.json"), JSON.stringify(selection));
  repo.git("add", ".runtime/source-checks-plan.json");
  repo.git("commit", "-qm", "record selected source checks");
  const sourceHead = repo.git("rev-parse", "HEAD");
  for (const inherited of ["", "/stale-sdk"])
    assert.equal(
      repo.run("affected-check", { GEA_PLUGIN_UPDATE_SDK: inherited, SOURCE_HEAD_SHA: sourceHead })
        .status,
      0,
      `SDK environment: ${inherited || "missing"}`,
    );
  const receipt = JSON.parse(readFileSync(join(repo.root, ".runtime/source-checks-result.json")));
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.head, sourceHead);
  assert.deepEqual(receipt.plan, selection);
  const failed = repo.run("affected-check", {
    SOURCE_HEAD_SHA: sourceHead,
    SOURCE_TEST_FAILURE: "true",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /fixture-check-failed/);
  assert.equal(existsSync(join(repo.root, ".runtime/source-checks-result.json")), false);
});

test("manual source acceptance rejects missing, invalid and non-ancestor comparison bases", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  writeFileSync(join(repo.root, ".git/event.json"), JSON.stringify({}));
  repo.git("checkout", "--orphan", "unrelated");
  repo.git("commit", "--allow-empty", "-qm", "unrelated root");
  const unrelated = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "--detach", repo.head);
  for (const base of ["", "HEAD~1", repo.base.slice(0, 12), "f".repeat(40), unrelated]) {
    for (const phase of ["event", "plan", "final"]) {
      const result = repo.run(phase, {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        SOURCE_BASE_SHA: base,
      });
      assert.notEqual(result.status, 0, `${phase}: ${base || "missing"}`);
      assert.match(result.stderr, /SOURCE_MANUAL_BASE_(?:SHA_REQUIRED|ANCESTOR_REQUIRED)/);
    }
  }
});

test("manual source acceptance uses its ancestor comparison and retains strict final admission", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  mkdirSync(join(repo.root, "scripts"));
  writeFileSync(join(repo.root, "scripts/acceptance.mjs"), "export const accepted = true;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "latest change");
  writeFileSync(join(repo.root, ".git/event.json"), JSON.stringify({}));
  const env = { GITHUB_EVENT_NAME: "workflow_dispatch", SOURCE_BASE_SHA: repo.base };
  const admitted = repo.run("event", env);
  assert.equal(admitted.status, 0, admitted.stderr);
  assert.deepEqual(JSON.parse(admitted.stdout), {
    validate: true,
    reason: "source-validation-required",
  });
  const planned = repo.run("plan", env);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.base, repo.base);
  assert.equal(plan.head, repo.git("rev-parse", "HEAD"));
  assert.deepEqual(plan.files, ["README.md", "scripts/acceptance.mjs"]);
  assert.equal(plan["dependency-review"], false);
  const results = {
    ...env,
    PLAN_RESULT: "success",
    CHECK_RESULT: "success",
    DEPENDENCY_RESULT: "skipped",
  };
  assert.equal(repo.run("final", results).status, 0);
  for (const CHECK_RESULT of ["failure", "cancelled", "skipped", ""])
    assert.notEqual(repo.run("final", { ...results, CHECK_RESULT }).status, 0);
});

test("manual source acceptance binds the public hosted reader after a documentation follow-up", (t) => {
  const baseline = {
    repositories: [
      { repo: "dsh-gea-plugin", head: "a".repeat(40) },
      { repo: "dsh-agent-workbench", head: "b".repeat(40) },
      { repo: "dsh-agent-manage", head: "c".repeat(40) },
    ],
  };
  const repo = fixture(
    t,
    {
      "scripts/quality-peer-baseline.json": JSON.stringify(baseline),
      "scripts/input.mjs": "export const value = 1;\n",
    },
    { "scripts/input.mjs": "export const value = 2;\n" },
    { repoName: "dsh-gea-plugin" },
  );
  writeFileSync(join(repo.root, "README.md"), "Documentation follow-up\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "documentation follow-up");
  const root = repo.root;
  const head = repo.git("rev-parse", "HEAD");
  const base = repo.base;
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_EVENT_PATH: "",
    GITHUB_OUTPUT: "",
    SOURCE_HEAD_SHA: head,
    SOURCE_BASE_SHA: base,
    QUALITY_SCOPE_ALLOWED: "true",
    QUALITY_EXPECTED_SHA: head,
    QUALITY_GROUP_GEA: "",
    QUALITY_GROUP_MANAGE: "",
    QUALITY_GROUP_WORKBENCH: "",
  };
  const planResult = spawnSync(process.execPath, [cli, "--phase", "plan"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(planResult.status, 0, planResult.stderr);
  const plan = JSON.parse(planResult.stdout);
  assert.equal(plan.mode, "code");
  assert.deepEqual(plan.files, ["README.md", "scripts/input.mjs"]);
  const reader = join(
    process.env.GEA_FINAL_GROUP_WORKBENCH_SOURCE ??
      fileURLToPath(new URL("../../dsh-agent-workbench", import.meta.url)),
    "scripts/read-hosted-peer-input.mjs",
  );
  const read = (extra) =>
    spawnSync(process.execPath, [reader, "--repo", "dsh-gea-plugin"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  const missing = read({});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CANDIDATE_EVENT_MISMATCH: complete immutable joint tuple/);
  const workflow = readFileSync(
    new URL("../.github/workflows/source-quality.yml", import.meta.url),
    "utf8",
  );
  const workers = workflow.split("\n  source-checks:\n")[1].split("\n  dependency-review:\n")[0];
  const tuple = Object.fromEntries(
    [
      ...workers.matchAll(
        /^      (QUALITY_GROUP_\w+): \$\{\{ needs\.source-plan\.outputs\.([a-z-]+) \}\}$/gm,
      ),
    ].map(([, key, output]) => [key, plan[output]]),
  );
  const accepted = read(tuple);
  assert.equal(accepted.status, 0, accepted.stderr);
  const result = JSON.parse(accepted.stdout);
  assert.equal(result["gea-sha"], head);
  for (const [key, repo] of [
    ["workbench-sha", "dsh-agent-workbench"],
    ["manage-sha", "dsh-agent-manage"],
  ])
    assert.equal(result[key], baseline.repositories.find((entry) => entry.repo === repo).head);
  assert.equal(result["source-kind"], "joint-group");
  for (const [key, value] of Object.entries({
    QUALITY_GROUP_GEA: base,
    QUALITY_GROUP_MANAGE: "",
    QUALITY_GROUP_WORKBENCH: "main",
  })) {
    const rejected = read({ ...tuple, [key]: value });
    assert.equal(rejected.status, 1, key);
    assert.match(rejected.stderr, /CANDIDATE_EVENT_MISMATCH: complete immutable joint tuple/);
  }
});

test("source workflow keeps one manual comparison base for planning, workers and aggregation", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/source-quality.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /workflow_dispatch:\n    inputs:\n      comparison_base:\n        description: .+\n        required: true\n        type: string/,
  );
  const global = workflow.split("\njobs:\n")[0];
  const expression = global.match(/\n  SOURCE_BASE_SHA: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(expression, "all jobs inherit the explicit comparison");
  const baseFor = (event_name, comparison_base) =>
    Function("github", "inputs", `return (${expression})`)({ event_name }, { comparison_base });
  assert.equal(baseFor("workflow_dispatch", "a".repeat(40)), "a".repeat(40));
  assert.equal(baseFor("pull_request", "a".repeat(40)), "");
  assert.equal(baseFor("push", "a".repeat(40)), "");
  assert.doesNotMatch(workflow.split("\njobs:\n")[1], /SOURCE_BASE_SHA:/);
  assert.match(workflow, /max-parallel: 40/);
  assert.match(
    workflow,
    /name: Record formal source inputs\n        if: github.event_name == 'pull_request'/,
  );
});

test("title and body edits admit only lightweight handling without requiring source preparation", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const path = join(repo.root, ".git/event.json");
  const event = JSON.parse(readFileSync(path, "utf8"));
  event.action = "edited";
  event.changes = { title: { from: "Old title" }, body: { from: null } };
  event.pull_request.base.sha = "f".repeat(40);
  writeFileSync(path, JSON.stringify(event));
  const output = join(repo.root, ".git/event-output");
  const result = repo.run("event", { GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { validate: false, reason: "metadata-only" });
  assert.match(readFileSync(output, "utf8"), /^validate=false\n/m);
});

test("source workflow keeps metadata edits outside active formal execution", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/source-quality.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /group: source-quality-.*github\.event\.action == 'edited'.*github\.run_id/,
  );
  assert.match(workflow, /validate: \$\{\{ steps\.event\.outputs\.validate \}\}/);
  assert.match(workflow, /id: event\n\s+run: node scripts\/source-quality\.mjs --phase event/);
  assert.match(workflow, /id: plan\n\s+if: steps\.event\.outputs\.validate == 'true'/);
  assert.match(
    workflow,
    /if: always\(\) && needs\.source-plan\.result == 'success' && needs\.source-plan\.outputs\.validate == 'true' && needs\.source-plan\.outputs\.mode != 'docs'/,
  );
  assert.match(
    workflow,
    /if: always\(\)\n\s+needs: \[source-plan, source-checks, dependency-review\]/,
  );
});

test("base and target edits supersede obsolete formal checks while metadata edits cannot cancel them", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/source-quality.yml", import.meta.url),
    "utf8",
  );
  const group = workflow.match(/^  group: (.+)$/m)[1];
  const concurrency = (action, changes, ref = "main", run_id = 100) =>
    group.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) =>
      Function(
        "github",
        `return (${expression})`,
      )({
        event: { action, changes, pull_request: { number: 42, base: { ref } } },
        run_id,
      }),
    );
  const formal = "source-quality-42-source";
  assert.equal(concurrency("synchronize", {}), formal);
  assert.notEqual(concurrency("edited", { title: { from: "Old" } }), formal);
  assert.notEqual(concurrency("edited", { body: { from: null } }), formal);
  assert.notEqual(
    concurrency("edited", { title: { from: "Old" } }, "main", 100),
    concurrency("edited", { title: { from: "Old" } }, "main", 101),
  );
  assert.equal(concurrency("edited", { base: { ref: { from: "release" } } }), formal);
  assert.equal(concurrency("edited", { head: { from: "old" } }), formal);
  assert.equal(concurrency("edited", { title: { from: "Old" } }, "release"), formal);
  assert.equal(concurrency("edited", { unknown: { from: "old" } }), formal);
});

test("source admission keeps base, head, target and unknown event changes on the formal validation path", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const path = join(repo.root, ".git/event.json");
  const pullRequest = JSON.parse(readFileSync(path, "utf8")).pull_request;
  const run = (patch = {}, env = {}) => {
    writeFileSync(path, JSON.stringify({ action: "edited", pull_request: pullRequest, ...patch }));
    const result = repo.run("event", env);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).validate;
  };
  for (const changes of [
    undefined,
    {},
    { base: { ref: { from: "main" } } },
    { head: { from: repo.base } },
    { title: { from: "Old" }, unknown: { from: "Old" } },
    { body: {} },
    { body: { from: "Old", unknown: true } },
    { title: { from: null } },
  ])
    assert.equal(run({ changes }), true, JSON.stringify(changes));
  const changes = { title: { from: "Old" } };
  assert.equal(run({ changes }), false);
  assert.equal(run({ changes: { body: { from: "Old" } } }), false);
  assert.equal(run({ changes, action: "synchronize" }), true);
  assert.equal(run({ changes }, { GITHUB_EVENT_NAME: "push" }), true);
  assert.equal(run({ changes }, { SOURCE_HEAD_SHA: repo.base }), true);
  assert.equal(run({ changes }, { SOURCE_BASE_SHA: repo.head }), true);
  for (const pull_request of [
    { ...pullRequest, head: { sha: "unknown" } },
    { ...pullRequest, base: { ref: "main", sha: "unknown" } },
    { ...pullRequest, base: { ...pullRequest.base, ref: "release" } },
    undefined,
  ])
    assert.equal(run({ changes, pull_request }), true);
});

test("PR 152's frozen release target is rejected and retargeting to main is admitted", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const path = join(repo.root, ".git/event.json");
  const event = JSON.parse(readFileSync(path, "utf8"));
  event.action = "edited";
  event.pull_request.base.ref = "codex/windows-frozen-20261021-2";
  writeFileSync(path, JSON.stringify(event));
  const blocked = repo.run("plan");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /SOURCE_PR_TARGET_MAIN_REQUIRED.*main/);
  event.pull_request.base.ref = "main";
  writeFileSync(path, JSON.stringify(event));
  assert.equal(repo.run("plan").status, 0);
  assert.match(
    readFileSync(new URL("../.github/workflows/source-quality.yml", import.meta.url), "utf8"),
    /pull_request:\s+types: \[[^\]]*\bedited\b/,
  );
});

test("packaged Skills and consumed agent inputs stay resources despite Markdown suffixes", (t) => {
  for (const file of [
    "business-resources/demo/skills/demo/SKILL.md",
    "docs/agent-inputs/demo.md",
    "presets/demo.skill.md",
  ]) {
    const repo = fixture(t, { [file]: "before\n" }, { [file]: "after  \n" });
    const result = repo.run("plan");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, "resources", file);
  }
});

test("resource-only checks accept Markdown hard breaks and reject missing packaged references", (t) => {
  const file = "business-resources/demo/skills/demo/SKILL.md";
  const repo = fixture(
    t,
    {
      [file]: "---\nname: demo\ndescription: Demo\n---\nBefore\n",
      "unrelated.js": "broken syntax !",
    },
    { [file]: "---\nname: demo\ndescription: Demo\n---\n[Rules](rules.md)  \n" },
  );
  const missing = repo.run("check");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /RESOURCE_REFERENCE_MISSING.*rules\.md/);
  writeFileSync(join(repo.root, "business-resources/demo/skills/demo/rules.md"), "Rules  \n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "include reference");
  const result = repo.run("check", {
    SOURCE_BASE_SHA: repo.base,
    SOURCE_HEAD_SHA: repo.git("rev-parse", "HEAD"),
  });
  assert.equal(result.status, 0, result.stderr);
});

test("candidate-quality accepts only intended skips and fails closed for failed, cancelled or unknown jobs", (t) => {
  const docs = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const skipped = {
    PLAN_RESULT: "success",
    CHECK_RESULT: "skipped",
    DEPENDENCY_RESULT: "skipped",
    CODEQL_RESULT: "skipped",
    HAS_CODEQL: "true",
  };
  assert.equal(docs.run("final", skipped).status, 0);
  for (const result of ["failure", "cancelled", "", "unknown"]) {
    assert.notEqual(docs.run("final", { ...skipped, PLAN_RESULT: result }).status, 0);
    assert.notEqual(docs.run("final", { ...skipped, CHECK_RESULT: result }).status, 0);
  }
  const resources = fixture(
    t,
    { "business-resources/demo/rules.md": "Before\n" },
    { "business-resources/demo/rules.md": "After\n" },
  );
  assert.equal(resources.run("final", { ...skipped, CHECK_RESULT: "success" }).status, 0);
  assert.notEqual(resources.run("final", skipped).status, 0);
  const code = fixture(
    t,
    { "src/main.js": "export const value = 1;\n" },
    { "src/main.js": "export const value = 2;\n" },
  );
  const success = {
    PLAN_RESULT: "success",
    CHECK_RESULT: "success",
    DEPENDENCY_RESULT: "success",
    CODEQL_RESULT: "success",
    HAS_CODEQL: "true",
  };
  assert.equal(code.run("final", success).status, 0);
  for (const key of ["CHECK_RESULT", "DEPENDENCY_RESULT", "CODEQL_RESULT"])
    for (const result of ["skipped", "failure", "cancelled", "", "unknown"])
      assert.notEqual(
        code.run("final", { ...success, [key]: result }).status,
        0,
        `${key}=${result}`,
      );
});

test("quoted Skill names resolve without engineering preparation and missing names still fail", (t) => {
  for (const name of ['"demo"', "'demo'"]) {
    const file = "business-resources/demo/skills/demo/SKILL.md";
    const repo = fixture(
      t,
      {
        [file]: "---\nname: demo\ndescription: Demo\n---\n",
        "business-resources/demo/prompt.json": '{"skills":["demo"]}',
        "unrelated.js": "broken syntax !",
      },
      { [file]: `---\nname: ${name}\ndescription: Demo\n---\n` },
    );
    const plan = JSON.parse(repo.run("plan").stdout);
    assert.equal(plan.mode, "resources");
    assert.equal(plan.engineering, false);
    const accepted = repo.run("check");
    assert.equal(accepted.status, 0, accepted.stderr);
    writeFileSync(join(repo.root, "business-resources/demo/prompt.json"), '{"skills":["missing"]}');
    repo.git("add", ".");
    repo.git("commit", "-qm", "missing skill reference");
    const missing = repo.run("check", { SOURCE_HEAD_SHA: repo.git("rev-parse", "HEAD") });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /RESOURCE_SKILL_MISSING.*missing/);
  }
});

test("resource declarations reject skills absent from their packaged capability", (t) => {
  const repo = fixture(
    t,
    {
      "business-resources/demo/prompt.json": '{"skills":["demo"]}',
      "business-resources/demo/capability.json": '{"id":"demo","skills":["demo"]}',
      "business-resources/demo/skills/demo/SKILL.md": "---\nname: demo\ndescription: Demo\n---\n",
    },
    { "business-resources/demo/capability.json": '{"id":"demo","skills":["missing"]}' },
  );
  const result = repo.run("check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESOURCE_SKILL_MISSING/);
});

test("declared packaged bytes reject changed content", (t) => {
  const repo = fixture(
    t,
    {
      "business-resources/demo/SOURCE.json":
        '{"files":[{"path":"rules.md","packagedSha256":"invalid"}]}',
      "business-resources/demo/rules.md": "Before\n",
    },
    { "business-resources/demo/rules.md": "After\n" },
  );
  const result = repo.run("check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /RESOURCE_INTEGRITY_MISMATCH/);
});

test("unknown source files and missing bases retain engineering checks", (t) => {
  const repo = fixture(
    t,
    { "docs/rules.md": "Before\n" },
    { "scripts/new-tool.mjs": "export const value = 1;\n" },
  );
  assert.equal(JSON.parse(repo.run("plan").stdout).mode, "code");
  assert.equal(
    JSON.parse(repo.run("plan", { GITHUB_EVENT_PATH: "", SOURCE_BASE_SHA: "" }).stdout).mode,
    "code",
  );
  assert.notEqual(repo.run("plan", { SOURCE_BASE_SHA: "missing-commit" }).status, 0);
  assert.notEqual(repo.run("plan", { SOURCE_HEAD_SHA: repo.base }).status, 0);
});

test("dependency manifests inside a resource package still require engineering and dependency review", (t) => {
  const repo = fixture(
    t,
    { "business-resources/demo/package.json": '{"name":"demo"}' },
    {
      "business-resources/demo/package.json": '{"name":"demo","dependencies":{"example":"1.0.0"}}',
    },
  );
  const result = repo.run("plan");
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, "code");
  assert.equal(plan["dependency-review"], true);
});

test("deleting or renaming a shared Skill rejects consumers that still reference its old name", (t) => {
  for (const rename of [false, true]) {
    const skill = "business-resources/analysis/demo.skill.md";
    const changed = { [skill]: null };
    if (rename)
      changed["business-resources/analysis/renamed.skill.md"] =
        "---\nname: renamed\ndescription: Analysis\n---\n";
    const repo = fixture(
      t,
      {
        [skill]: "---\nname: demo\ndescription: Analysis\n---\n",
        "business-resources/consumer/prompt.json": '{"skills":["demo"]}',
      },
      changed,
    );
    const result = repo.run("check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RESOURCE_SKILL_MISSING.*consumer\/prompt.json.*demo/);
  }
});

test("pull requests compare their merge-base while push events retain the pushed interval", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  repo.git("checkout", "-qb", "target", repo.base);
  writeFileSync(join(repo.root, "new-code.js"), "export const value = 1;\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "target-only code");
  const target = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "--detach", repo.head);
  const pullRequest = repo.run("plan", { SOURCE_BASE_SHA: target });
  assert.equal(pullRequest.status, 0, pullRequest.stderr);
  assert.equal(JSON.parse(pullRequest.stdout).mode, "docs");
  const push = repo.run("plan", { SOURCE_BASE_SHA: target, GITHUB_EVENT_NAME: "push" });
  assert.equal(push.status, 0, push.stderr);
  assert.equal(JSON.parse(push.stdout).mode, "code");
});

test("JavaScript resources retain security scanning without unrelated engineering preparation", (t) => {
  const repo = fixture(
    t,
    { "business-resources/demo/scripts/run.mjs": "export const value = 1;\n" },
    { "business-resources/demo/scripts/run.mjs": "export const value = 2;\n" },
  );
  const planned = repo.run("plan");
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.mode, "resources");
  assert.equal(plan.engineering, false);
  assert.equal(plan["dependency-review"], false);
  assert.equal(plan.codeql, true);
  const results = {
    PLAN_RESULT: "success",
    CHECK_RESULT: "success",
    DEPENDENCY_RESULT: "skipped",
    CODEQL_RESULT: "success",
    HAS_CODEQL: "true",
  };
  assert.equal(repo.run("final", results).status, 0);
  assert.notEqual(repo.run("final", { ...results, CODEQL_RESULT: "skipped" }).status, 0);
});

test("ordinary JavaScript changes check only current changed sources", (t) => {
  const repo = fixture(
    t,
    { "src/main.js": "export const value = 1;\n", "src/old.js": "broken syntax !" },
    { "src/main.js": "export const value = 2;\n", "src/added.cjs": "module.exports = 1;\n" },
  );
  const result = repo.run("check");
  assert.equal(result.status, 0, result.stderr);
});

test("syntax checker and parser inputs expand checks to unchanged tracked sources", (t) => {
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    ".nvmrc",
    "tsconfig.json",
    "babel.config.cjs",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "scripts/source-quality.mjs",
  ]) {
    const repo = fixture(
      t,
      { "src/old.js": "broken syntax !", [file]: file.endsWith(".json") ? "{}" : "before\n" },
      { [file]: file.endsWith(".json") ? '{"changed":true}' : "after\n" },
    );
    const result = repo.run("check");
    assert.notEqual(result.status, 0, file);
    assert.match(result.stderr, /old\.js/);
  }
});

test("unknown changes and missing comparison bases keep full syntax checks", (t) => {
  const repo = fixture(
    t,
    { "src/old.js": "broken syntax !", "src/input.unknown": "before\n" },
    { "src/input.unknown": "after\n" },
  );
  const unknown = repo.run("check");
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /old\.js/);
  const noBase = repo.run("check", { GITHUB_EVENT_PATH: "", SOURCE_BASE_SHA: "" });
  assert.notEqual(noBase.status, 0);
  assert.match(noBase.stderr, /old\.js/);
});

test("ordinary JSON changes skip unchanged invalid JSON and reject changed invalid JSON", (t) => {
  const repo = fixture(
    t,
    { "src/data.json": '{"value":1}', "src/old.json": "invalid JSON" },
    { "src/data.json": '{"value":2}', "src/new.json": '{"added":true}' },
  );
  const accepted = repo.run("check");
  assert.equal(accepted.status, 0, accepted.stderr);
  writeFileSync(join(repo.root, "src/data.json"), "invalid changed JSON");
  repo.git("add", ".");
  repo.git("commit", "-qm", "invalid changed JSON");
  const rejected = repo.run("check", { SOURCE_HEAD_SHA: repo.git("rev-parse", "HEAD") });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /SyntaxError/);
});

test("added and modified JavaScript must parse while deleted sources are not read", (t) => {
  for (const added of [false, true]) {
    const repo = fixture(
      t,
      { "src/main.mjs": "export const value = 1;\n" },
      { [added ? "src/new.cjs" : "src/main.mjs"]: "broken changed syntax !" },
    );
    const result = repo.run("check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, added ? /new\.cjs/ : /main\.mjs/);
  }
  const deleted = fixture(
    t,
    { "src/deleted.js": "broken deleted syntax !", "src/old.js": "broken unchanged syntax !" },
    { "src/deleted.js": null },
  );
  const result = deleted.run("check");
  assert.equal(result.status, 0, result.stderr);
});

test("mixed code and resource changes still parse the complete affected resource group", (t) => {
  const repo = fixture(
    t,
    {
      "src/main.js": "export const value = 1;\n",
      "business-resources/demo/data.json": '{"value":1}',
      "business-resources/demo/run.js": "broken resource syntax !",
    },
    {
      "src/main.js": "export const value = 2;\n",
      "business-resources/demo/data.json": '{"value":2}',
    },
  );
  const result = repo.run("check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run\.js/);
});

test("workflow event planning selects only present changed workflows without preparing tools", (t) => {
  const repo = fixture(
    t,
    { "README.md": "Before\n", ".github/workflows/removed.yaml": "name: old\n" },
    {
      "README.md": "After\n",
      ".github/workflows/removed.yaml": null,
      ".github/workflows/quality.yml": "name: changed\n",
    },
  );
  const output = join(repo.root, ".git/workflow-plan-output");
  const selected = repo.run("plan", { ACTIONLINT: "/missing/actionlint", GITHUB_OUTPUT: output });
  assert.equal(selected.status, 0, selected.stderr);
  const plan = JSON.parse(selected.stdout);
  assert.equal(plan.workflows, true);
  assert.deepEqual(JSON.parse(plan["workflow-files"]), [".github/workflows/quality.yml"]);
  const written = readFileSync(output, "utf8");
  assert.ok(written.includes("workflows=true\n"));
  assert.ok(written.includes('workflow-files=[".github/workflows/quality.yml"]\n'));
  const docs = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const docsPlan = JSON.parse(docs.run("plan", { ACTIONLINT: "/missing/actionlint" }).stdout);
  assert.equal(docsPlan.workflows, false);
  assert.deepEqual(JSON.parse(docsPlan["workflow-files"]), []);
});

test("local preflight checks staged, unstaged and untracked JavaScript before commit", (t) => {
  const repo = fixture(
    t,
    { "package.json": '{"type":"module"}', "src/main.js": "export const value = 1;\n" },
    { "README.md": "Docs\n" },
  );
  const run = () =>
    spawnSync(process.execPath, [cli, "--phase", "check", "--working-tree"], {
      cwd: repo.root,
      encoding: "utf8",
      env: { ...repo.env, GITHUB_EVENT_PATH: "", SOURCE_BASE_SHA: repo.head },
    });
  for (const state of ["unstaged", "staged", "untracked"]) {
    const file = state === "untracked" ? "src/new.js" : "src/main.js";
    writeFileSync(join(repo.root, file), "export const broken = ;\n");
    if (state === "staged") repo.git("add", file);
    const result = run();
    assert.notEqual(result.status, 0, state + ": " + result.stdout);
    assert.match(result.stderr, /SyntaxError/, state);
    if (state === "untracked") rmSync(join(repo.root, file));
    else {
      writeFileSync(join(repo.root, file), "export const value = 1;\n");
      if (state === "staged") repo.git("add", file);
    }
  }
  assert.equal(run().status, 0);
});

test("local preflight validates new resource references before they are tracked", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  const directory = join(repo.root, "business-resources/demo");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    "---\nname: demo\ndescription: Demo\n---\n[Rules](rules.md)\n",
  );
  const run = () =>
    spawnSync(process.execPath, [cli, "--phase", "check", "--working-tree"], {
      cwd: repo.root,
      encoding: "utf8",
      env: { ...repo.env, GITHUB_EVENT_PATH: "", SOURCE_BASE_SHA: repo.head },
    });
  assert.match(run().stderr, /RESOURCE_REFERENCE_MISSING.*rules\.md/);
  writeFileSync(join(directory, "rules.md"), "Rules\n");
  const accepted = run();
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("local preflight requires the pinned validator for an untracked workflow", (t) => {
  const repo = fixture(t, { "README.md": "Before\n" }, { "README.md": "After\n" });
  mkdirSync(join(repo.root, ".github/workflows"), { recursive: true });
  writeFileSync(join(repo.root, ".github/workflows/new.yml"), "name: New\non: push\njobs: {}\n");
  const checked = spawnSync(process.execPath, [cli, "--phase", "check", "--working-tree"], {
    cwd: repo.root,
    encoding: "utf8",
    env: {
      ...repo.env,
      GITHUB_EVENT_PATH: "",
      SOURCE_BASE_SHA: repo.head,
      ACTIONLINT: join(repo.root, ".git/no-actionlint"),
    },
  });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /WORKFLOW_PREFLIGHT_TOOL_REQUIRED.*ACTIONLINT/);
});

test("workflow source plans retain behavior contracts alongside semantic preflight", async (t) => {
  const { selectCiTests } = await import("../../dsh-agent-workbench/scripts/ci-test-plan.mjs");
  const policy = readFileSync(new URL("./ci-test-policy.json", import.meta.url), "utf8");
  const files = { "scripts/ci-test-policy.json": policy };
  for (const pattern of JSON.parse(policy).tests)
    for (const file of globSync(pattern, { cwd: new URL("../", import.meta.url) }))
      files[file] = "export const fixture = true;";
  for (const [workflow, consumers] of [
    ["quality", ["scripts/run-quality-ci.test.mjs", "scripts/run-quality-ci-stages.test.mjs"]],
    [
      "delivery-fixtures",
      ["scripts/delivery-events.test.mjs", "scripts/windows-complete-local/core-cache.test.mjs"],
    ],
    [
      "source-quality",
      ["scripts/source-quality.test.mjs", "scripts/source-formal-receipt.test.mjs"],
    ],
  ]) {
    await t.test(workflow, (t) => {
      const file = `.github/workflows/${workflow}.yml`;
      const repo = fixture(
        t,
        { ...files, [file]: "permissions: {contents: read}\n" },
        { [file]: "permissions: {contents: write}\n" },
      );
      const plan = selectCiTests({
        repositories: [{ repo: "dsh-gea-plugin", path: repo.root, head: repo.head }],
        repo: "dsh-gea-plugin",
        base: repo.base,
        sourceOnly: true,
      });
      for (const consumer of ["scripts/workflow-preflight.test.mjs", ...consumers])
        assert.ok(plan.files.includes(consumer), `${consumer}: ${JSON.stringify(plan)}`);
    });
  }
  for (const [file, expected] of [
    ["scripts/workflow-preflight.mjs", "scripts/workflow-preflight.test.mjs"],
    ["scripts/source-formal-receipt.mjs", "scripts/source-formal-receipt.test.mjs"],
    ["scripts/source-formal-receipt.test.mjs", "scripts/source-formal-receipt.test.mjs"],
  ]) {
    const repo = fixture(
      t,
      { ...files, [file]: "export const revision = 1;" },
      { [file]: "export const revision = 2;" },
    );
    const plan = selectCiTests({
      repositories: [{ repo: "dsh-gea-plugin", path: repo.root, head: repo.head }],
      repo: "dsh-gea-plugin",
      base: repo.base,
      sourceOnly: true,
    });
    assert.deepEqual(plan.files, [expected]);
  }
});

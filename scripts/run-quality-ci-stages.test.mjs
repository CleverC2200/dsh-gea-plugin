import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("the public quality CLI rejects an unknown stage before preparation", () => {
  const result = spawnSync(process.execPath, ["scripts/run-quality-ci.mjs", "--stage", "unknown"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_STAGE_REQUIRED/);
});

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceRoot = resolve(import.meta.dirname, "..");
const fixtureSourceFiles = [
  "run-quality-ci.mjs",
  "business-profile-ci.mjs",
  "quality-ci-stages.mjs",
  "run-quality-checks.mjs",
  "quality-upstreams.mjs",
  "quality-upstreams.json",
  "quality-workbench.mjs",
  "source-profile.mjs",
  "source-combination-integrity.mjs",
  "source-composition.mjs",
  "supported-cores.mjs",
  "ci-platform-tests.mjs",
  "quality-test-reporter.mjs",
  "quality-test-execution.mjs",
  "quality-shards.mjs",
  "quality-runner-environment.mjs",
  "quality-system-chrome.mjs",
  "fixtures/quality-ci-commands.mjs",
  "fixtures/delivery-history/navigation-r7-setup-failure.json.raw",
];
function fixture(t, { additionalTests = [] } = {}) {
  const job = realpathSync(mkdtempSync(join(tmpdir(), "gea-ci-stages-")));
  t.after(() => rmSync(job, { recursive: true, force: true }));
  const write = (file, value) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const json = (file, value) => write(file, JSON.stringify(value));
  const git = (cwd, ...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (cwd) => {
    git(cwd, "init", "-q");
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "frozen fixture source",
    );
    git(cwd, "remote", "add", "source", "https://example.invalid/" + cwd.split("/").at(-1));
    return git(cwd, "rev-parse", "HEAD");
  };
  const gea = join(job, "candidate/dsh-gea-plugin"),
    manage = join(job, "candidate/dsh-agent-manage"),
    workbench = join(job, "source/dsh-agent-workbench"),
    core = join(job, "core-source");
  // Copy only this fixture's authored inputs; parallel quality tests own transient scripts directories.
  for (const file of fixtureSourceFiles)
    write(join(gea, "scripts", file), readFileSync(join(sourceRoot, "scripts", file)));
  const workbenchSource =
    process.env.GEA_FINAL_GROUP_WORKBENCH_SOURCE ?? resolve(sourceRoot, "../dsh-agent-workbench");
  const manageSource =
    process.env.GEA_FINAL_GROUP_MANAGE_SOURCE ?? resolve(sourceRoot, "../dsh-agent-manage");
  for (const file of ["candidate-input.mjs", "ci-test-plan.mjs", "ci-source-policy.mjs"]) {
    mkdirSync(join(workbench, "scripts"), { recursive: true });
    copyFileSync(join(workbenchSource, "scripts", file), join(workbench, "scripts", file));
  }
  for (const file of ["prepare-official-sdk.mjs", "sdk-artifact-cache.mjs"]) {
    mkdirSync(join(manage, "scripts"), { recursive: true });
    copyFileSync(join(manageSource, "scripts", file), join(manage, "scripts", file));
  }
  write(join(core, "pnpm-lock.yaml"), "fixture original core lock\n");
  json(join(core, "package.json"), { packageManager: "pnpm@11.11.0" });
  const coreHead = commit(core);
  json(join(gea, "scripts/supported-cores.json"), [
    {
      head: coreHead,
      nodeMajor: 24,
      lockSha256: hash(readFileSync(join(core, "pnpm-lock.yaml"))),
      packageManager: "pnpm@11.11.0",
    },
  ]);
  const fixed = JSON.parse(readFileSync(join(gea, "scripts/quality-upstreams.json")));
  for (const [name, definition] of [
    ["dsh-genui", fixed.genui],
    ["dsh-better-sidebar", fixed.sidebar],
  ]) {
    const root = join(job, "quality-upstreams/upstream-reference", name);
    json(join(root, "package.json"), {
      packageManager: "pnpm@11.8.0",
      main: "lib/host.js",
      types: "lib/types/host.d.ts",
    });
    write(join(root, "pnpm-lock.yaml"), "fixture upstream lock\n");
    write(join(root, ".gitignore"), "lib/\nnode_modules/\n");
    definition.head = commit(root);
    definition.repository = "https://example.invalid/" + name;
    if (name === "dsh-better-sidebar") {
      definition.lockSha256 = hash(readFileSync(join(root, "pnpm-lock.yaml")));
      definition.packageManager = "pnpm@11.8.0";
      git(root, "config", "--local", "dsh.qualityUpstream", "independent-fixed-sidebar");
      for (const file of [
        "host.js",
        "client.js",
        "invariant.js",
        "client-registry.js",
        "client-editor.js",
        "client-locale.js",
        "client-mermaid.js",
        "types/host.d.ts",
        "types/client/service.d.ts",
      ])
        write(join(root, "lib", file), "fixture output\n");
    }
  }
  const upstreamPackage = join(job, "quality-upstreams/upstream-assets/genui-0.11.3/package.json");
  write(upstreamPackage, "{}\n");
  fixed.genui.files = { "package.json": hash(readFileSync(upstreamPackage)) };
  json(join(gea, "scripts/quality-upstreams.json"), fixed);
  const packages = [
    [workbench, "@cleverc2200/dsh-agent-workbench", "npm@11.11.0", "package-lock.json"],
    [manage, "dsh-agent-manage", "pnpm@11.27.0", "pnpm-lock.yaml"],
    [gea, "@cleverc2200/gea-dsh-prototype", "pnpm@11.27.0", "pnpm-lock.yaml"],
  ];
  for (const [root, name, packageManager, lock] of packages) {
    json(join(root, "package.json"), {
      name,
      packageManager,
      type: "module",
      ...(root === manage ? { exports: { "./client": "./client/client.js" } } : {}),
    });
    write(join(root, lock), "{}\n");
    write(join(root, ".gitignore"), "lib/\nclient/\nnode_modules/\n.runtime/\n");
  }
  json(join(workbench, "tsconfig.official.json"), {
    compilerOptions: {
      paths: {
        "@deepseek-ai/cordis": [
          "../../official-latest-standard/vendor/cordis/lib/types/index.d.ts",
        ],
      },
    },
  });
  const workbenchHead = commit(workbench),
    manageHead = commit(manage);
  const baseline = {
    repositories: [
      { repo: "dsh-agent-workbench", head: workbenchHead },
      { repo: "dsh-agent-manage", head: manageHead },
      { repo: "dsh-gea-plugin", head: "a".repeat(40) },
    ],
  };
  json(join(gea, "scripts/quality-peer-baseline.json"), baseline);
  json(join(gea, "scripts/ci-test-policy.json"), {
    schemaVersion: 1,
    required: ["scripts/stage-fixture.test.mjs", ...additionalTests],
    tests: ["scripts/stage-fixture.test.mjs", ...additionalTests],
    rules: [],
  });
  write(
    join(gea, "scripts/stage-fixture.test.mjs"),
    `import test from 'node:test'; import assert from 'node:assert/strict'; import { existsSync, readFileSync, appendFileSync } from 'node:fs'; import { loadBusinessProfilePolicy } from './business-profile-ci.mjs'; test('fixed environment reaches a real test process', {skip: process.env.FIXTURE_SKIP === 'true'}, async () => { assert.equal(process.env.QUALITY_POLICY_WORKBENCH, ${JSON.stringify(workbench)}); const policy = await loadBusinessProfilePolicy(process.env.QUALITY_POLICY_WORKBENCH); assert.equal(policy.matchesProductSource(true, ['scripts/run-quality-ci.mjs']), true); assert.equal(policy.matchesProductSource(true, ['src/host.ts']), false); for (const key of ['GEA_PLUGIN_UPDATE_SDK', 'GEA_TEST_CANDIDATE_INPUTS']) { assert.ok(existsSync(process.env[key]), key); assert.ok(!process.env[key].includes('stale')); } assert.equal(JSON.parse(readFileSync(process.env.GEA_TEST_CANDIDATE_INPUTS)).core, ${JSON.stringify(coreHead)}); appendFileSync(${JSON.stringify(join(job, "tests-executed"))}, 'test ran\\n'); if (process.env.FIXTURE_FAIL === 'tests') assert.fail('controlled test failure'); });`,
  );
  for (const file of additionalTests)
    write(
      join(gea, file),
      "import test from 'node:test'; test('selected public file', () => {});\n",
    );
  const geaHead = commit(gea);
  const manifest = {
    core: coreHead,
    repositories: [
      { repo: "dsh-agent-workbench", path: workbench, head: workbenchHead },
      { repo: "dsh-agent-manage", path: manage, head: manageHead },
      { repo: "dsh-gea-plugin", path: gea, head: geaHead },
    ],
  };
  const input = join(job, "candidate-input.json");
  json(input, manifest);
  // Only OS command boundaries are controlled. Admission, Git, plan, receipts and tests execute real code.
  const preload = join(gea, "scripts/fixtures/quality-ci-commands.mjs");
  const summary = join(job, "summary.md");
  const run = (stage, extra = {}, args = [], execution = {}) => {
    const env = {
      ...process.env,
      NODE_OPTIONS: `--import=${preload}`,
      QUALITY_STAGE_FIXTURE_ROOT: job,
      QUALITY_BASE_SHA: geaHead,
      GITHUB_STEP_SUMMARY: summary,
      QUALITY_POLICY_WORKBENCH: "/stale/policy",
      GEA_TEST_CANDIDATE_INPUTS: "/stale/candidate",
      GEA_TEST_SOURCE_INPUTS: "/stale/sources",
      ...extra,
    };
    for (const key of ["CI", "QUALITY_EXPECTED_SHA", "NODE_TEST_CONTEXT"])
      if (!Object.hasOwn(extra, key)) delete env[key];
    return spawnSync(
      process.execPath,
      [
        "scripts/run-quality-ci.mjs",
        ...(stage === undefined ? [] : ["--stage", stage]),
        "--prepare-sdk",
        "--prepare-inputs",
        "--input",
        input,
        "--final-group-sha256",
        hash(readFileSync(input)),
        "--final-group-workbench",
        workbench,
        "--core-source",
        core,
        ...args,
      ],
      { cwd: gea, env, encoding: "utf8", ...execution },
    );
  };
  return {
    job,
    gea,
    input,
    run,
    summary,
    head: geaHead,
    stageFile: join(job, "quality-stages.json"),
    read: () => JSON.parse(readFileSync(join(job, "quality-stages.json"))),
  };
}

test("separate CLI processes prepare once, preserve the plan, restore fixed environment and summarize real stages", (t) => {
  const f = fixture(t);
  for (const stage of ["prepare", "build", "checks", "tests", "summary"]) {
    const result = f.run(stage);
    assert.equal(result.status, 0, stage + ": " + result.stdout + result.stderr);
  }
  const record = f.read();
  assert.equal(record.status, "passed");
  assert.deepEqual(Object.keys(record.stages), ["prepare", "build", "checks", "tests"]);
  for (const stage of Object.values(record.stages)) {
    assert.equal(stage.status, "passed");
    assert.ok(stage.durationMs >= 0);
    assert.ok(stage.finishedAt >= stage.startedAt);
  }
  assert.equal(record.checks.length, 3);
  assert.ok(existsSync(join(f.job, "tests-executed")));
  assert.match(readFileSync(f.summary, "utf8"), /Completed-stage summary/);
  const commands = readFileSync(join(f.job, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    commands.filter((entry) => entry.command === "sdk" && entry.args.includes("--prepare")).length,
    1,
  );
  assert.equal(commands.filter((entry) => entry.command === "sdk").length, 5);
});

test("the public plan stage reports the complete selection before any preparation or runtime writes", (t) => {
  const f = fixture(t);
  const result = f.run("plan");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(plan.selected, ["scripts/stage-fixture.test.mjs"]);
  assert.deepEqual(
    plan.shards.map((shard) => shard.files),
    [["scripts/stage-fixture.test.mjs"]],
  );
  assert.equal(plan.estimates.unknownFiles, 1);
  assert.equal(plan.shards[0].estimatedMs, null);
  assert.equal(existsSync(join(f.job, "commands.jsonl")), false);
  assert.equal(existsSync(f.stageFile), false);
  assert.equal(existsSync(join(f.job, "official-latest-standard")), false);
  assert.equal(existsSync(join(f.gea, ".runtime")), false);
});

test("the public CLI refuses unsupported file concurrency before preparation", (t) => {
  const f = fixture(t);
  for (const value of [
    "0",
    "1",
    "5",
    "03",
    "3.0",
    "3e0",
    " 3",
    "3 ",
    "3\n",
    "04",
    "4.0",
    "NaN",
    "",
  ]) {
    const result = f.run("plan", {}, ["--test-file-concurrency", value]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /QUALITY_TEST_CONCURRENCY_REQUIRED/);
  }
  assert.equal(existsSync(join(f.job, "commands.jsonl")), false);
  assert.equal(existsSync(f.stageFile), false);
});

for (const concurrency of [3, 4])
  test(`explicit ${concurrency}-file CLI plans bind every stage and reject omitted or changed settings`, (t) => {
    const f = fixture(t),
      flag = ["--test-file-concurrency", String(concurrency)];
    const result = f.run("plan", {}, flag);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.concurrency, concurrency);
    assert.equal(plan.estimates.unknownFiles, 1);
    assert.equal(plan.estimates.estimatedMs, null);
    const file = join(f.job, "frozen-plan.json");
    writeFileSync(file, JSON.stringify(plan));
    const args = [...flag, "--execution-plan", file];
    for (const stage of ["prepare", "build", "checks", "tests", "summary"]) {
      const omitted = f.run(stage, {}, ["--execution-plan", file]);
      assert.equal(omitted.status, 1);
      assert.match(omitted.stderr, /QUALITY_TEST_PLAN_CHANGED/);
      const changed = f.run(stage, {}, [
        "--execution-plan",
        file,
        "--test-file-concurrency",
        concurrency === 3 ? "4" : "2",
      ]);
      assert.equal(changed.status, 1);
      assert.match(changed.stderr, /QUALITY_TEST_PLAN_CHANGED/);
      const execution = f.run(stage, {}, args);
      assert.equal(execution.status, 0, stage + execution.stdout + execution.stderr);
    }
    const receipt = JSON.parse(readFileSync(join(f.job, "quality-test-execution.json")));
    assert.equal(receipt.capacity.status, "passed");
    assert.equal(receipt.capacity.concurrency, concurrency);
    if (concurrency === 3)
      assert.deepEqual(receipt.results[0].libuvPool, {
        status: "declared",
        size: 4,
        activeFiles: 1,
        availableParallelism: receipt.capacity.observed.availableParallelism,
        source: "capacity.observed.availableParallelism",
      });
    else assert.equal(Object.hasOwn(receipt.results[0], "libuvPool"), false);
    assert.equal(f.read().binding.executionPlan.planSha256, plan.planSha256);
    assert.equal(
      f.run("verify-tests", {}, [
        ...args,
        "--test-results",
        join(f.job, "quality-test-execution.json"),
      ]).status,
      0,
    );
  });

test("the public plan keeps unknown timings and every selected file in nonempty deterministic groups", (t) => {
  const f = fixture(t, { additionalTests: ["tests/slow.test.mjs", "tests/unknown.test.mjs"] });
  const timings = join(f.job, "timings.json");
  writeFileSync(
    timings,
    JSON.stringify({
      source: { runId: "measured-fixture", platform: process.platform, concurrency: 2 },
      files: [
        { file: "tests/slow.test.mjs", durationMs: 300 },
        { file: "scripts/stage-fixture.test.mjs", durationMs: 100 },
      ],
    }),
  );
  const run = () => f.run("plan", {}, ["--test-timings", timings, "--test-shards", "8"]);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.shards.length, 3);
  assert.ok(plan.shards.every((shard) => shard.files.length > 0));
  assert.deepEqual(plan.shards.flatMap((shard) => shard.files).sort(), plan.selected);
  assert.equal(plan.estimates.knownFiles, 2);
  assert.equal(plan.estimates.unknownFiles, 1);
  assert.equal(plan.estimates.knownSumMs, 400);
  assert.equal(plan.estimates.estimatedMs, null);
  assert.equal(
    plan.shards.find((shard) => shard.files.includes("tests/unknown.test.mjs")).estimatedMs,
    null,
  );
  assert.deepEqual(JSON.parse(run().stdout), plan);
});

test("the public staged test entry proves every actual file exactly once and rechecks its receipts", (t) => {
  const f = fixture(t);
  for (const stage of ["prepare", "build", "checks", "tests"]) {
    const result = f.run(stage);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const receipt = join(f.job, "quality-test-execution.json");
  const record = JSON.parse(readFileSync(receipt));
  assert.equal(record.status, "passed");
  assert.equal(record.results.length, 1);
  assert.deepEqual(
    record.results[0].report.files.map((file) => file.file),
    ["scripts/stage-fixture.test.mjs"],
  );
  assert.equal(record.results[0].report.files[0].startCount, 1);
  const checked = f.run("verify-tests", {}, ["--test-results", receipt]);
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(JSON.parse(checked.stdout).status, "passed");
  const oldAttempt = f.run("verify-tests", { GITHUB_RUN_ATTEMPT: "different-attempt" }, [
    "--test-results",
    receipt,
  ]);
  assert.equal(oldAttempt.status, 1);
  assert.match(oldAttempt.stderr, /QUALITY_STAGE_INPUT_CHANGED/);
  record.results[0].report.files[0].startCount = 2;
  writeFileSync(receipt, JSON.stringify(record));
  const duplicate = f.run("verify-tests", {}, ["--test-results", receipt]);
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /QUALITY_TEST_EXECUTION_REJECTED/);
});

test("checks failure blocks real tests and the final receipt fails", (t) => {
  const f = fixture(t);
  for (const stage of ["prepare", "build"]) assert.equal(f.run(stage).status, 0);
  assert.equal(f.run("checks", { FIXTURE_FAIL: "checks" }).status, 1);
  assert.equal(f.run("tests").status, 1);
  assert.equal(existsSync(join(f.job, "tests-executed")), false);
  assert.equal(f.run("summary").status, 1);
  assert.deepEqual(
    f.read().checks.map((entry) => entry.status),
    ["passed", "failed"],
  );
});

test("summary revalidates build artifacts instead of trusting passed stage JSON", (t) => {
  const f = fixture(t);
  for (const stage of ["prepare", "build", "checks", "tests"]) assert.equal(f.run(stage).status, 0);
  writeFileSync(join(f.gea, "lib/host.js"), "substituted output\n");
  const result = f.run("summary");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /QUALITY_STAGE_ARTIFACT_CHANGED/);
});

test("prepare or build failures block dependent stages and missing receipts cannot summarize green", (t) => {
  for (const fail of ["prepare", "build"]) {
    const f = fixture(t);
    if (fail === "build") assert.equal(f.run("prepare").status, 0);
    assert.equal(f.run(fail, { FIXTURE_FAIL: fail }).status, 1);
    assert.equal(f.run("checks").status, 1);
    assert.equal(f.run("tests").status, 1);
    assert.equal(f.run("summary").status, 1);
    assert.equal(existsSync(join(f.job, "tests-executed")), false);
  }
  const empty = fixture(t);
  assert.equal(empty.run("build").status, 1);
  assert.equal(empty.run("summary").status, 1);
  assert.equal(empty.read().status, "failed");
  assert.match(readFileSync(empty.summary, "utf8"), /missing/);
});

test("cancelled processes retain running receipts and summary refuses cancellation or skipped steps", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  assert.equal(f.run("build").status, 0);
  const cancelled = f.run("checks", { FIXTURE_BLOCK: "checks" }, [], { timeout: 1000 });
  assert.equal(cancelled.signal, "SIGTERM");
  assert.equal(f.read().stages.checks.status, "running");
  assert.equal(f.run("tests").status, 1);
  assert.equal(f.run("summary").status, 1);
  const good = fixture(t);
  for (const stage of ["prepare", "build", "checks", "tests"])
    assert.equal(good.run(stage).status, 0);
  const results = {
    CI: "true",
    QUALITY_EXPECTED_SHA: good.head,
    QUALITY_STAGE_PREPARE_RESULT: "success",
    QUALITY_STAGE_BUILD_RESULT: "success",
    QUALITY_STAGE_CHECKS_RESULT: "success",
    QUALITY_STAGE_TESTS_RESULT: "success",
  };
  assert.equal(good.run("summary", results).status, 0);
  for (const value of ["cancelled", "skipped", "failure", ""])
    assert.equal(good.run("summary", { ...results, QUALITY_STAGE_TESTS_RESULT: value }).status, 1);
});

test("the default full CLI starts real tests only after passed checks", (t) => {
  for (const fail of [undefined, "checks", "tests"]) {
    const f = fixture(t);
    const result = f.run(undefined, { FIXTURE_FAIL: fail });
    assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
    assert.equal(existsSync(join(f.job, "tests-executed")), fail !== "checks");
    assert.equal(f.read().checks.length, fail === "checks" ? 2 : 3);
  }
});

test("later stages reject changed input bytes, source drift, plan changes and altered build outputs", (t) => {
  const f = fixture(t);
  assert.equal(f.run("prepare").status, 0);
  appendFileSync(f.input, "\n");
  assert.match(f.run("build").stderr, /QUALITY_STAGE_INPUT_CHANGED/);
  writeFileSync(f.input, readFileSync(f.input, "utf8").slice(0, -1));
  assert.match(
    f.run("build", {}, ["--final-group-sha256", "0".repeat(64)]).stderr,
    /CANDIDATE_INPUT_HASH/,
  );
  writeFileSync(join(f.gea, "changed-source.txt"), "dirty\n");
  assert.match(f.run("build").stderr, /CANDIDATE_DIRTY/);
  rmSync(join(f.gea, "changed-source.txt"));
  const record = f.read();
  record.binding.plan.files = [];
  writeFileSync(f.stageFile, JSON.stringify(record));
  assert.match(f.run("build").stderr, /QUALITY_STAGE_INPUT_CHANGED/);
});

test("a required fixture skip fails the staged test entry and final summary", (t) => {
  const f = fixture(t);
  for (const stage of ["prepare", "build", "checks"]) assert.equal(f.run(stage).status, 0);
  const skipped = f.run("tests", { FIXTURE_SKIP: "true" });
  assert.equal(skipped.status, 1, skipped.stdout + skipped.stderr);
  assert.match(skipped.stderr, /QUALITY_REQUIRED_TEST_SKIPPED/);
  assert.equal(f.run("summary").status, 1);
});

test("a frozen worker executes only its assigned shard and cannot claim complete coverage", (t) => {
  const f = fixture(t, { additionalTests: ["tests/worker-only.test.mjs"] });
  const flags = ["--test-shards", "2"];
  const planned = f.run("plan", {}, flags);
  assert.equal(planned.status, 0, planned.stderr);
  const plan = JSON.parse(planned.stdout);
  const planFile = join(f.job, "worker-plan.json");
  writeFileSync(planFile, planned.stdout);
  for (const stage of ["prepare", "build", "checks"])
    assert.equal(f.run(stage, {}, flags).status, 0, stage);
  const shard = plan.shards.find((entry) => entry.files.includes("tests/worker-only.test.mjs"));
  const workerFlags = [...flags, "--execution-plan", planFile, "--test-shard", shard.id];
  const result = f.run("tests", {}, workerFlags);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(f.job, "tests-executed")), false, "unassigned file must not run");
  const receipt = JSON.parse(readFileSync(join(f.job, "quality-test-execution.json")));
  assert.equal(receipt.scope, "shard");
  assert.equal(receipt.results.length, 1);
  assert.equal(receipt.results[0].shardId, shard.id);
  const incomplete = f.run("verify-tests", {}, [...flags, "--execution-plan", planFile]);
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /QUALITY_TEST_EXECUTION_REJECTED/);
});

test("automatic metadata routing freezes one shard before preparation and later stages reject rerouting", (t) => {
  const f = fixture(t, { additionalTests: ["tests/metadata-only.test.mjs"] }),
    planned = f.run("plan", {}, ["--test-shards", "auto"]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  const plan = JSON.parse(planned.stdout);
  assert.equal(plan.shards.length, 1);
  assert.equal(existsSync(join(f.job, "commands.jsonl")), false);
  const file = join(f.job, "quality-test-execution-plan.json");
  writeFileSync(file, planned.stdout);
  const flags = ["--test-shards", "1", "--execution-plan", file];
  const prepared = f.run("prepare", {}, flags);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  assert.equal(
    readFileSync(file, "utf8"),
    planned.stdout,
    "later stages preserve original plan bytes",
  );
  const changed = f.run("build", {}, ["--test-shards", "2", "--execution-plan", file]);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /QUALITY_TEST_PLAN_CHANGED/);
});

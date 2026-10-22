import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/delivery-fixtures.yml", "utf8"));

test("delivery retains PR and manual contexts without empty main push runs", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "workflow_dispatch"]);
  assert.equal(workflow.on.pull_request, null);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), [
    "mac_complete_input",
    "native_acceptance_bundle_sha256",
    "native_acceptance_bundle_url",
    "source_types_input",
    "windows_complete_input",
  ]);
  for (const input of Object.values(inputs)) {
    assert.equal(input.type, "string");
    assert.equal(input.required, false);
  }
});

test("macOS complete packaging requires explicit manual input and a fixed company Core", () => {
  const job = workflow.jobs["mac-complete-package"];
  assert.equal(
    job.if,
    "github.event_name == 'workflow_dispatch' && inputs.mac_complete_input != ''",
  );
  assert.equal(job.env.DSH_DESKTOP_TARGET_PLATFORM, "darwin");
  assert.equal(job.env.DSH_DESKTOP_TARGET_ARCH, "arm64");
  const checkout = job.steps.find(
    (step) => step.with?.repository === "CleverC2200/deepseek-harness",
  );
  assert.equal(checkout.with.ref, job.env.DSH_DESKTOP_BUILD_COMMIT);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(
    job.steps.some(
      (step) =>
        step.run === 'node gea/scripts/mac-complete-local/build.mjs core gea "$GEA_DESKTOP_INPUT"',
    ),
  );
});

test("Windows complete packaging uses its own input or Native bundle without selecting macOS", () => {
  assert.equal(
    workflow.jobs["windows-complete-package"].if,
    "github.event_name == 'workflow_dispatch' && (inputs.windows_complete_input != '' || inputs.native_acceptance_bundle_url != '' || inputs.native_acceptance_bundle_sha256 != '')",
  );
});

test("standalone delivery retains package Prompt and source checks while candidate quality owns same-repository events", () => {
  const job = workflow.jobs["delivery-fixtures"];
  const steps = job.steps;
  assert.equal(
    job.if,
    "github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)",
  );
  assert.deepEqual(
    steps
      .filter((step) => /^(?:node --(?:run|test)|npm run) /.test(step.run ?? ""))
      .map((step) => step.run),
    [
      "node --run test:release-source",
      "npm run test:delivery:packages",
      "node --run test:delivery",
      "node --run test:fixture-inputs",
      "node --run test:prompt-execution",
      "node --test tests/explicit-source-contract.test.mjs tests/source-composition.test.mjs",
    ],
  );
  const packageScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
  for (const name of [
    "test:release-source",
    "test:delivery:packages",
    "test:delivery",
    "test:fixture-inputs",
    "test:prompt-execution",
  ])
    assert.equal(typeof packageScripts[name], "string", name);
});

test("complete delivery verifies exact Core outputs and cold tools before compiling", () => {
  for (const [name, profile] of [
    ["mac-complete-package", "host"],
    ["windows-complete-package", "official"],
  ]) {
    const job = workflow.jobs[name];
    const steps = job.steps;
    const restore = steps.findIndex((step) => step.id === "delivery-core-restore");
    const preflight = steps.findIndex((step) => step.name === "Preflight cold packaging tools");
    const install = steps.findIndex((step) => step.name === "Prepare declared Core toolchain");
    assert.ok(install >= 0 && preflight > install && restore > preflight, name);
    assert.match(steps[preflight].run, new RegExp(`core-cache\\.mjs preflight core ${profile}`));
    assert.equal(steps[restore].uses, "actions/cache/restore@v4");
    assert.equal(steps[restore].with.key, "${{ steps.delivery-core-plan.outputs.key }}");
    assert.equal(steps[restore].with["restore-keys"], undefined);
    assert.equal(steps[restore].with.path, "${{ steps.delivery-core-plan.outputs.paths }}");
    const downloads = steps.find((step) => step.id === "delivery-downloads");
    assert.equal(downloads.uses, "actions/cache@v4");
    assert.doesNotMatch(downloads.with.path, /node_modules|profile|seed|install/);
    const afterPackaging = steps.findIndex(
      (step) => step.name === "Verify Core output after packaging",
    );
    const packaging = steps.findIndex((step) => step.name?.startsWith("Build full "));
    const saveIndex = steps.findIndex((step) => step.uses === "actions/cache/save@v4");
    assert.ok(afterPackaging > packaging && saveIndex > afterPackaging, name);
    assert.match(steps[afterPackaging].run, new RegExp(`core-cache\\.mjs verify core ${profile}`));
    const save = steps[saveIndex];
    assert.equal(save.with.key, "${{ steps.delivery-core-plan.outputs.key }}");
    assert.equal(save.with.path, "${{ steps.delivery-core-plan.outputs.paths }}");
  }
});

test("verified Core can be saved after wrapper failure without hiding the failed delivery", () => {
  for (const name of ["mac-complete-package", "windows-complete-package"]) {
    const steps = workflow.jobs[name].steps;
    const verify = steps.find((step) => step.name === "Verify Core output after packaging");
    const save = steps.find((step) => step.name === "Save verified compiled Core");
    const packaging = steps.find((step) => step.name?.startsWith("Build full "));
    assert.equal(verify.id, "delivery-core-after-package");
    assert.equal(verify.if, "!cancelled() && steps.delivery-core-plan.outcome == 'success'");
    assert.equal(
      save.if,
      "!cancelled() && steps.delivery-core-after-package.outputs.hit == 'true' && steps.delivery-core-restore.outputs.cache-hit != 'true'",
    );
    assert.equal(packaging["continue-on-error"], undefined);
    const eligible = (condition, steps, cancelled = false) =>
      Function(
        "cancelled",
        "steps",
        `return (${condition.replace(/steps\.([\w-]+)(?:\.outputs\.([\w-]+))?/g, (_, id, output) =>
          output ? `steps["${id}"].outputs["${output}"]` : `steps["${id}"]`,
        )})`,
      )(() => cancelled, steps);
    const context = {
      "delivery-core-plan": { outcome: "success" },
      "delivery-core-after-package": { outputs: { hit: "true" } },
      "delivery-core-restore": { outputs: { "cache-hit": "false" } },
    };
    assert.equal(eligible(verify.if, context), true);
    assert.equal(eligible(save.if, context), true);
    assert.equal(eligible(verify.if, context, true), false);
    assert.equal(eligible(save.if, context, true), false);
    context["delivery-core-plan"].outcome = "failure";
    assert.equal(eligible(verify.if, context), false);
    for (const hit of ["false", "", undefined]) {
      context["delivery-core-after-package"].outputs.hit = hit;
      assert.equal(eligible(save.if, context), false);
    }
    context["delivery-core-after-package"].outputs.hit = "true";
    context["delivery-core-restore"].outputs["cache-hit"] = "true";
    assert.equal(eligible(save.if, context), false);
  }
});

test("manual delivery runs dependency-free Core cache fixtures on Windows and macOS", () => {
  const job = workflow.jobs["core-cache-fixtures"];
  assert.ok(job);
  assert.equal(job.if, "github.event_name == 'workflow_dispatch'");
  assert.deepEqual(job.strategy.matrix.os, ["windows-2025", "macos-15"]);
  assert.equal(job.strategy["fail-fast"], false);
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.needs, undefined);
  assert.deepEqual(job.steps, [
    { uses: "actions/checkout@v4", with: { "persist-credentials": false } },
    { uses: "actions/setup-node@v4", with: { "node-version": "24.14.1" } },
    { run: "node --test scripts/windows-complete-local/core-cache.test.mjs" },
  ]);
});

test("real source types prepare only for an explicit manual tuple and preserve existing admission", () => {
  const input = workflow.on.workflow_dispatch.inputs.source_types_input;
  assert.equal(input.default, "");
  const steps = workflow.jobs["delivery-fixtures"].steps.filter((step) =>
    step.name?.startsWith("Source types:"),
  );
  assert.ok(steps.length > 0);
  for (const step of steps) {
    assert.ok(
      step.if.includes(
        "github.event_name == 'workflow_dispatch' && inputs.source_types_input != ''",
      ),
    );
    assert.equal(
      step["continue-on-error"],
      step.uses === "actions/cache/save@v4" ? true : undefined,
    );
  }
  const code = steps.map((step) => step.run ?? "").join("\n");
  for (const contract of [
    "read-hosted-peer-input.mjs",
    "write-hosted-group.mjs",
    "readFinalGroup",
    "prepareQualityUpstreams",
    "bindQualityUpstreamInputs",
    "acquireBuild",
    "verifyOfficialSDK",
    "checkTypes(",
  ])
    assert.ok(code.includes(contract), contract);
  assert.match(code, /--prepare --reuse-prepared --with-flock/);
  assert.match(code, /ciCores\('required'\)/);
  assert.doesNotMatch(code, /current-core|adaptation/);
  assert.doesNotMatch(code, /affected-check|run-quality-ci|SOURCE_BASE_SHA|plan\.typecheck/);
});

test("manual source type input binds exactly three commits to the actual GEA dispatch", (t) => {
  const step = workflow.jobs["delivery-fixtures"].steps.find(
    (step) => step.id === "source-types-input",
  );
  const script = step.run.match(/<<'NODE'[^\n]*\n([\s\S]*?)\nNODE/)[1];
  const directory = mkdtempSync(join(tmpdir(), "source-types-event-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tuple = { workbench: "1".repeat(40), manage: "2".repeat(40), gea: "3".repeat(40) };
  const output = join(directory, "output");
  const env = {
    ...process.env,
    SOURCE_TYPES_INPUT: JSON.stringify(tuple),
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "CleverC2200/dsh-gea-plugin",
    GITHUB_SHA: tuple.gea,
    GITHUB_OUTPUT: output,
  };
  const run = (extra) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  assert.equal(run({}).status, 0);
  assert.equal(
    readFileSync(output, "utf8"),
    `workbench=${tuple.workbench}\nmanage=${tuple.manage}\ngea=${tuple.gea}\n`,
  );
  for (const extra of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REPOSITORY: "other/repository" },
    { GITHUB_SHA: "4".repeat(40) },
    { SOURCE_TYPES_INPUT: JSON.stringify({ ...tuple, manage: "short" }) },
    { SOURCE_TYPES_INPUT: JSON.stringify({ ...tuple, extra: "4".repeat(40) }) },
    { SOURCE_TYPES_INPUT: JSON.stringify({ workbench: tuple.workbench, manage: tuple.manage }) },
  ])
    assert.notEqual(run(extra).status, 0, JSON.stringify(extra));
});

test("manual source type inline Node programs are valid without preparing dependencies", () => {
  for (const step of workflow.jobs["delivery-fixtures"].steps.filter(
    (step) => step.name?.startsWith("Source types:") && step.run?.includes("<<'NODE'"),
  )) {
    const script = step.run.match(/<<'NODE'[^\n]*\n([\s\S]*?)\nNODE/)[1];
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], {
      input: script,
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, `${step.name}: ${checked.stderr}`);
  }
});

test("manual type diagnostics retain the prepared SDK and attempt every owner before failing", () => {
  const job = workflow.jobs["delivery-fixtures"],
    steps = job.steps;
  assert.equal(job["timeout-minutes"], 60);
  const index = (name) => steps.findIndex((step) => step.name === "Source types: " + name);
  const prepared = index("prepare or verify the SDK once"),
    saved = index("save only the verified SDK cache");
  assert.ok(
    prepared >= 0 &&
      saved > prepared &&
      saved < index("prepare locked owner dependencies and existing upstreams"),
  );
  const smoke = steps[index("run the four real configurations and retain source identity")].run;
  assert.match(
    smoke,
    /for \(const entry of manifest\.repositories\) \{\s*process\.chdir\(entry\.path\);\s*let sdk;\s*try \{/,
  );
  assert.match(
    smoke,
    /completed\.push\(\{ repo: entry\.repo, head: entry\.head, sdk, status: 'failed'/,
  );
  assert.match(smoke, /failure \?\?= error/);
  assert.ok(smoke.indexOf("await readFinalGroup") > smoke.indexOf("status: 'failed'"));
  assert.ok(smoke.includes("if (failure) throw failure"));
});

test("delivery job environment excludes contexts unavailable at job initialization", () => {
  for (const [name, job] of Object.entries(workflow.jobs))
    assert.doesNotMatch(JSON.stringify(job.env ?? {}), /\$\{\{\s*(?:runner|env|steps|job)\./, name);
});

test("delivery initializes isolated download paths after Node setup through the runtime environment", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-runtime-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["mac-complete-package", "windows-complete-package"]) {
    const steps = workflow.jobs[name].steps;
    const initialized = steps.findIndex(
      (step) => step.name === "Initialize isolated delivery download paths",
    );
    assert.ok(initialized > steps.findIndex((step) => step.uses === "actions/setup-node@v4"));
    assert.ok(initialized < steps.findIndex((step) => step.id === "delivery-tool-path"));
    const output = join(directory, name + "-env");
    const result = spawnSync("sh", ["-c", steps[initialized].run], {
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: directory, GITHUB_ENV: output },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(output, "utf8"),
      `COREPACK_HOME=${join(directory, "delivery-downloads/corepack")}\nELECTRON_CACHE=${join(directory, "delivery-downloads/electron")}\nELECTRON_BUILDER_CACHE=${join(directory, "delivery-downloads/electron-builder")}\n`,
    );
  }
});

test("manual type step preserves a failing process status and its tee diagnostics", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "delivery-type-failure-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, ".runtime/source-types"), { recursive: true });
  const step = workflow.jobs["delivery-fixtures"].steps.find(
    (step) =>
      step.name === "Source types: run the four real configurations and retain source identity",
  );
  const result = spawnSync(
    "bash",
    [
      "-e",
      "-c",
      `node() { printf 'SOURCE_TYPES_FAILED: real configuration\\n' >&2; return 37; }\n${step.run}`,
    ],
    {
      cwd: directory,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.equal(step["continue-on-error"], undefined);
  assert.match(
    readFileSync(join(directory, ".runtime/source-types/checks.log"), "utf8"),
    /SOURCE_TYPES_FAILED: real configuration/,
  );
});

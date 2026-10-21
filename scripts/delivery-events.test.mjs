import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

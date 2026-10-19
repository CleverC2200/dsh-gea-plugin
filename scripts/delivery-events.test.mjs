import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/delivery-fixtures.yml", "utf8"));

test("delivery retains PR main and manual contexts while feature pushes use their PR", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.equal(workflow.on.pull_request, null);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs).sort(), [
    "native_acceptance_bundle_sha256",
    "native_acceptance_bundle_url",
    "windows_complete_input",
  ]);
  for (const input of Object.values(inputs)) {
    assert.equal(input.type, "string");
    assert.equal(input.required, false);
  }
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

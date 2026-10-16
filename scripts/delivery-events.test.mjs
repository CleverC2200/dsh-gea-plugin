import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/delivery-fixtures.yml", "utf8"));

test("delivery retains PR main and manual contexts while feature pushes use their PR", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.equal(workflow.on.pull_request, null);
  assert.equal(workflow.on.workflow_dispatch, null);
});

test("delivery keeps ordinary package Prompt and source checks plus the authorized desktop lane", () => {
  const steps = workflow.jobs["delivery-fixtures"].steps;
  assert.deepEqual(
    steps
      .filter((step) => step.if === "steps.scope.outputs.bootstrap != 'true'")
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
  assert.deepEqual(
    steps
      .filter((step) => step.if === "steps.scope.outputs.bootstrap == 'true'")
      .map((step) => step.run),
    [
      "node --test scripts/plugin-update-pr-lane.test.mjs",
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

import test from "node:test";
import assert from "node:assert/strict";
import { selectPluginUpdateLane } from "./plugin-update-pr-lane.mjs";
const input = {
  event: "pull_request",
  repository: "CleverC2200/dsh-gea-plugin",
  pr: "59",
  branch: "codex/plugin-list-updates-pr-20261014",
  ownRepository: "CleverC2200/dsh-gea-plugin",
  ancestor: true,
  paths: ["scripts/run-quality-ci.mjs"],
};
test("only authorized unchanged source and its merge use the targeted gate", () => {
  assert.equal(selectPluginUpdateLane(input), "plugin-updates");
  assert.equal(
    selectPluginUpdateLane({ ...input, event: "push", ref: "refs/heads/main" }),
    "plugin-updates",
  );
  for (const mutation of [
    { ancestor: false },
    { ownRepository: "someone/fork" },
    { paths: ["src/host.ts"] },
    { paths: ["scripts/quality.mjs"] },
    { paths: ["renamed-source.ts"] },
  ])
    assert.throws(() => selectPluginUpdateLane({ ...input, ...mutation }), /SCOPE_REJECTED/);
  assert.equal(selectPluginUpdateLane({ ...input, pr: "60" }), "full");
  assert.equal(selectPluginUpdateLane({ ...input, event: "workflow_dispatch" }), "full");
  assert.equal(
    selectPluginUpdateLane({
      ...input,
      event: "push",
      ref: "refs/heads/main",
      paths: ["src/host.ts"],
    }),
    "full",
  );
});

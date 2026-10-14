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
  peerInput: [
    { repo: "dsh-agent-workbench", head: "1cf7a618f5431681eb5817a8ce26d12f0ab10a2b" },
    { repo: "dsh-agent-manage", head: "8aa7d48e6af40b8519d3bae22bb545f39d3509ea" },
    { repo: "dsh-gea-plugin", head: "99067baee958a2260ef3735c6b82818253e4906b" },
  ],
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

test("peer product changes cannot inherit the one-off gate", () => {
  for (const peerInput of [
    undefined,
    [],
    input.peerInput.slice(1),
    [...input.peerInput, input.peerInput[0]],
    input.peerInput.map((entry) => ({ ...entry, head: "0".repeat(40) })),
  ]) {
    assert.throws(() => selectPluginUpdateLane({ ...input, peerInput }), /SCOPE_REJECTED/);
    assert.equal(
      selectPluginUpdateLane({ ...input, event: "push", ref: "refs/heads/main", peerInput }),
      "full",
    );
  }
});

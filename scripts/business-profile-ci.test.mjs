import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesProductSource, selectBusinessProfileLane } from "./business-profile-ci.mjs";
const input = {
  event: "pull_request",
  repository: "CleverC2200/dsh-gea-plugin",
  branch: "codex/business-profile-main-20261014",
  ownRepository: "CleverC2200/dsh-gea-plugin",
  matches: true,
};
test("only the authorized product source and CI supplement enter the targeted lane", () => {
  assert.equal(matchesProductSource(true, ["scripts/run-quality-ci.mjs"]), true);
  for (const paths of [
    ["src/host.ts"],
    ["lib/types/client.d.ts"],
    ["scripts/quality.mjs"],
    ["new-product.ts"],
  ])
    assert.equal(matchesProductSource(true, paths), false);
  assert.equal(matchesProductSource(false, []), false);
  assert.equal(selectBusinessProfileLane(input), "business-profile");
  assert.throws(() => selectBusinessProfileLane({ ...input, matches: false }), /SCOPE_REJECTED/);
  assert.throws(
    () => selectBusinessProfileLane({ ...input, ownRepository: "someone/fork" }),
    /SCOPE_REJECTED/,
  );
  assert.equal(selectBusinessProfileLane({ ...input, branch: "other-pr" }), "full");
  for (const event of ["push", "workflow_dispatch"]) {
    assert.equal(
      selectBusinessProfileLane({ ...input, event, ref: "refs/heads/main" }),
      "business-profile",
    );
    assert.equal(
      selectBusinessProfileLane({ ...input, event, ref: "refs/heads/main", matches: false }),
      "full",
    );
  }
});

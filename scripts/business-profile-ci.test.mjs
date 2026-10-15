import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { loadBusinessProfilePolicy } from "./business-profile-ci.mjs";
const { matchesProductSource, selectBusinessProfileLane } = await loadBusinessProfilePolicy(
  process.env.QUALITY_POLICY_WORKBENCH ?? resolve(import.meta.dirname, "../../dsh-agent-workbench"),
);
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

test("the MCP exception rejects another branch, fork, or changed product group", () => {
  const mcp = {
    ...input,
    branch: "codex/mcp-direct-page-main-20261014",
    matches: false,
    matchesMcp: true,
  };
  assert.equal(selectBusinessProfileLane(mcp), "mcp-client-repair");
  assert.throws(
    () => selectBusinessProfileLane({ ...mcp, matchesMcp: false }),
    /MCP_CLIENT_SCOPE_REJECTED/,
  );
  assert.throws(
    () => selectBusinessProfileLane({ ...mcp, ownRepository: "someone/fork" }),
    /MCP_CLIENT_SCOPE_REJECTED/,
  );
  assert.equal(selectBusinessProfileLane({ ...mcp, branch: "other-pr" }), "full");
  for (const event of ["push", "workflow_dispatch"]) {
    assert.equal(
      selectBusinessProfileLane({ ...mcp, event, ref: "refs/heads/main" }),
      "mcp-client-repair",
    );
    assert.equal(
      selectBusinessProfileLane({ ...mcp, event, ref: "refs/heads/main", matchesMcp: false }),
      "full",
    );
    assert.equal(selectBusinessProfileLane({ ...mcp, event, ref: "refs/heads/other" }), "full");
  }
});

test("the source adapter requires an explicit Workbench path instead of searching another checkout", async () => {
  for (const value of [undefined, "", "main", "../dsh-agent-workbench"])
    await assert.rejects(loadBusinessProfilePolicy(value), /BUSINESS_PROFILE_WORKBENCH_REQUIRED/);
});

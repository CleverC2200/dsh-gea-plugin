/** PR 75's human-authorized source acceptance; never a full-suite pass. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const knowledgeMergeAuthorization = Object.freeze({
  repository: "CleverC2200/dsh-gea-plugin",
  pullRequest: 75,
  branch: "codex/weknora-pr-20261015",
  instruction: "跳过这个200的校验",
  productHead: "60c9ce95b883485c79d77c6cb855ae4735d288e1",
  base: "29480b07ef4823e927e66ee2da349e331d66500f",
});
const supplements = [
  "scripts/knowledge-merge-ci.mjs",
  "scripts/knowledge-merge-ci.test.mjs",
  "scripts/business-profile-ci.mjs",
  "scripts/run-quality-ci.mjs",
  "docs/ci-core-policy.md",
];
const frozenSources = {
  "dsh-agent-workbench": "29d851d71bdbe4c490a246ab20447c76c19ae957",
  "dsh-agent-manage": "307303d5532f4250879008573b329cf4bb202ff3",
  "dsh-gea-plugin": knowledgeMergeAuthorization.productHead,
};
const git = (root, args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Actual committed source must descend from the reviewed source, with CI-only supplements. */
export function matchesFrozenSource(entry, baseline, allowed = []) {
  try {
    if (git(entry.path, ["rev-parse", "HEAD"]) !== entry.head) return false;
    git(entry.path, ["merge-base", "--is-ancestor", baseline, entry.head]);
    return git(entry.path, ["diff", "--name-only", baseline, entry.head])
      .split("\n")
      .filter(Boolean)
      .every((file) => allowed.includes(file));
  } catch {
    return false;
  }
}
export function selectKnowledgeMergeLane(input) {
  const a = knowledgeMergeAuthorization;
  if (input.repository !== a.repository) return false;
  if (input.event === "pull_request") {
    if (input.pullRequest !== a.pullRequest || input.branch !== a.branch) return false;
    if (input.headRepository !== a.repository || !input.matches)
      throw Error("KNOWLEDGE_MERGE_SCOPE_REJECTED");
    return true;
  }
  // Only the immediate merge of this reviewed tree can reuse source acceptance.
  // A later main commit and manual dispatch both return to the ordinary lane.
  return (
    input.event === "push" &&
    input.ref === "refs/heads/main" &&
    input.matches === true &&
    input.parents?.length === 2 &&
    input.parents[0] === a.base
  );
}
export function knowledgeMergeLane(root, env = process.env) {
  let event = {};
  if (env.GITHUB_EVENT_PATH) event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const head = git(root, ["rev-parse", "HEAD"]);
  const parents = git(root, ["show", "-s", "--format=%P", head]).split(" ").filter(Boolean);
  return selectKnowledgeMergeLane({
    event: env.GITHUB_EVENT_NAME,
    repository: env.GITHUB_REPOSITORY,
    pullRequest: event.number,
    branch: event.pull_request?.head?.ref,
    headRepository: event.pull_request?.head?.repo?.full_name,
    ref: env.GITHUB_REF,
    parents,
    matches:
      (!env.QUALITY_EXPECTED_SHA || env.QUALITY_EXPECTED_SHA === head) &&
      matchesFrozenSource(
        { path: root, head },
        knowledgeMergeAuthorization.productHead,
        supplements,
      ),
  });
}
export function validateKnowledgeMergeGroup(repositories) {
  if (repositories.length !== 3 || new Set(repositories.map((row) => row.repo)).size !== 3)
    throw Error("KNOWLEDGE_MERGE_GROUP_REJECTED");
  for (const [repo, baseline] of Object.entries(frozenSources)) {
    const entry = repositories.find((row) => row.repo === repo);
    if (
      !entry ||
      !matchesFrozenSource(entry, baseline, repo === "dsh-gea-plugin" ? supplements : [])
    )
      throw Error("KNOWLEDGE_MERGE_GROUP_REJECTED: " + repo);
  }
}
export const knowledgeMergeTests = [
  "scripts/knowledge-merge-ci.test.mjs",
  "scripts/business-profile-ci.test.mjs",
  "scripts/run-quality-ci.test.mjs",
  "scripts/run-quality-checks.test.mjs",
  "tests/knowledge-mcp.test.mjs",
  "tests/gateway-mcp.test.mjs",
  "tests/prompt-runtime.test.mjs",
  "tests/prompt-execution-tools.test.mjs",
  "tests/controlled-execution.test.mjs",
  "tests/cube-direct-mcp.test.mjs",
  "tests/cube-new.test.mjs",
  "tests/business-identity-client.test.mjs",
  "tests/current-mcp-tools.test.mjs",
  "tests/execution-convergence.test.mjs",
];

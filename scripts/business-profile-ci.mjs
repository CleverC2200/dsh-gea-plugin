/** One authorized source group; unrelated events keep the original quality lane. */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const productSources = {
  "dsh-agent-workbench": "2be962b26b8583cc2ee4f2a65191661c3e00066e",
  "dsh-agent-manage": "9e05f3304572dd4fa5d292a4727070a9b1ecb9ef",
  "dsh-gea-plugin": "c0c90e106b7a68edb519410814db4d7c3f555a26",
};
// Human authorization in PR 63: MCP client repair acceptance, not a general CI exemption.
export const mcpClientSources = {
  "dsh-agent-workbench": "2be962b26b8583cc2ee4f2a65191661c3e00066e",
  "dsh-agent-manage": "9e05f3304572dd4fa5d292a4727070a9b1ecb9ef",
  "dsh-gea-plugin": "462937f52a6af27fcd818e4ed2b440ac679871df",
};
const ciPaths = new Set([
  ".github/workflows/quality.yml",
  "scripts/run-quality-ci.mjs",
  "scripts/business-profile-ci.mjs",
  "scripts/business-profile-ci.test.mjs",
  "scripts/quality-peer-baseline.json",
  "tests/quality-ci.test.mjs",
  "tests/quality-ci-cli.test.mjs",
  "scripts/run-quality-ci.test.mjs",
  "QUALITY.md",
  "docs/clean-ci.md",
  "docs/ci-core-policy.md",
]);
export function matchesProductSource(ancestor, paths) {
  return ancestor && paths.every((path) => ciPaths.has(path));
}
export function selectBusinessProfileLane({
  event,
  repository,
  ref,
  branch,
  ownRepository,
  matches,
  matchesMcp = false,
}) {
  const mcpRequested = event === "pull_request" && branch === "codex/mcp-direct-page-main-20261014";
  if (mcpRequested && (ownRepository !== repository || !matchesMcp))
    throw Error("MCP_CLIENT_SCOPE_REJECTED");
  const requested = event === "pull_request" && branch === "codex/business-profile-main-20261014";
  if (requested && (ownRepository !== repository || !matches))
    throw Error("BUSINESS_PROFILE_SCOPE_REJECTED");
  const main = ["push", "workflow_dispatch"].includes(event) && ref === "refs/heads/main";
  if (mcpRequested || (main && matchesMcp)) return "mcp-client-repair";
  return (requested || main) && matches ? "business-profile" : "full";
}
function matchesCheckout(repo, path, head, sources = productSources) {
  const git = (...args) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  if (!sources[repo] || git("rev-parse", "HEAD") !== head)
    throw Error("BUSINESS_PROFILE_EVENT_MISMATCH");
  try {
    git("merge-base", "--is-ancestor", sources[repo], head);
  } catch {
    return false;
  }
  const paths = git("diff", "--no-renames", "--name-only", sources[repo], head)
    .split("\n")
    .filter(Boolean);
  return matchesProductSource(true, paths);
}
function validateSourceGroup(repositories, sources) {
  if (repositories.length !== 3 || new Set(repositories.map((row) => row.repo)).size !== 3)
    throw Error("BUSINESS_PROFILE_GROUP_REQUIRED");
  for (const row of repositories)
    if (!matchesCheckout(row.repo, row.path, row.head, sources))
      throw Error("BUSINESS_PROFILE_PEER_REJECTED: " + row.repo);
}
export function validateBusinessProfileGroup(repositories) {
  validateSourceGroup(repositories, productSources);
}
export function validateMcpClientGroup(repositories) {
  validateSourceGroup(repositories, mcpClientSources);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const repository = process.env.GITHUB_REPOSITORY;
  const repo = repository?.replace("CleverC2200/", "");
  if (!productSources[repo] || repository !== "CleverC2200/" + repo)
    throw Error("CANDIDATE_SCOPE_REQUIRED");
  const lane = selectBusinessProfileLane({
    event: process.env.GITHUB_EVENT_NAME,
    repository,
    ref: process.env.GITHUB_REF,
    branch: process.env.QUALITY_PR_BRANCH,
    ownRepository: process.env.QUALITY_PR_REPOSITORY,
    matches: matchesCheckout(repo, process.cwd(), process.env.QUALITY_EXPECTED_SHA),
    matchesMcp: matchesCheckout(
      repo,
      process.cwd(),
      process.env.QUALITY_EXPECTED_SHA,
      mcpClientSources,
    ),
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
  console.log(
    JSON.stringify({
      lane,
      productSources,
      mcpClientSources,
      head: process.env.QUALITY_EXPECTED_SHA,
    }),
  );
}

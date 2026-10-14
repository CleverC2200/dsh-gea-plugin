/** One authorized source group; unrelated events keep the original quality lane. */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export const productSources = {
  "dsh-agent-workbench": "4d67ee3320ccb3cb3c45856369f1bf9c8f03e289",
  "dsh-agent-manage": "a09eb720ae5a4e9a746160272e99635f2377c1d9",
  "dsh-gea-plugin": "7c16eb31437304d5a7117142ab9446acf6fd8ad3",
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
}) {
  const requested =
    event === "pull_request" &&
    branch === "codex/business-profile-main-20261014";
  if (requested && (ownRepository !== repository || !matches))
    throw Error("BUSINESS_PROFILE_SCOPE_REJECTED");
  const main =
    ["push", "workflow_dispatch"].includes(event) && ref === "refs/heads/main";
  return (requested || main) && matches ? "business-profile" : "full";
}
function matchesCheckout(repo, path, head) {
  const git = (...args) =>
    execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  if (!productSources[repo] || git("rev-parse", "HEAD") !== head)
    throw Error("BUSINESS_PROFILE_EVENT_MISMATCH");
  try {
    git("merge-base", "--is-ancestor", productSources[repo], head);
  } catch {
    return false;
  }
  const paths = git(
    "diff",
    "--no-renames",
    "--name-only",
    productSources[repo],
    head,
  )
    .split("\n")
    .filter(Boolean);
  return matchesProductSource(true, paths);
}
export function validateBusinessProfileGroup(repositories) {
  if (
    repositories.length !== 3 ||
    new Set(repositories.map((row) => row.repo)).size !== 3
  )
    throw Error("BUSINESS_PROFILE_GROUP_REQUIRED");
  for (const row of repositories)
    if (!matchesCheckout(row.repo, row.path, row.head))
      throw Error("BUSINESS_PROFILE_PEER_REJECTED: " + row.repo);
}
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
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
    matches: matchesCheckout(
      repo,
      process.cwd(),
      process.env.QUALITY_EXPECTED_SHA,
    ),
  });
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
  console.log(
    JSON.stringify({
      lane,
      productSources,
      head: process.env.QUALITY_EXPECTED_SHA,
    }),
  );
}

/** The human-authorized exception is limited to PR 59 and its unchanged merge tree. */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const source = "99067baee958a2260ef3735c6b82818253e4906b";
const allowed = new Set([
  ".github/workflows/quality.yml",
  "scripts/plugin-update-pr-lane.mjs",
  "scripts/plugin-update-pr-lane.test.mjs",
  "scripts/run-quality-ci.mjs",
  "scripts/run-quality-ci.test.mjs",
  "scripts/quality-peer-baseline.json",
  "docs/ci-core-policy.md",
]);
export function selectPluginUpdateLane({
  event,
  repository,
  ref,
  pr,
  branch,
  ownRepository,
  ancestor,
  paths,
}) {
  const requested =
    event === "pull_request" && pr === "59" && branch === "codex/plugin-list-updates-pr-20261014";
  const merge = event === "push" && ref === "refs/heads/main";
  if (!requested && !merge) return "full";
  const scoped =
    repository === "CleverC2200/dsh-gea-plugin" &&
    ancestor &&
    paths.every((path) => allowed.has(path));
  if (requested && (!scoped || ownRepository !== repository))
    throw Error("PLUGIN_UPDATE_PR_SCOPE_REJECTED");
  return scoped ? "plugin-updates" : "full";
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  if (head !== process.env.QUALITY_EXPECTED_SHA) throw Error("CANDIDATE_EVENT_MISMATCH");
  let ancestor = false;
  try {
    git("merge-base", "--is-ancestor", source, "HEAD");
    ancestor = true;
  } catch {
    /* Other source events use the original gate. */
  }
  const paths = ancestor
    ? git("diff", "--no-renames", "--name-only", source, "HEAD").split("\n").filter(Boolean)
    : [];
  const lane = selectPluginUpdateLane({
    event: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    pr: process.env.QUALITY_PR_NUMBER,
    branch: process.env.QUALITY_PR_BRANCH,
    ownRepository: process.env.QUALITY_PR_REPOSITORY,
    ancestor,
    paths,
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `lane=${lane}\n`);
  console.log(JSON.stringify({ lane, source, head, paths }));
}

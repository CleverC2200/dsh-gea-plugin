import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesFrozenSource } from "./knowledge-merge-ci.mjs";
export const pluginUpdateAuthorization = Object.freeze({
  repository: "CleverC2200/dsh-gea-plugin",
  pullRequest: 78,
  branch: "codex/gea-rc2-brand-update-20261016",
  instruction:
    "只跑这次插件更新必要的定向校验，保留 WeKnora，不改 Core、不跑那181个文件，通过后尽快合并、发布OSS并在当前DSH实测。",
  productHead: "30877e28e5d0f6877679b7b543190159aa0564bc",
  base: "5b8c06b15df6b066c845bbea180ffbc209d72e43",
});
export const desktopBootstrapAuthorization = Object.freeze({
  repository: "CleverC2200/dsh-gea-plugin",
  pullRequest: 86,
  branch: "codex/plugin-update-bootstrap-158-20261016",
  instruction:
    "修复完整包在线更新缓存与已有客户端缺失来源，保留 WeKnora、原配置和回执，不改 Core、不放宽门禁；先发插件，安装包后置，只跑有影响的定向校验。",
  productHead: "a9b5000f809ddf079f9bc8de5d9eaf1a803e7fec",
  base: "055aeed6fd5bb2c77b8a3d0a06fd9ebf3e92af8a",
});
const supplements = [
  "scripts/plugin-update-pr-lane.mjs",
  "scripts/plugin-update-pr-lane.test.mjs",
  "scripts/business-profile-ci.mjs",
  "scripts/run-quality-ci.mjs",
  "docs/ci-core-policy.md",
  // Synchronizes the release assertion with main's strict Manage peer.
  "tests/plugin-release.test.mjs",
];
const bootstrapSupplements = [
  "scripts/quality-peer-baseline.json",
  "scripts/plugin-update-pr-lane.mjs",
  "scripts/plugin-update-pr-lane.test.mjs",
  "scripts/run-quality-ci.mjs",
  ".github/workflows/delivery-fixtures.yml",
  "docs/ci-core-policy.md",
];
const desktopCompanions = {
  "dsh-agent-workbench": "d173fb751a1dcae87901ac52e49c6a0ed11218fe",
  "dsh-agent-manage": "05613edf2de878769993fbc5568b9ef1f3880e3d",
};
const frozenSources = {
  "dsh-agent-workbench": "eda9f6367c35544f45866c5e06e1ebfd1f5b61e0",
  "dsh-agent-manage": "e7685b22e071fc8728f6e455699fa1d8099f5a00",
  "dsh-gea-plugin": pluginUpdateAuthorization.productHead,
};
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export function selectPluginUpdateLane(input, a = pluginUpdateAuthorization) {
  if (input.repository !== a.repository) return false;
  if (input.event === "pull_request") {
    if (input.branch === a.branch && input.pullRequest !== a.pullRequest)
      throw Error("PLUGIN_UPDATE_SCOPE_REJECTED");
    if (input.pullRequest !== a.pullRequest || input.branch !== a.branch) return false;
    if (input.headRepository !== a.repository || !input.matches)
      throw Error("PLUGIN_UPDATE_SCOPE_REJECTED");
    return true;
  }
  return (
    input.event === "push" &&
    input.ref === "refs/heads/main" &&
    input.matches === true &&
    input.parents?.length === 2 &&
    input.parents[0] === a.base
  );
}
export function pluginUpdateLane(root, env = process.env) {
  const event = env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const head = git(root, "rev-parse", "HEAD");
  let bootstrapMerge = false;
  if (env.GITHUB_EVENT_NAME === "push") {
    try {
      git(root, "merge-base", "--is-ancestor", desktopBootstrapAuthorization.productHead, head);
      bootstrapMerge = true;
    } catch {}
  }
  const authorization =
    event.pull_request?.head?.ref === desktopBootstrapAuthorization.branch ||
    event.number === desktopBootstrapAuthorization.pullRequest ||
    bootstrapMerge
      ? desktopBootstrapAuthorization
      : pluginUpdateAuthorization;
  return selectPluginUpdateLane(
    {
      event: env.GITHUB_EVENT_NAME,
      repository: env.GITHUB_REPOSITORY,
      pullRequest: event.number,
      branch: event.pull_request?.head?.ref,
      headRepository: event.pull_request?.head?.repo?.full_name,
      ref: env.GITHUB_REF,
      parents: git(root, "show", "-s", "--format=%P", head).split(" ").filter(Boolean),
      matches:
        (!env.QUALITY_EXPECTED_SHA || env.QUALITY_EXPECTED_SHA === head) &&
        matchesFrozenSource(
          { path: root, head },
          authorization.productHead,
          authorization === desktopBootstrapAuthorization ? bootstrapSupplements : supplements,
        ),
    },
    authorization,
  );
}
export function validatePluginUpdateGroup(repositories) {
  if (repositories.length !== 3 || new Set(repositories.map((row) => row.repo)).size !== 3)
    throw Error("PLUGIN_UPDATE_GROUP_REJECTED");
  const gea = repositories.find((row) => row.repo === "dsh-gea-plugin");
  const bootstrap =
    gea &&
    matchesFrozenSource(gea, desktopBootstrapAuthorization.productHead, bootstrapSupplements);
  for (const [repo, original] of Object.entries(frozenSources)) {
    const baseline = bootstrap
      ? repo === "dsh-gea-plugin"
        ? desktopBootstrapAuthorization.productHead
        : desktopCompanions[repo]
      : original;
    const entry = repositories.find((row) => row.repo === repo);
    if (
      !entry ||
      !matchesFrozenSource(
        entry,
        baseline,
        repo === "dsh-gea-plugin"
          ? bootstrap
            ? bootstrapSupplements
            : supplements
          : bootstrap
            ? ["scripts/quality-peer-baseline.json"]
            : [],
      )
    )
      throw Error("PLUGIN_UPDATE_GROUP_REJECTED: " + repo);
  }
}
export function pluginUpdatePlanFor(repositories) {
  const gea = repositories.find((row) => row.repo === "dsh-gea-plugin");
  return gea &&
    matchesFrozenSource(gea, desktopBootstrapAuthorization.productHead, bootstrapSupplements)
    ? {
        lane: "plugin-update-pr",
        runtime: false,
        browser: false,
        acceptance: "targeted plugin store and existing source repair; broad selection not run",
        authorization: desktopBootstrapAuthorization,
        files: [
          "scripts/plugin-update-pr-lane.test.mjs",
          "desktop/company-bootstrap.test.mjs",
          "scripts/repair-plugin-store.test.mjs",
          "tests/plugin-update-controller.contract.mjs",
          "tests/plugin-update-install.contract.mjs",
          "scripts/plugin-package-version.test.mjs",
        ],
      }
    : pluginUpdatePlan;
}
export const pluginUpdatePlan = Object.freeze({
  lane: "plugin-update-pr",
  runtime: false,
  browser: true,
  acceptance: "targeted plugin update; broad 181-file selection not run",
  authorization: pluginUpdateAuthorization,
  files: [
    "scripts/plugin-update-pr-lane.test.mjs",
    "desktop/official-branding.test.mjs",
    "scripts/knowledge-merge-ci.test.mjs",
    "scripts/business-profile-ci.test.mjs",
    "scripts/run-quality-ci.test.mjs",
    "scripts/run-quality-ci-stages.test.mjs",
    "scripts/build.test.mjs",
    "scripts/package-version-gate.test.mjs",
    "scripts/plugin-package-version.test.mjs",
    "tests/optional-companion-manifest.test.mjs",
    "tests/client-account.test.mjs",
    "tests/knowledge-mcp.test.mjs",
    "tests/gateway-mcp.test.mjs",
    "tests/plugin-release.test.mjs",
    "tests/plugin-release-source.test.mjs",
    "tests/plugin-update-controller.contract.mjs",
    "tests/plugin-update-integration.contract.mjs",
    "tests/plugin-update-install.contract.mjs",
    "tests/plugin-update-detail.browser.mjs",
  ],
});

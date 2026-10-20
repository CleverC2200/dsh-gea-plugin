import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

export const windowsNativeInput = Object.freeze({
  coreHead: "639ed015397290b3745d163aafe02ffee4aa3f84",
  installerSha256: "9ab0cbdfdeb57d4227671a2b4f25f4b2793f9d3f7f5894fc6bf7cfbf39f93ba9",
  installerUrl:
    "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/556e9381b39cf271b5227fdbfacbaa3584cf9cc7/desktop/GEA-Desktop-0.2.0-rc.2-win-x64-gea157-local-unsigned.exe",
  acceptance:
    "native-windows-installer-regression; not current-Core joint or desktop UI acceptance",
});

export const windowsNativeEntrypoints = Object.freeze({
  controller: "src/host/plugin-update-controller.ts",
  fixture: "tests/plugin-update-windows.native.mjs",
});

const affected = [
  /^src\/host\/plugin-update-archive\.mjs$/,
  /^src\/host\/plugin-(?:update[^/]*|release-source)\.ts$/,
  /^src\/shared\/plugin-(?:update[^/]*\.ts|release\.(?:mjs|d\.mts))$/,
  /^tests\/(?:plugin-update[^/]*\.(?:contract|native)\.mjs|fixtures\/plugin-updates\/)/,
  /^scripts\/(?:check-windows-plugin-update|ci-windows-update)(?:\.test)?\.mjs$/,
  /^(?:package\.json|pnpm-lock\.yaml|\.github\/workflows\/(?:quality|delivery-fixtures)\.yml)$/,
];

export function windowsUpdateImpact(files) {
  if (
    !Array.isArray(files) ||
    files.some(
      (file) =>
        typeof file !== "string" ||
        !file ||
        file.startsWith("/") ||
        file.split("/").includes("..") ||
        /[\0\r\n\\]/.test(file),
    )
  )
    throw Error("WINDOWS_UPDATE_DIFF_REQUIRED");
  const matched = [
    ...new Set(files.filter((file) => affected.some((pattern) => pattern.test(file)))),
  ].sort();
  return { applicable: matched.length > 0, matched };
}

export function windowsUpdateScope({ root, head, base }) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (![head, base].every((value) => /^[a-f0-9]{40}$/.test(value ?? "")))
    throw Error("WINDOWS_UPDATE_COMMITS_REQUIRED");
  if (git("rev-parse", "HEAD") !== head) throw Error("WINDOWS_UPDATE_EVENT_MISMATCH");
  const diffBase = git("merge-base", base, head);
  const files = git("diff", "--name-only", "--no-renames", "-z", diffBase, head)
    .split("\0")
    .filter(Boolean);
  return {
    schemaVersion: 1,
    sourceHead: head,
    base,
    diffBase,
    ...windowsUpdateImpact(files),
    runtime: windowsNativeInput,
  };
}

export function verifyWindowsUpdateResult({ directory, expected }) {
  const scope = JSON.parse(readFileSync(resolve(directory, "windows-update-scope.json")));
  const sources = (entries) =>
    entries.map(({ repo, head }) => ({ repo, head })).sort((a, b) => a.repo.localeCompare(b.repo));
  if (
    scope.schemaVersion !== 1 ||
    typeof scope.applicable !== "boolean" ||
    scope.sourceHead !== expected.sources.find((entry) => entry.repo === "dsh-gea-plugin")?.head ||
    scope.group?.groupId !== expected.groupId ||
    !isDeepStrictEqual(sources(scope.group?.repositories ?? []), sources(expected.sources)) ||
    !isDeepStrictEqual(scope.runtime, windowsNativeInput)
  )
    throw Error("WINDOWS_UPDATE_RECEIPT_REJECTED");
  if (scope.applicable) {
    const result = JSON.parse(readFileSync(resolve(directory, "result.json")));
    if (
      result.sourceHead !== scope.sourceHead ||
      result.platform !== "win32" ||
      result.exitCode !== 0 ||
      result.coreHead !== windowsNativeInput.coreHead ||
      result.runtimeInstallerSha256 !== windowsNativeInput.installerSha256
    )
      throw Error("WINDOWS_UPDATE_RECEIPT_REJECTED");
  }
  return { status: scope.applicable ? "passed" : "not-applicable", group: scope.group };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const base =
    process.env.QUALITY_BASE_SHA ||
    JSON.parse(readFileSync(resolve(root, "scripts/quality-peer-baseline.json"))).repositories.find(
      (entry) => entry.repo === "dsh-gea-plugin",
    )?.head;
  const scope = windowsUpdateScope({ root, head: process.env.QUALITY_EXPECTED_SHA, base });
  if (
    process.env.QUALITY_WINDOWS_APPLICABLE !== undefined &&
    process.env.QUALITY_WINDOWS_APPLICABLE !== String(scope.applicable)
  )
    throw Error("WINDOWS_UPDATE_SCOPE_CHANGED");
  const group = {
    groupId: process.env.QUALITY_GROUP_ID,
    repositories: ["gea", "manage", "workbench"].map((name) => ({
      repo: { gea: "dsh-gea-plugin", manage: "dsh-agent-manage", workbench: "dsh-agent-workbench" }[
        name
      ],
      head: process.env["QUALITY_GROUP_" + name.toUpperCase()],
    })),
  };
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (!group.groupId ||
      group.repositories.some((entry) => !/^[a-f0-9]{40}$/.test(entry.head ?? "")) ||
      group.repositories[0].head !== scope.sourceHead)
  )
    throw Error("WINDOWS_UPDATE_GROUP_REQUIRED");
  scope.group = group;
  writeFileSync("windows-update-scope.json", JSON.stringify(scope, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `applicable=${scope.applicable}\n`);
  console.log(
    JSON.stringify({ ...scope, status: scope.applicable ? "required" : "not-applicable" }),
  );
}

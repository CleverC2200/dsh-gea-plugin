import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function workflowFiles(files, root = process.cwd()) {
  return [...new Set(files)]
    .filter(
      (file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) && existsSync(resolve(root, file)),
    )
    .sort();
}

export function checkWorkflows(
  files,
  { root = process.cwd(), executable = process.env.ACTIONLINT || "actionlint" } = {},
) {
  const selected = workflowFiles(files, root);
  const result = { purpose: "github-actions-semantics", tool: "actionlint", files: selected };
  if (!selected.length) return { ...result, status: "not-applicable" };
  const checked = spawnSync(executable, ["-shellcheck=", "-pyflakes=", ...selected], {
    cwd: root,
    encoding: "utf8",
  });
  if (checked.error?.code === "ENOENT")
    throw Error(
      "WORKFLOW_PREFLIGHT_TOOL_REQUIRED: actionlint 1.7.12; set ACTIONLINT to the task-owned executable",
    );
  if (checked.error || checked.status !== 0)
    throw Error(
      "WORKFLOW_PREFLIGHT_FAILED: " +
        (checked.error?.message ||
          checked.stdout ||
          checked.stderr ||
          checked.signal ||
          checked.status),
    );
  const version = spawnSync(executable, ["-version"], { cwd: root, encoding: "utf8" });
  if (version.error || version.status !== 0)
    throw Error("WORKFLOW_PREFLIGHT_TOOL_REQUIRED: actionlint -version");
  return { ...result, version: version.stdout.trim().split("\n")[0], status: "passed" };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(checkWorkflows(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

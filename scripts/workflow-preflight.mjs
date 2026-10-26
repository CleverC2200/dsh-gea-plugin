import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const actionlintVersion = "1.7.12";
const queueDiagnostic =
  'unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"';

function serialQueueInput(file, root, diagnostics) {
  if (file !== ".github/workflows/serial-merge.yml") return null;
  const lines = readFileSync(resolve(root, file), "utf8").split("\n");
  const starts = lines.flatMap((line, index) => (line === "concurrency:" ? [index] : []));
  if (starts.length !== 1) return null;
  const start = starts[0];
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^\s*#|^ /.test(lines[end]))) end++;
  const fields = lines.slice(start + 1, end).filter((line) => line.trim() && !/^\s*#/.test(line));
  if (
    fields.filter((line) => /^  group: \S/.test(line)).length !== 1 ||
    fields.some((line) => /^  group: [|>&*!{[]/.test(line)) ||
    fields.filter((line) => /^  queue: max(?:\s+#.*)?$/.test(line)).length !== 1 ||
    fields.filter((line) => /^  cancel-in-progress: false(?:\s+#.*)?$/.test(line)).length > 1 ||
    fields.some(
      (line) =>
        !/^  (?:group: \S.*|queue: max(?:\s+#.*)?|cancel-in-progress: false(?:\s+#.*)?)$/.test(
          line,
        ),
    )
  )
    return null;
  const index = lines.findIndex(
    (line, index) => index > start && index < end && line.startsWith("  queue:"),
  );
  if (
    diagnostics.filter(
      (error) =>
        error.filepath === file &&
        error.line === index + 1 &&
        error.column === 3 &&
        error.kind === "syntax-check" &&
        error.message === queueDiagnostic,
    ).length !== 1
  )
    return null;
  lines[index] = "";
  return lines.join("\n");
}

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
  const version = spawnSync(executable, ["-version"], { cwd: root, encoding: "utf8" });
  if (version.error || version.status !== 0)
    throw Error(
      `WORKFLOW_PREFLIGHT_TOOL_REQUIRED: actionlint ${actionlintVersion}; set ACTIONLINT to the task-owned executable`,
    );
  const actualVersion = version.stdout.trim().split("\n")[0];
  if (actualVersion !== actionlintVersion)
    throw Error(
      `WORKFLOW_PREFLIGHT_TOOL_VERSION: expected ${actionlintVersion}; received ${actualVersion || "missing"}`,
    );
  const flags = ["-shellcheck=", "-pyflakes=", "-format", "{{json .}}"];
  const options = { cwd: root, encoding: "utf8" };
  const checked = spawnSync(executable, [...flags, ...selected], {
    cwd: root,
    encoding: "utf8",
  });
  const requirePassed = (checked) => {
    if (checked.error || checked.status !== 0)
      throw Error(
        "WORKFLOW_PREFLIGHT_FAILED: " +
          (checked.error?.message ||
            checked.stdout ||
            checked.stderr ||
            checked.signal ||
            checked.status),
      );
  };
  if (checked.status !== 0 && !checked.error) {
    let diagnostics;
    try {
      diagnostics = JSON.parse(checked.stdout);
    } catch {
      requirePassed(checked);
    }
    const file = ".github/workflows/serial-merge.yml";
    const input =
      selected.includes(file) && Array.isArray(diagnostics)
        ? serialQueueInput(file, root, diagnostics)
        : null;
    if (input !== null) {
      const derived = spawnSync(executable, [...flags, "-stdin-filename", file, "-"], {
        ...options,
        input,
      });
      requirePassed(derived);
      const other = selected.filter((entry) => entry !== file);
      if (other.length) requirePassed(spawnSync(executable, [...flags, ...other], options));
      return {
        ...result,
        version: actualVersion,
        status: "passed",
        compatibility: {
          feature: "serial-workflow-concurrency-queue-max",
          files: [file],
          nativeOriginalExitCode: checked.status,
          derivedNativeExitCode: derived.status,
        },
      };
    }
  }
  requirePassed(checked);
  return { ...result, version: actualVersion, status: "passed" };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    console.log(JSON.stringify(checkWorkflows(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

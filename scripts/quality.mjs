/** Incremental strict gates; audit modes retain the full existing debt. */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const anchor = "041ef35e16effcf98ffe3b252b64512c704dc29a";
const [mode, ...selected] = process.argv.slice(2);
if (!["lint", "lint:audit", "format:check", "format:audit"].includes(mode)) {
  throw new Error("QUALITY_MODE_INVALID: " + mode);
}
const lint = mode.startsWith("lint");
const audit = mode.endsWith(":audit");
const extensions = lint
  ? /\.(?:[cm]?[jt]s|[jt]sx)$/
  : /\.(?:[cm]?[jt]s|[jt]sx|html|css|json|md|ya?ml)$/;
function run(command, args, input) {
  const result = spawnSync(command, args, {
    cwd: root,
    input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.signal) {
    throw result.error ?? new Error("QUALITY_RUNNER_SIGNAL: " + result.signal);
  }
  return result;
}
function git(args) {
  const result = run("git", args);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
const files = selected.length
  ? selected.map((file) => relative(root, resolve(file)).split(sep).join("/"))
  : git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(
        (file) =>
          /^(?:src|scripts|tests|desktop|demos|packages|presets|default-presets|business-skills)\//.test(
            file,
          ) ||
          /^(?:package|tsconfig(?:\.official)?|\.oxlintrc|\.oxfmtrc|gea\.(?:config|direct)\.example)\.json$/.test(
            file,
          ) ||
          file === "cordis.patch.yml",
      );
if (selected.length && files.some((file) => !existsSync(resolve(root, file)))) {
  throw new Error("QUALITY_TARGET_MISSING");
}
const targets = [...new Set(files)].filter(
  (file) => extensions.test(file) && existsSync(resolve(root, file)),
);
if (!targets.length) throw new Error("QUALITY_NO_TARGETS");
const config = lint ? ".oxlintrc.json" : ".oxfmtrc.json";
const binary = lint ? "oxlint" : "oxfmt";
if (
  !lint &&
  readFileSync(resolve(root, ".qualityignore"), "utf8")
    .split("\n")
    .some((line) => line.trim() && !line.trim().startsWith("#"))
) {
  throw new Error("QUALITY_IGNORE_FORBIDDEN");
}
const args = lint
  ? ["--config", config, "--disable-nested-config", "--no-ignore", "--format", "json", ...targets]
  : [
      "--config",
      config,
      "--disable-nested-config",
      "--ignore-path",
      ".qualityignore",
      "--list-different",
      ...targets,
    ];
const result = run(resolve(root, "node_modules/.bin", binary), args);
if (audit) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
if (result.status !== 0 && result.status !== 1) {
  process.stderr.write(result.stderr);
  throw new Error("QUALITY_RUNNER_EXIT: " + result.status);
}
const baseline = JSON.parse(readFileSync(resolve(root, "quality-baseline.json")));
if (baseline.sourceHead !== anchor) throw new Error("QUALITY_BASELINE_ANCHOR_INVALID");
const baseTree = new Map(
  git(["ls-tree", "-r", "--full-tree", anchor])
    .trim()
    .split("\n")
    .map((line) => {
      const [metadata, file] = line.split("\t");
      return [file, metadata.split(" ")[2]];
    }),
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
if (baseline.configs[config] !== hash(readFileSync(resolve(root, config)))) {
  throw new Error("QUALITY_BASELINE_CONFIG_CHANGED: audit and review rule changes first");
}
const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
if (manifest.devDependencies[binary] !== baseline.versions[binary]) {
  throw new Error("QUALITY_BASELINE_TOOL_CHANGED: audit and review tool changes first");
}
function unchangedDebt(file) {
  const entry = baseline[lint ? "lint" : "format"][file];
  if (!entry) return false;
  if (entry.blob !== baseTree.get(file)) throw new Error("QUALITY_BASELINE_BLOB_INVALID: " + file);
  const content = readFileSync(resolve(root, file));
  const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
  return blob === entry.blob && hash(content) === entry.sha256;
}
if (lint) {
  const diagnostics = JSON.parse(result.stdout).diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("QUALITY_LINT_OUTPUT_INVALID");
  const failures = diagnostics.filter((item) => !item.code || !unchangedDebt(item.filename));
  for (const item of failures) console.error(`${item.filename}: ${item.code}: ${item.message}`);
  console.log(
    `Oxlint: ${targets.length} targets; ${diagnostics.length - failures.length} unchanged baseline diagnostics; ${failures.length} strict failures`,
  );
  process.exit(failures.length || (result.status !== 0 && !diagnostics.length) ? 1 : 0);
}
const changed = result.stdout.trim().split("\n").filter(Boolean);
if (result.stderr || (result.status !== 0 && !changed.length)) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status || 1);
}
const failures = changed.filter((file) => !targets.includes(file) || !unchangedDebt(file));
for (const file of failures) console.error("Oxfmt: unformatted " + file);
console.log(
  `Oxfmt: ${targets.length} targets; ${changed.length - failures.length} unchanged baseline files; ${failures.length} strict failures`,
);
process.exit(failures.length ? 1 : 0);

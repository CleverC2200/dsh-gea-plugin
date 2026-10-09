/** Incremental strict gates; audit modes retain the full existing debt. */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, relative, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const anchor = "041ef35e16effcf98ffe3b252b64512c704dc29a";
const hash = (data) => createHash("sha256").update(data).digest("hex");
// Original 7e7a464 policy blobs, accepting only LF or their complete CRLF rendering.
// Compare bytes without rewriting the policy, baseline, source or evidence.
const policy = {
  "quality-baseline.json": [
    "7a0b2da1102c657493e1a341ff7097edf2fec3a9953cbc8684aa5ebdee904b35",
    "097a805f888a0ed0ad17e8c14e4ecb9c049a4908a472fc07967728559c79718c",
  ],
  ".oxlintrc.json": [
    "a376bdb153dec5b819ecf3e922089929437dd6160471bf77e5823d8a32c0c02b",
    "d720824e83f95c907e2ab4c54c3360b95c19a79bd50772db42e4ddfd9958f3e8",
  ],
  ".oxfmtrc.json": [
    "54b9ec697dd9703c493da6a554600505cb6e060d87ff66be307815e40e84e30b",
    "afd5c3d8c04b5403974ef12bb816763e070bbe33b3796722b6865fba5fce741c",
  ],
};
const [mode, ...selected] = process.argv.slice(2);
if (!["lint", "lint:audit", "format:check", "format:audit"].includes(mode)) {
  throw new Error("QUALITY_MODE_INVALID: " + mode);
}
for (const [file, hashes] of Object.entries(policy)) {
  if (!existsSync(resolve(root, file)) || !hashes.includes(hash(readFileSync(resolve(root, file)))))
    throw new Error(
      (file === "quality-baseline.json"
        ? "QUALITY_BASELINE_REQUIRED: "
        : "QUALITY_POLICY_REQUIRED: ") + file,
    );
}
const baseline = JSON.parse(readFileSync(resolve(root, "quality-baseline.json")));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json")));
for (const [tool, version] of Object.entries({ oxlint: "1.87.0", oxfmt: "0.72.0" })) {
  const installed = resolve(root, "node_modules", tool, "package.json");
  if (
    manifest.devDependencies[tool] !== version ||
    !existsSync(installed) ||
    JSON.parse(readFileSync(installed)).version !== version
  )
    throw new Error("QUALITY_BASELINE_TOOL_CHANGED: " + tool);
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
// Preserve the original generated/third-party exclusions. New Git ignore rules
// must not hide authored files that a tracked consumer can load locally.
const exclusions = selected.length
  ? []
  : git(["show", anchor + ":.gitignore"])
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => "--exclude=" + line);
const files = selected.length
  ? selected.map((file) => relative(root, resolve(file)).split(sep).join("/"))
  : git(["ls-files", "--cached", "--others", ...exclusions, "-z"])
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
const baseTree = new Map(
  git(["ls-tree", "-r", "--full-tree", anchor])
    .trim()
    .split("\n")
    .map((line) => {
      const [metadata, file] = line.split("\t");
      return [file, metadata.split(" ")[2]];
    }),
);
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

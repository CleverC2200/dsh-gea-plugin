import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  appendFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
function fixture(t, content, extension = "mjs") {
  const directory = mkdtempSync(join(fileURLToPath(root), "scripts/quality-fixture-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "sample." + extension);
  writeFileSync(file, content);
  return file;
}
function check(mode, ...files) {
  return spawnSync(process.execPath, ["scripts/quality.mjs", mode, ...files], {
    cwd: root,
    encoding: "utf8",
  });
}
test("lint accepts valid maintained JavaScript through its CLI", (t) => {
  const result = check("lint", fixture(t, "export const value = 1;\n"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("lint refuses debugger in JavaScript with a named rule and nonzero exit", (t) => {
  const result = check("lint", fixture(t, "debugger;\n"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no-debugger/);
});

test("lint refuses invalid TypeScript syntax", (t) => {
  const result = check("lint", fixture(t, "export const value: = 1;\n", "ts"));
  assert.equal(result.status, 1);
});

test("formatter accepts existing style and rejects unformatted JavaScript", (t) => {
  const good = check("format:check", fixture(t, "export const value = 1;\n"));
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = check("format:check", fixture(t, "export const value={a:1};\n"));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unformatted/);
});

test("formatter checks HTML instead of silently skipping it", (t) => {
  const bad = check("format:check", fixture(t, "<html><body><p>hello</p></body></html>\n", "html"));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /sample\.html/);
});

test("missing targets do not pass quality checks", () => {
  const result = check("lint", "scripts/missing-quality-fixture.mjs");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_TARGET_MISSING/);
});

for (const directory of ["src", "scripts", "tests", "desktop", "demos"]) {
  test(`default lint discovers new files under ${directory}`, (t) => {
    const parent = join(fileURLToPath(root), directory);
    if (!existsSync(parent)) {
      mkdirSync(parent);
      t.after(() => rmSync(parent, { recursive: true, force: true }));
    }
    const directoryPath = mkdtempSync(join(fileURLToPath(root), directory, "quality-fixture-"));
    t.after(() => rmSync(directoryPath, { recursive: true, force: true }));
    writeFileSync(join(directoryPath, "bad.mjs"), "debugger;\n");
    const result = check("lint");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bad\.mjs: eslint\(no-debugger\)/);
  });
}

test("missing selected file cannot hide behind a valid selected file", (t) => {
  const result = check(
    "lint",
    fixture(t, "export const value = 1;\n"),
    "scripts/missing-quality-fixture.mjs",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_TARGET_MISSING/);
});

function baselineFixture(t) {
  // Keep installations outside the parent pnpm workspace so they cannot resolve to its root.
  const directory = mkdtempSync(join(tmpdir(), "gea-quality-baseline-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = spawnSync(
    "git",
    ["clone", "--shared", "--no-checkout", fileURLToPath(root), directory],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  for (const part of ["scripts", "src"]) mkdirSync(join(directory, part), { recursive: true });
  for (const file of [
    "scripts/quality.mjs",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    ".qualityignore",
    "package.json",
    "quality-baseline.json",
  ]) {
    copyFileSync(new URL(file, root), join(directory, file));
  }
  // Each fixture installs its own tools with the original registry lock metadata.
  const manifest = JSON.parse(readFileSync(new URL("package.json", root)));
  const tools = { oxfmt: manifest.devDependencies.oxfmt, oxlint: manifest.devDependencies.oxlint };
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      name: "gea-quality-fixture",
      type: "module",
      packageManager: manifest.packageManager,
      devDependencies: tools,
    }),
  );
  const lock = readFileSync(new URL("pnpm-lock.yaml", root), "utf8");
  const importer =
    "importers:\n\n  .:\n    devDependencies:\n" +
    Object.entries(tools)
      .map(
        ([tool, version]) =>
          `      ${tool}:\n        specifier: ${version}\n        version: ${version}\n`,
      )
      .join("");
  writeFileSync(
    join(directory, "pnpm-lock.yaml"),
    lock.slice(0, lock.indexOf("importers:\n")) +
      importer +
      "\n" +
      lock.slice(lock.indexOf("packages:\n")),
  );
  const installed = spawnSync(
    process.platform === "win32" ? "corepack.cmd" : "corepack",
    ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    { cwd: directory, encoding: "utf8", shell: process.platform === "win32" },
  );
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const original = spawnSync(
    "git",
    ["show", "041ef35e16effcf98ffe3b252b64512c704dc29a:src/host.ts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(original.status, 0, original.stderr);
  writeFileSync(join(directory, "src/host.ts"), original.stdout);
  return directory;
}
function checkFixture(directory, mode) {
  return spawnSync(process.execPath, ["scripts/quality.mjs", mode, "src/host.ts"], {
    cwd: directory,
    encoding: "utf8",
  });
}

test("baseline exempts only original bytes and rejects edits in both gates", (t) => {
  const directory = baselineFixture(t);
  for (const mode of ["lint", "format:check"]) {
    const result = checkFixture(directory, mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  appendFileSync(join(directory, "src/host.ts"), "\ndebugger;const unformatted={a:1};\n");
  for (const mode of ["lint", "format:check"]) {
    const result = checkFixture(directory, mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

test("updating a baseline SHA cannot absorb modified source bytes", (t) => {
  const directory = baselineFixture(t);
  const file = join(directory, "src/host.ts");
  appendFileSync(file, "\ndebugger;const unformatted={a:1};\n");
  const baseline = JSON.parse(readFileSync(join(directory, "quality-baseline.json")));
  for (const kind of ["lint", "format"])
    baseline[kind]["src/host.ts"].sha256 = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
  writeFileSync(join(directory, "quality-baseline.json"), JSON.stringify(baseline));
  for (const mode of ["lint", "format:check"])
    assert.equal(checkFixture(directory, mode).status, 1);
});

test("rebasing a baseline anchor cannot absorb changed files", (t) => {
  const directory = baselineFixture(t);
  const baseline = JSON.parse(readFileSync(join(directory, "quality-baseline.json")));
  baseline.sourceHead = "0".repeat(40);
  writeFileSync(join(directory, "quality-baseline.json"), JSON.stringify(baseline));
  const result = checkFixture(directory, "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_BASELINE_REQUIRED/);
});

test("the retained official typecheck command refuses a different official HEAD before tsc", (t) => {
  mkdirSync(new URL(".runtime/", root), { recursive: true });
  const directory = mkdtempSync(join(fileURLToPath(root), ".runtime/quality-official-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const part of [
    "gea",
    "dsh-agent-workbench/scripts",
    "dsh-gea-plugin/scripts",
    "official/vendor/cordis/lib/types",
  ])
    mkdirSync(join(directory, part), { recursive: true });
  copyFileSync(
    new URL("scripts/supported-cores.json", root),
    join(directory, "dsh-gea-plugin/scripts/supported-cores.json"),
  );
  const cordis = join(directory, "official/vendor/cordis/lib/types/index.d.ts");
  writeFileSync(cordis, "export {};\n");
  writeFileSync(
    join(directory, "dsh-agent-workbench/tsconfig.official.json"),
    JSON.stringify({ compilerOptions: { paths: { "@deepseek-ai/cordis": [cordis] } } }),
  );
  copyFileSync(
    new URL("../dsh-agent-workbench/scripts/verify-official-input.mjs", root),
    join(directory, "dsh-agent-workbench/scripts/verify-official-input.mjs"),
  );
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    [
      "-c",
      "user.name=Quality Fixture",
      "-c",
      "user.email=quality@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: join(directory, "official"), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const manifest = JSON.parse(readFileSync(new URL("package.json", root)));
  const result = spawnSync("sh", ["-c", manifest.scripts["typecheck:official"]], {
    cwd: join(directory, "gea"),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OFFICIAL_INPUT_REQUIRED/);
});

test("formatter cannot hide maintained targets behind an ignore pattern", (t) => {
  const directory = baselineFixture(t);
  writeFileSync(join(directory, ".qualityignore"), "src/**\n");
  const result = checkFixture(directory, "format:check");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_IGNORE_FORBIDDEN/);
});

test("missing formatter runner fails instead of reporting a pass", (t) => {
  const directory = baselineFixture(t);
  rmSync(join(directory, "node_modules/.bin/oxfmt"));
  assert.equal(checkFixture(directory, "format:check").status, 1);
});

function replaceLintRunner(directory, output, exitCode) {
  const binary = join(directory, "node_modules/.bin/oxlint");
  rmSync(binary);
  writeFileSync(
    binary,
    "#!/usr/bin/env node\nprocess.stdout.write(" +
      JSON.stringify(JSON.stringify(output)) +
      ");\nprocess.exit(" +
      exitCode +
      ");\n",
    { mode: 0o755 },
  );
}

test("unexpected runner exit cannot be swallowed by an unchanged debt file", (t) => {
  const directory = baselineFixture(t);
  replaceLintRunner(
    directory,
    {
      diagnostics: [
        { filename: "src/host.ts", code: "eslint(no-unused-vars)", message: "runner fixture" },
      ],
    },
    2,
  );
  const result = checkFixture(directory, "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_RUNNER_EXIT/);
});

test("parse or config errors without a lint rule cannot be swallowed as old debt", (t) => {
  const directory = baselineFixture(t);
  replaceLintRunner(
    directory,
    { diagnostics: [{ filename: "src/host.ts", message: "parse fixture" }] },
    1,
  );
  const result = checkFixture(directory, "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /parse fixture/);
});

test("a signalled runner fails after valid frozen policy and installed tool metadata", (t) => {
  const directory = baselineFixture(t);
  const binary = join(directory, "node_modules/.bin/oxlint");
  rmSync(binary);
  writeFileSync(binary, "#!/usr/bin/env node\nprocess.kill(process.pid, 'SIGTERM');\n", {
    mode: 0o755,
  });
  const result = checkFixture(directory, "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /QUALITY_RUNNER_SIGNAL/);
});

test("invalid runner JSON fails after valid frozen policy and installed tool metadata", (t) => {
  const directory = baselineFixture(t);
  const binary = join(directory, "node_modules/.bin/oxlint");
  rmSync(binary);
  writeFileSync(binary, "#!/usr/bin/env node\nprocess.stdout.write('not JSON');\n", {
    mode: 0o755,
  });
  const result = checkFixture(directory, "lint");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SyntaxError/);
});

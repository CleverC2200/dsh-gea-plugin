import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function command(cwd, executable, args) {
  const windows = process.platform === "win32" && executable === "corepack";
  const result = spawnSync(windows ? "corepack.cmd" : executable, args, {
    cwd,
    encoding: "utf8",
    shell: windows,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

test("public quality binds the original policy and tools while accepting complete CRLF rendering", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "gea-policy-cold-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  command(root, "git", ["clone", "--quiet", "--no-hardlinks", root, directory]);
  copyFileSync(join(root, "scripts/quality.mjs"), join(directory, "scripts/quality.mjs"));
  command(directory, "corepack", [
    "pnpm",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--prefer-offline",
  ]);
  t.diagnostic(
    JSON.stringify({
      source: root,
      sourceHead: command(directory, "git", ["rev-parse", "HEAD"]),
      lockSha256: digest(readFileSync(join(directory, "pnpm-lock.yaml"))),
      manager: command(directory, "corepack", ["pnpm", "--version"]),
      dependencies: "independent frozen install; no copied node_modules or outputs",
    }),
  );
  const original = Object.fromEntries(
    ["quality-baseline.json", ".oxlintrc.json", ".oxfmtrc.json", "package.json"].map((file) => [
      file,
      readFileSync(join(directory, file)),
    ]),
  );
  const restore = () => {
    for (const [file, bytes] of Object.entries(original))
      writeFileSync(join(directory, file), bytes);
  };
  writeFileSync(join(directory, "src/policy-valid.mjs"), "export const value = 1;\n");
  const check = (mode, file = "src/policy-valid.mjs") =>
    spawnSync(process.execPath, ["scripts/quality.mjs", mode, file], {
      cwd: directory,
      encoding: "utf8",
    });
  const reject = (result, pattern) => {
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, pattern);
  };
  for (const mode of ["lint", "format:check"]) {
    const result = check(mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const config = JSON.parse(readFileSync(join(directory, ".oxlintrc.json")));
  config.rules["no-debugger"] = "off";
  const configBytes = JSON.stringify(config);
  writeFileSync(join(directory, ".oxlintrc.json"), configBytes);
  const baseline = JSON.parse(readFileSync(join(directory, "quality-baseline.json")));
  baseline.configs[".oxlintrc.json"] = digest(configBytes);
  writeFileSync(join(directory, "quality-baseline.json"), JSON.stringify(baseline));
  writeFileSync(join(directory, "src/policy-new-debugger.mjs"), "debugger;\n");
  const result = check("lint", "src/policy-new-debugger.mjs");
  t.diagnostic(result.stdout + result.stderr);
  assert.notEqual(result.status, 0, "changing both editable files must not admit debugger");
  assert.match(result.stderr, /QUALITY_BASELINE_REQUIRED|QUALITY_POLICY_REQUIRED/);
  restore();
  for (const tool of ["oxlint", "oxfmt"]) {
    const declared = JSON.parse(original["package.json"]);
    const changed = JSON.parse(original["quality-baseline.json"]);
    declared.devDependencies[tool] = "0.0.0";
    changed.versions[tool] = "0.0.0";
    writeFileSync(join(directory, "package.json"), JSON.stringify(declared));
    writeFileSync(join(directory, "quality-baseline.json"), JSON.stringify(changed));
    reject(check("lint"), /QUALITY_BASELINE_REQUIRED|QUALITY_BASELINE_TOOL_CHANGED/);
    restore();
    writeFileSync(join(directory, "package.json"), JSON.stringify(declared));
    reject(check("lint"), /QUALITY_BASELINE_TOOL_CHANGED/);
    restore();
    const installed = join(directory, "node_modules", tool, "package.json");
    const bytes = readFileSync(installed);
    const metadata = JSON.parse(bytes);
    metadata.version = "0.0.0";
    // pnpm may hardlink package files into its store. Replace the fixture inode, never edit it.
    writeFileSync(installed + ".quality-test", JSON.stringify(metadata));
    renameSync(installed + ".quality-test", installed);
    try {
      reject(check("lint"), /QUALITY_BASELINE_TOOL_CHANGED/);
    } finally {
      writeFileSync(installed + ".quality-test", bytes);
      renameSync(installed + ".quality-test", installed);
    }
  }
  const formatter = JSON.parse(original[".oxfmtrc.json"]);
  formatter.semi = false;
  const changed = JSON.parse(original["quality-baseline.json"]);
  changed.configs[".oxfmtrc.json"] = digest(JSON.stringify(formatter));
  writeFileSync(join(directory, ".oxfmtrc.json"), JSON.stringify(formatter));
  writeFileSync(join(directory, "quality-baseline.json"), JSON.stringify(changed));
  reject(check("format:check"), /QUALITY_BASELINE_REQUIRED|QUALITY_POLICY_REQUIRED/);
  restore();
  for (const file of ["quality-baseline.json", ".oxlintrc.json", ".oxfmtrc.json"]) {
    assert.equal(original[file].includes("\r"), false);
    writeFileSync(join(directory, file), original[file].toString().replaceAll("\n", "\r\n"));
  }
  for (const mode of ["lint", "format:check"]) {
    const crlf = check(mode);
    assert.equal(crlf.status, 0, crlf.stdout + crlf.stderr);
  }
  restore();
  for (const file of ["quality-baseline.json", ".oxlintrc.json", ".oxfmtrc.json"]) {
    writeFileSync(join(directory, file), original[file].toString().replace("\n", "\r\n"));
    reject(check("lint"), /QUALITY_BASELINE_REQUIRED|QUALITY_POLICY_REQUIRED/);
    restore();
  }
  for (const [file, bytes] of Object.entries(original))
    assert.deepEqual(readFileSync(join(directory, file)), bytes);
  for (const file of ["src/policy-valid.mjs", "src/policy-new-debugger.mjs"])
    rmSync(join(directory, file));
  // Later main debt stays red. Compare the unmodified fixture before adding generated outputs.
  const originalDiscovery = spawnSync(process.execPath, ["scripts/quality.mjs", "lint"], {
    cwd: directory,
    encoding: "utf8",
  });
  // Original generated/third-party exclusions remain outside authored-source discovery.
  mkdirSync(join(directory, "src/lib"));
  writeFileSync(join(directory, "src/lib/policy-generated.mjs"), "debugger;\n");
  writeFileSync(join(directory, "desktop/core-asar-reader.cjs"), "debugger;\n");
  const discover = (name) => {
    const startedAt = new Date().toISOString();
    const result = spawnSync(process.execPath, ["scripts/quality.mjs", "lint"], {
      cwd: directory,
      encoding: "utf8",
    });
    t.diagnostic(
      JSON.stringify({
        name,
        startedAt,
        finishedAt: new Date().toISOString(),
        exit: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    return result;
  };
  const generated = discover("original-generated-and-third-party-exclusions");
  assert.equal(generated.status, originalDiscovery.status, generated.stdout + generated.stderr);
  assert.equal(generated.stdout, originalDiscovery.stdout);
  assert.deepEqual(
    generated.stderr.trim().split("\n").sort(),
    originalDiscovery.stderr.trim().split("\n").sort(),
  );
  const probe = "src/shared/policy-ignored.mjs";
  writeFileSync(join(directory, probe), "debugger;\n");
  const consumer = "src/shared/environments.js";
  writeFileSync(
    join(directory, consumer),
    'import "./policy-ignored.mjs";\n' + readFileSync(join(directory, consumer), "utf8"),
  );
  reject(discover("tracked-consumer-new-source"), /policy-ignored\.mjs: eslint\(no-debugger\)/);
  appendFileSync(join(directory, ".gitignore"), "\n/" + probe + "\n");
  command(directory, "git", ["add", consumer, ".gitignore", "scripts/quality.mjs"]);
  command(directory, "git", [
    "-c",
    "user.name=Quality Fixture",
    "-c",
    "user.email=quality@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "reference ignored authored source",
  ]);
  assert.equal(command(directory, "git", ["status", "--porcelain", "--untracked-files=all"]), "");
  const runtime = command(directory, process.execPath, [
    "--input-type=module",
    "-e",
    "import { resolveEnvironments } from './src/shared/environments.js'; console.log(JSON.stringify(resolveEnvironments({ geaBaseUrl: 'https://example.invalid' })))",
  ]);
  t.diagnostic(
    JSON.stringify({
      name: "actual-tracked-consumer",
      head: command(directory, "git", ["rev-parse", "HEAD"]),
      status: "clean",
      runtime,
    }),
  );
  assert.equal(JSON.parse(runtime).baseUrl, "https://example.invalid");
  reject(
    discover("ignored-authored-source-with-clean-tracked-consumer"),
    /policy-ignored\.mjs: eslint\(no-debugger\)/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
}

test("GEA public final-group mode admits actual cold Git sources and keeps default fixed peers independent", (t) => {
  const job = mkdtempSync(join(tmpdir(), "gea-final-group-"));
  t.after(() => rmSync(job, { recursive: true, force: true }));
  const sources = {
    "dsh-agent-workbench": realpathSync(
      process.env.GEA_FINAL_GROUP_WORKBENCH_SOURCE ?? resolve(root, "../dsh-agent-workbench"),
    ),
    "dsh-agent-manage": realpathSync(
      process.env.GEA_FINAL_GROUP_MANAGE_SOURCE ?? resolve(root, "../dsh-agent-manage"),
    ),
    "dsh-gea-plugin": realpathSync(root),
  };
  const roots = {};
  for (const [repo, source] of Object.entries(sources)) {
    const parent = join(job, repo === "dsh-agent-workbench" ? "source" : "candidate");
    mkdirSync(parent, { recursive: true });
    roots[repo] = realpathSync(parent) + "/" + repo;
    git(job, "clone", "--quiet", "--no-hardlinks", source, roots[repo]);
  }
  const gea = roots["dsh-gea-plugin"],
    workbench = roots["dsh-agent-workbench"];
  // The private fixture commits the current public entry under review. All other source is real Git.
  for (const file of [
    "scripts/run-quality-ci.mjs",
    "scripts/final-group-input.contract.mjs",
    "package.json",
  ])
    copyFileSync(join(root, file), join(gea, file));
  git(
    gea,
    "add",
    "scripts/run-quality-ci.mjs",
    "scripts/final-group-input.contract.mjs",
    "package.json",
  );
  git(
    gea,
    "-c",
    "user.name=Quality Fixture",
    "-c",
    "user.email=quality@example.invalid",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "freeze public GEA admission under review",
  );
  const paths = JSON.parse(readFileSync(join(workbench, "tsconfig.official.json"))).compilerOptions
    .paths;
  const cordis = resolve(sources["dsh-agent-workbench"], paths["@deepseek-ai/cordis"][0]);
  const coreSource = realpathSync(
    process.env.GEA_FINAL_GROUP_CORE_SOURCE ?? resolve(dirname(cordis), "../../../.."),
  );
  const core = join(job, "cold-core-source");
  git(job, "clone", "--quiet", "--no-hardlinks", "--no-checkout", coreSource, core);
  git(core, "sparse-checkout", "set", "--no-cone", "/package.json", "/pnpm-lock.yaml");
  git(core, "checkout", "--quiet", "5badb15009ae1756c3afe0ae0cef1faafc290ccc");
  assert.equal(existsSync(join(core, "vendor/cordis/lib/types/index.d.ts")), false);
  const manifest = {
    core: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    repositories: Object.entries(roots).map(([repo, path]) => ({
      repo,
      path,
      head: git(path, "rev-parse", "HEAD"),
    })),
  };
  const file = join(job, "group.json");
  const original = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(file, original);
  const entriesBefore = readdirSync(job).sort();
  const run = (name, extra = [], environment = {}) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...environment };
    for (const key of ["CI", "QUALITY_EXPECTED_SHA"])
      if (!Object.hasOwn(environment, key)) delete env[key];
    const args = [
      "scripts/run-quality-ci.mjs",
      "--phase",
      "verify-input",
      "--input",
      file,
      "--final-group-sha256",
      digest(readFileSync(file)),
      "--final-group-workbench",
      workbench,
      "--core-source",
      core,
      ...extra,
    ];
    const startedAt = new Date().toISOString();
    const result = spawnSync(process.execPath, args, { cwd: gea, encoding: "utf8", env });
    t.diagnostic(
      JSON.stringify({
        name,
        startedAt,
        finishedAt: new Date().toISOString(),
        argv: [process.execPath, ...args],
        exit: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    return result;
  };
  const unchangedEffects = () => {
    assert.deepEqual(readdirSync(job).sort(), entriesBefore);
    assert.equal(existsSync(join(job, "official-latest-standard")), false);
    assert.equal(existsSync(join(job, "candidate/dsh-agent-workbench")), false);
    for (const path of Object.values(roots))
      assert.equal(existsSync(join(path, "node_modules")), false);
  };
  const good = run("source-only", ["--prepare-sdk", "--prepare-inputs"], {
    CI: "true",
    QUALITY_EXPECTED_SHA: manifest.repositories.find((entry) => entry.repo === "dsh-gea-plugin")
      .head,
  });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const receipt = JSON.parse(good.stdout);
  assert.equal(receipt.stage, "candidate-source-only");
  for (const field of ["sdk", "quality", "compatibility", "runtime"])
    assert.equal(receipt[field], "not-observed");
  assert.equal(receipt.inputSha256, digest(original));
  assert.deepEqual(readFileSync(file), original);
  unchangedEffects();
  const reject = (result, pattern) => {
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, pattern);
    unchangedEffects();
  };
  reject(
    run("wrong-reader-root", ["--final-group-workbench", sources["dsh-agent-workbench"]]),
    /CANDIDATE_INTERFACE_CHECKOUT/,
  );
  reject(run("wrong-hash", ["--final-group-sha256", "0".repeat(64)]), /CANDIDATE_INPUT_HASH/);
  reject(run("unknown-option", ["--unknown-final-group"]), /Unknown option/);
  reject(
    run("missing-value", ["--final-group-workbench"]),
    /--final-group-workbench <value>.*argument missing/,
  );
  reject(run("empty-source", ["--final-group-workbench", ""]), /CANDIDATE_FINAL_GROUP_REQUIRED/);
  reject(run("missing-event", [], { CI: "true" }), /CANDIDATE_EVENT_REQUIRED/);
  reject(
    run("wrong-event", [], { CI: "true", QUALITY_EXPECTED_SHA: "a".repeat(40) }),
    /CANDIDATE_EVENT_MISMATCH/,
  );
  reject(run("input-phase-cannot-write", ["--phase", "input"]), /CANDIDATE_FINAL_GROUP_PHASE/);
  for (const [name, args] of [
    ["source-flag-cannot-select-default", ["--input", file, "--final-group-workbench", workbench]],
    ["hash-without-source", ["--input", file, "--final-group-sha256", digest(original)]],
    [
      "explicit-flags-without-input",
      ["--final-group-workbench", workbench, "--final-group-sha256", digest(original)],
    ],
  ]) {
    const startedAt = new Date().toISOString();
    const result = spawnSync(process.execPath, ["scripts/run-quality-ci.mjs", ...args], {
      cwd: gea,
      encoding: "utf8",
    });
    t.diagnostic(
      JSON.stringify({
        name,
        startedAt,
        finishedAt: new Date().toISOString(),
        argv: [process.execPath, "scripts/run-quality-ci.mjs", ...args],
        exit: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    );
    reject(result, /CANDIDATE_FINAL_GROUP_REQUIRED/);
  }
  const collision = JSON.parse(original);
  collision.repositories[1].path = collision.repositories[0].path;
  writeFileSync(file, JSON.stringify(collision));
  reject(run("path-collision"), /CANDIDATE_PATH_COLLISION/);
  writeFileSync(file, original);
  writeFileSync(join(gea, "uncommitted-source.txt"), "dirty source\n");
  const dirty = run("dirty-source");
  rmSync(join(gea, "uncommitted-source.txt"));
  reject(dirty, /CANDIDATE_DIRTY/);
  reject(run("quality-still-requires-sdk", ["--phase", "quality"]), /SDK_SOURCE_REQUIRED/);
  // Real old peers have no shared-reader export. The default path reaches its unchanged missing-SDK guard.
  git(workbench, "checkout", "--quiet", "--detach", "9b4863692cb29a3edc8a2358e98feb7846526d1b");
  git(
    roots["dsh-agent-manage"],
    "checkout",
    "--quiet",
    "--detach",
    "9e9aba86d12a2d743604e63a6000e7abb7da1ddd",
  );
  assert.equal(existsSync(join(workbench, "scripts/candidate-input.mjs")), false);
  const legacy = JSON.parse(original);
  for (const entry of legacy.repositories) entry.head = git(entry.path, "rev-parse", "HEAD");
  writeFileSync(file, JSON.stringify(legacy));
  const startedAt = new Date().toISOString();
  const defaults = spawnSync(process.execPath, ["scripts/run-quality-ci.mjs", "--input", file], {
    cwd: gea,
    encoding: "utf8",
    env: { ...process.env, CI: "", QUALITY_EXPECTED_SHA: "", GIT_OPTIONAL_LOCKS: "0" },
  });
  t.diagnostic(
    JSON.stringify({
      name: "default-real-old-peers",
      startedAt,
      finishedAt: new Date().toISOString(),
      exit: defaults.status,
      stdout: defaults.stdout,
      stderr: defaults.stderr,
    }),
  );
  reject(defaults, /SDK_SOURCE_REQUIRED/);
  assert.doesNotMatch(defaults.stderr, /ERR_MODULE_NOT_FOUND|CANDIDATE_INTERFACE/);
  const packageScripts = JSON.parse(readFileSync(join(root, "package.json"))).scripts;
  assert.doesNotMatch(packageScripts["test:quality"], /final-group-input/);
  assert.equal(
    globSync("tests/*.test.mjs", { cwd: root }).includes("scripts/final-group-input.contract.mjs"),
    false,
  );
  t.diagnostic(
    JSON.stringify({
      observedAt: new Date().toISOString(),
      sources,
      manifest,
      coreSource,
      corePrepared: false,
      defaults: {
        workbench: legacy.repositories.find((entry) => entry.repo === "dsh-agent-workbench").head,
        manage: legacy.repositories.find((entry) => entry.repo === "dsh-agent-manage").head,
      },
      effects: "no installation, SDK/assets preparation or source profile",
    }),
  );
});

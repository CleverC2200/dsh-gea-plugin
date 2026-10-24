import fs from "node:fs";
import os from "node:os";
import { resolve, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";

const root = process.cwd(), job = resolve(root, "../..");
const output = join(job, "returned-cache-results");
fs.mkdirSync(output, { recursive: true });
const json = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const save = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const digest = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const { createExecutionPlan, executionDigest, runExecutionPlan } = await import(
  pathToFileURL(join(root, "scripts/quality-test-execution.mjs"))
);
const sourceHead = process.env.SOURCE_HEAD_SHA;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const stages = json(join(job, "quality-stages.json"));
assert.equal(stages.stages.prepare.status, "passed");
assert.equal(stages.stages.build.status, "passed");
const buildSha256 = executionDigest(stages.artifacts);
const files = ["tests/returned-resubmit-web.test.mjs"];
const anchors = ["scripts/quality-policy.test.mjs", "scripts/quality-test-reporter.test.mjs"];
const candidate = join(job, "candidate-input.json"), inputs = join(job, "profile-source-inputs.json");
const binding = { sourceHead, inputSha256: digest(candidate), sourcesSha256: digest(inputs), buildSha256 };
const verify = () => {
  assert.equal(git("rev-parse", "HEAD"), sourceHead);
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(digest(candidate), binding.inputSha256);
  assert.equal(digest(inputs), binding.sourcesSha256);
};
verify();
const sequence = process.env.CACHE_SEQUENCE;
assert.ok(["off-on", "on-off"].includes(sequence));
assert.equal(process.env.NODE_V8_COVERAGE, undefined, "coverage must not be changed to run the experiment");
const read = (p) => fs.readFileSync(p, "utf8");
save(join(output, "environment.json"), {
  sequence, binding, files, anchors, fileConcurrency: 3, testFileUvThreadpoolSize: 4,
  node: process.version, cpus: os.cpus().map(({ model, speed }) => ({ model, speed })),
  availableParallelism: os.availableParallelism(), totalMemory: os.totalmem(),
  imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
  kernel: os.release(), chrome: execFileSync("google-chrome", ["--version"], { encoding: "utf8" }).trim(),
  bootId: read("/proc/sys/kernel/random/boot_id").trim(), cpuinfo: read("/proc/cpuinfo"),
  sourceDelta: git("diff", "--stat", "9f56bc4439c9e195f6a9e156933be9d3274869b7", "HEAD"),
});
const environment = {
  GEA_TEST_SOURCE_INPUTS: inputs, GEA_TEST_CANDIDATE: candidate,
  GEA_TEST_CANDIDATE_SHA256: binding.inputSha256, GEA_TEST_SOURCE_CORE: "1",
  GEA_TEST_CANDIDATE_INPUTS: join(job, "source-window-inputs.json"),
  GEA_PLUGIN_UPDATE_SDK: join(job, "official-latest-standard"),
  GEA_PLUGIN_UPDATE_CANDIDATE_CORE: join(job, "official-latest-standard"),
  PLAYWRIGHT_BROWSERS_PATH: join(job, ".quality-browser"),
};
function inventory(directory) {
  const files = [];
  function visit(path) {
    for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else {
        assert.ok(entry.isFile(), "compile cache inventory must contain only regular files");
        files.push({ file: relative(directory, file), bytes: fs.statSync(file).size, sha256: digest(file) });
      }
    }
  }
  visit(directory);
  return { files, fileCount: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
}
function execute(selected, directory, mode, cacheDirectory) {
  fs.mkdirSync(directory, { recursive: true });
  const selection = { applicability: "source", files: selected, required: selected, runtimeFiles: mode ? selected : [], browser: Boolean(mode) };
  const plan = createExecutionPlan({ selection, platformPlan: { files: selected }, binding, shardCount: 1, concurrency: 3 });
  save(join(directory, "plan.json"), plan);
  const result = runExecutionPlan({
    plan, root, resultFile: join(directory, "execution.json"),
    reporter: resolve(import.meta.dirname, "reporter.mjs"), buildSha256, verifyUnchanged: verify,
    environment: { ...environment,
      GEA_TEST_LIFECYCLE_RECEIPT: join(directory, "lifecycle.jsonl"),
      CROSSOVER_EVENTS: join(directory, "events.jsonl"),
      ...(mode ? { GEA_RETURNED_COMPILE_CACHE_MODE: mode, GEA_RETURNED_COMPILE_CACHE_DIR: cacheDirectory } : {}) },
  });
  assert.equal(result.receipt.results[0].report.summary.counts.tests, mode ? 17 : 11);
  return result;
}
const sampler = spawn(process.execPath, [resolve(import.meta.dirname, "sample.mjs"), output], { stdio: "inherit" });
const baselinePids = new Set(execFileSync("ps", ["-eo", "pid="], { encoding: "utf8" }).trim().split(/\s+/));
function noLeftovers() {
  const lines = execFileSync("ps", ["-eo", "pid=,stat=,comm="], { encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(lines.filter(line => {
    const [pid, state, name] = line.trim().split(/\s+/);
    return !baselinePids.has(pid) && !state.startsWith("Z") && /^(node|chrome|chromium|chrome_crashpad)$/.test(name);
  }), [], "new live Node/Chrome processes remain between rounds");
}
try {
  const completed = [];
  for (const [index, mode] of sequence.split("-").entries()) {
    noLeftovers();
    const directory = join(output, `${index + 1}-${mode}`);
    fs.mkdirSync(directory, { recursive: true });
    execute(anchors, join(directory, "anchor-before"));
    const cacheDirectory = join(process.env.RUNNER_TEMP, `returned-cache-${sequence}-${mode}`);
    assert.equal(fs.existsSync(cacheDirectory), false, "cache must start without prewarming");
    const startedAt = new Date().toISOString(), start = performance.now();
    fs.mkdirSync(cacheDirectory, { recursive: false });
    const before = inventory(cacheDirectory);
    assert.equal(before.fileCount, 0);
    execute(files, join(directory, "tests"), mode, cacheDirectory);
    const durationMs = performance.now() - start;
    const finishedAt = new Date().toISOString();
    noLeftovers();
    const after = inventory(cacheDirectory);
    if (mode === "off") assert.equal(after.fileCount, 0, "off arm must not write compile cache");
    const round = { mode, index, startedAt, finishedAt, durationMs, binding, cacheDirectory, before, after };
    save(join(directory, "round.json"), round);
    completed.push(round);
    execute(anchors, join(directory, "anchor-after"));
    console.log(JSON.stringify({ mode, sequence, durationMs, cacheFiles: after.fileCount, cacheBytes: after.bytes, completed: true }));
  }
  save(join(output, "complete.json"), { functionalStatus: "passed", sequence, binding, rounds: completed.length, testsPerRound: 17 });
} finally {
  sampler.kill("SIGTERM");
}

import fs from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";

const root = process.cwd(), job = resolve(root, "../.."), output = join(job, "returned-cost-results");
fs.mkdirSync(output, { recursive: true });
const json = path => JSON.parse(fs.readFileSync(path, "utf8"));
const save = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const digest = path => createHash("sha256").update(fs.readFileSync(path)).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { createExecutionPlan, executionDigest, runExecutionPlan } = await import(pathToFileURL(join(root, "scripts/quality-test-execution.mjs")));
const stages = json(join(job, "quality-stages.json"));
assert.equal(stages.stages.prepare.status, "passed");
assert.equal(stages.stages.build.status, "passed");
const candidate = join(job, "candidate-input.json"), inputs = join(job, "profile-source-inputs.json");
const binding = { sourceHead: process.env.SOURCE_HEAD_SHA, inputSha256: digest(candidate), sourcesSha256: digest(inputs), buildSha256: executionDigest(stages.artifacts) };
const verify = () => {
  assert.equal(git("rev-parse", "HEAD"), binding.sourceHead);
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(digest(candidate), binding.inputSha256);
  assert.equal(digest(inputs), binding.sourcesSha256);
};
verify();
assert.equal(process.env.NODE_V8_COVERAGE, undefined);
save(join(output, "environment.json"), {
  binding, node: process.version, cpus: os.cpus().map(({ model, speed }) => ({ model, speed })),
  availableParallelism: os.availableParallelism(), totalMemory: os.totalmem(),
  imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion, kernel: os.release(),
  chrome: execFileSync("google-chrome", ["--version"], { encoding: "utf8" }).trim(),
  bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  compileCache: "off", sourceDelta: git("diff", "--stat", "64a5d694356795a1302edf6b38461f674310be86", "HEAD"),
});
const files = ["tests/returned-resubmit-web.test.mjs"];
const selection = { applicability: "source", files, required: files, runtimeFiles: files, browser: true };
const plan = createExecutionPlan({ selection, platformPlan: { files }, binding, shardCount: 1, concurrency: 3 });
save(join(output, "plan.json"), plan);
const cacheDirectory = join(process.env.RUNNER_TEMP, "returned-cost-cache-off");
assert.equal(fs.existsSync(cacheDirectory), false);
fs.mkdirSync(cacheDirectory);
const sampler = spawn(process.execPath, [resolve(import.meta.dirname, "sample.mjs"), output], { stdio: "inherit" });
const baselinePids = new Set(execFileSync("ps", ["-eo", "pid="], { encoding: "utf8" }).trim().split(/\s+/));
const start = performance.now(), startedAt = new Date().toISOString();
try {
  const result = runExecutionPlan({
    plan, root, resultFile: join(output, "execution.json"), reporter: resolve(import.meta.dirname, "reporter.mjs"),
    buildSha256: binding.buildSha256, verifyUnchanged: verify,
    environment: {
      GEA_TEST_SOURCE_INPUTS: inputs, GEA_TEST_CANDIDATE: candidate,
      GEA_TEST_CANDIDATE_SHA256: binding.inputSha256, GEA_TEST_SOURCE_CORE: "1",
      GEA_TEST_CANDIDATE_INPUTS: join(job, "source-window-inputs.json"),
      GEA_PLUGIN_UPDATE_SDK: join(job, "official-latest-standard"),
      GEA_PLUGIN_UPDATE_CANDIDATE_CORE: join(job, "official-latest-standard"),
      PLAYWRIGHT_BROWSERS_PATH: join(job, ".quality-browser"),
      GEA_TEST_LIFECYCLE_RECEIPT: join(output, "lifecycle.jsonl"),
      CROSSOVER_EVENTS: join(output, "events.jsonl"),
      GEA_SOURCE_COST_RECEIPT: join(output, "source-cost.jsonl"),
      GEA_RETURNED_COMPILE_CACHE_MODE: "off", GEA_RETURNED_COMPILE_CACHE_DIR: cacheDirectory,
    },
  });
  const durationMs = performance.now() - start;
  const receipt = result.receipt;
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.results.length, 1);
  assert.equal(receipt.results[0].libuvPool.size, 4);
  const report = receipt.results[0].report;
  assert.equal(report.files.length, 1);
  assert.equal(report.summary.counts.tests, 17);
  assert.equal(report.summary.counts.passed, 17);
  for (const key of ["failed", "skipped", "cancelled", "todo"]) assert.equal(report.summary.counts[key], 0);
  assert.deepEqual(fs.readdirSync(cacheDirectory), []);
  const leftover = execFileSync("ps", ["-eo", "pid=,stat=,comm="], { encoding: "utf8" }).trim().split("\n").filter(line => {
    const [pid, state, name] = line.trim().split(/\s+/);
    return !baselinePids.has(pid) && !state.startsWith("Z") && /^(node|chrome|chromium|chrome_crashpad)$/.test(name);
  });
  assert.deepEqual(leftover, []);
  const costs = fs.readFileSync(join(output, "source-cost.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(costs.length, 68);
  for (const cost of costs) {
    assert.equal(cost.status, "passed");
    assert.ok(Math.abs(Object.values(cost.coverageMs).reduce((a, b) => a + b, 0) - cost.durationMs) < 0.01);
    for (const metric of Object.values(cost.metrics)) assert.equal(metric.active, 0);
  }
  save(join(output, "complete.json"), { functionalStatus: "passed", binding, startedAt, finishedAt: new Date().toISOString(), durationMs, tests: 17, sourceCostRoots: costs.length, compileCache: "off", fullCi: "not-run" });
} finally {
  sampler.kill("SIGTERM");
}

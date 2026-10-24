import fs from "node:fs";
import os from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import assert from "node:assert/strict";

const root = process.cwd(), job = resolve(root, "../..");
const output = join(job, "crossover-results");
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
const files = ["tests/returned-resubmit-web.test.mjs", "tests/source-update-web.test.mjs", "tests/native-page-identity-web.test.mjs"];
const anchors = ["scripts/quality-policy.test.mjs", "scripts/quality-test-reporter.test.mjs"];
const candidate = join(job, "candidate-input.json");
const inputs = join(job, "profile-source-inputs.json");
const binding = { sourceHead, inputSha256: digest(candidate), sourcesSha256: digest(inputs), buildSha256 };
const verify = () => {
  assert.equal(git("rev-parse", "HEAD"), sourceHead);
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(digest(candidate), binding.inputSha256);
  assert.equal(digest(inputs), binding.sourcesSha256);
};
verify();
assert.ok(["AB", "BA"].includes(process.env.CROSSOVER_SEQUENCE));
const read = (p) => fs.readFileSync(p, "utf8");
const chrome = execFileSync("google-chrome", ["--version"], { encoding: "utf8" }).trim();
save(join(output, "environment.json"), {
  sequence: process.env.CROSSOVER_SEQUENCE, binding, files, anchors,
  node: process.version, cpus: os.cpus().map(({ model, speed }) => ({ model, speed })),
  availableParallelism: os.availableParallelism(), totalMemory: os.totalmem(),
  imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
  kernel: os.release(), chrome, bootId: read("/proc/sys/kernel/random/boot_id").trim(),
  cpuinfo: read("/proc/cpuinfo"), osRelease: read("/etc/os-release"),
  sourceDelta: git("diff", "--stat", "9beb3ca6828414f666b61e784911aa17c5b8cfa9", "HEAD"),
});
const environment = {
  GEA_TEST_SOURCE_INPUTS: inputs, GEA_TEST_CANDIDATE: candidate,
  GEA_TEST_CANDIDATE_SHA256: binding.inputSha256, GEA_TEST_SOURCE_CORE: "1",
  GEA_TEST_CANDIDATE_INPUTS: join(job, "source-window-inputs.json"),
  GEA_PLUGIN_UPDATE_SDK: join(job, "official-latest-standard"),
  GEA_PLUGIN_UPDATE_CANDIDATE_CORE: join(job, "official-latest-standard"),
  PLAYWRIGHT_BROWSERS_PATH: join(job, ".quality-browser"), UV_THREADPOOL_SIZE: "1",
};
const sampler = spawn(process.execPath, [resolve(import.meta.dirname, "sample.mjs"), output], { stdio: "inherit" });
const baselinePids = new Set(execFileSync("ps", ["-eo", "pid="], { encoding: "utf8" }).trim().split(/\s+/));
function assertNoLeftovers() {
  const rows = execFileSync("ps", ["-eo", "pid=,stat=,comm="], { encoding: "utf8" }).trim().split("\n");
  const leftovers = rows.filter((line) => {
    const [pid, state, name] = line.trim().split(/\s+/);
    return !baselinePids.has(pid) && !state.startsWith("Z") && /^(node|chrome|chromium|chrome_crashpad)$/.test(name);
  });
  assert.deepEqual(leftovers, [], "new Node/Chrome processes remain between rounds");
}
function execute(selected, concurrency, directory, heavy) {
  fs.mkdirSync(directory, { recursive: true });
  const selection = { applicability: "source", files: selected, required: selected, runtimeFiles: heavy ? selected : [], browser: heavy };
  const plan = createExecutionPlan({ selection, platformPlan: { files: selected }, binding, shardCount: 1, concurrency });
  plan.shards[0].files = [...selected];
  const { planSha256: _hash, ...contents } = plan;
  plan.planSha256 = executionDigest(contents);
  save(join(directory, "plan.json"), plan);
  const result = runExecutionPlan({
    plan, root, resultFile: join(directory, "execution.json"),
    reporter: resolve(import.meta.dirname, "reporter.mjs"), buildSha256, verifyUnchanged: verify,
    environment: { ...environment,
      GEA_TEST_LIFECYCLE_RECEIPT: join(directory, "lifecycle.jsonl"),
      CROSSOVER_EVENTS: join(directory, "events.jsonl") },
  });
  const count = result.receipt.results.reduce((n, r) => n + r.report.summary.counts.tests, 0);
  assert.equal(count, heavy ? 24 : 11, "selected case inventory");
  return result;
}
try {
  for (const [index, arm] of [...process.env.CROSSOVER_SEQUENCE].entries()) {
    assertNoLeftovers();
    const directory = join(output, `${index + 1}-${arm}`);
    fs.mkdirSync(directory, { recursive: true });
    execute(anchors, 2, join(directory, "anchor-before"), false);
    const startedAt = new Date().toISOString(), start = performance.now();
    execute(files, arm === "A" ? 3 : 2, join(directory, "heavy"), true);
    const durationMs = performance.now() - start;
    save(join(directory, "round.json"), { arm, index, concurrency: arm === "A" ? 3 : 2, startedAt, finishedAt: new Date().toISOString(), durationMs, binding });
    execute(anchors, 2, join(directory, "anchor-after"), false);
    assertNoLeftovers();
    const runtime = join(root, ".runtime/ticket-10");
    if (fs.existsSync(runtime)) fs.renameSync(runtime, join(directory, "preserved-ticket-10"));
    console.log(JSON.stringify({ arm, sequence: process.env.CROSSOVER_SEQUENCE, durationMs, completed: true }));
  }
  save(join(output, "complete.json"), { status: "passed", sequence: process.env.CROSSOVER_SEQUENCE, binding, rounds: 2, heavyCasesPerRound: 24 });
} finally {
  sampler.kill("SIGTERM");
}

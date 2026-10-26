import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd(), job = resolve(root, '../..'), output = join(job, 'batch-linux-results');
fs.mkdirSync(output, { recursive: true });
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
const scopeFile = join(import.meta.dirname, 'overlap-scope.json'), scope = json(scopeFile);
assert.equal(scope.maxRounds, 3);
assert.equal(scope.concurrency, 3);
const environment = {
  node: process.version, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion,
  kernel: os.release(), cpus: os.cpus().map(({ model }) => model), totalMemory: os.totalmem(),
  availableParallelism: os.availableParallelism(), bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  clockTicksPerSecond: Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()),
  chrome: execFileSync('google-chrome', ['--version'], { encoding: 'utf8' }).trim(),
  wrapperHead: git(join(job, 'experiment'), 'rev-parse', 'HEAD'), sourceHead: git(root, 'rev-parse', 'HEAD'),
  originalFailure: 40206693766, originalImage: '20261012.334.1', expectedImage: '20261023.334.3', expectedNode: 'v24.22.0',
  imageDifferenceAcceptedByUser: true, imageSoftwareDifference: 'Bazel 9.3.0 -> 9.3.1; original and current official software inventories retained separately',
  vmAndOtherFileLoadRecreated: false, maxRounds: scope.maxRounds, files: scope.files, scopeSha256: digest(scopeFile),
  replay: 'bounded third-case overlapping tail; two background files delayed before module evaluation',
};
save(join(output, 'environment.json'), environment);
save(join(output, 'scope.json'), scope);
assert.equal(environment.node, environment.expectedNode);
assert.equal(environment.imageOS, 'ubuntu24');
assert.equal(environment.imageVersion, environment.expectedImage);
assert.equal(environment.chrome, 'Google Chrome 155.0.8059.39');
assert.equal(environment.kernel, '6.17.0-1022-azure');
assert.equal(environment.sourceHead, '9c9f4e15b5756f167cc9148bc3673782408adcfc');
assert.ok(environment.availableParallelism >= 4 && environment.totalMemory >= 12 * 1024 ** 3);
if (process.argv.includes('--environment-only')) process.exit(0);

const { createExecutionPlan, executionDigest, runExecutionPlan } = await import(pathToFileURL(join(root, 'scripts/quality-test-execution.mjs')));
const { readFinalGroup } = await import(pathToFileURL(join(job, 'source/dsh-agent-workbench/scripts/candidate-input.mjs')));
const { resourceDigests } = await import(pathToFileURL(join(root, 'scripts/source-profile.mjs')));
const stages = json(join(job, 'quality-stages.json'));
for (const phase of ['prepare', 'build', 'checks']) assert.equal(stages.stages[phase].status, 'passed');
const candidate = join(job, 'candidate-input.json'), inputs = join(job, 'profile-source-inputs.json');
const binding = { sourceHead: environment.sourceHead, inputSha256: digest(candidate), sourcesSha256: digest(inputs), buildSha256: executionDigest(stages.artifacts) };
const group = await readFinalGroup({ input: candidate, sha256: binding.inputSha256, checkout: root, repo: 'dsh-gea-plugin', coreSource: join(job, 'source/official-core'), expectedSha: environment.sourceHead, ci: process.env.CI });
for (const file of scope.files) assert.ok(fs.readFileSync(join(root, file)).equals(execFileSync('git', ['show', `${environment.sourceHead}:${file}`])));
const verify = () => {
  group.verifyUnchanged();
  assert.equal(digest(candidate), binding.inputSha256);
  assert.equal(digest(inputs), binding.sourcesSha256);
};
const verifyBuild = async () => {
  for (const [directory, expected] of Object.entries(stages.artifacts)) assert.deepEqual(await resourceDigests(directory), expected);
};
const baselinePids = new Set(execFileSync('ps', ['-eo', 'pid='], { encoding: 'utf8' }).trim().split(/\s+/));
const noLeftovers = () => {
  const leftover = execFileSync('ps', ['-eo', 'pid=,stat=,comm='], { encoding: 'utf8' }).trim().split('\n').filter((line) => {
    const [pid, state, name] = line.trim().split(/\s+/);
    return !baselinePids.has(pid) && !state.startsWith('Z') && /^(node|chrome|chromium|chrome_crashpad)$/.test(name);
  });
  assert.deepEqual(leftover, []);
};
const rounds = [];
for (let round = 1; round <= environment.maxRounds; round++) {
  noLeftovers(); verify(); await verifyBuild();
  const directory = join(output, `round-${round}`); fs.mkdirSync(directory);
  const files = scope.files;
  const plan = createExecutionPlan({ selection: { applicability: 'source', files, required: files, runtimeFiles: files, browser: true }, platformPlan: { files }, binding, shardCount: 1, concurrency: 3 });
  save(join(directory, 'plan.json'), plan);
  const stateFile = join(directory, 'public-state.jsonl');
  const startedAt = new Date().toISOString();
  const resourceFile = join(directory, 'resources.jsonl');
  const collector = spawn(process.execPath, [join(import.meta.dirname, 'resource-collector.mjs'), '--sample', resourceFile, String(process.pid), root], { stdio: ['ignore', 'inherit', 'inherit'] });
  const collectorExit = new Promise((resolve) => {
    collector.once('exit', (code, signal) => resolve({ code, signal }));
    collector.once('error', (error) => resolve({ error: error.code }));
  });
  let launchError;
  collector.once('error', (error) => { launchError = error; });
  const readyDeadline = performance.now() + 5000;
  while (performance.now() < readyDeadline && !launchError && !(fs.existsSync(resourceFile) && fs.readFileSync(resourceFile, 'utf8').includes('resource-collector-ready'))) await delay(50);
  let failure;
  let collectorResult;
  try {
    assert.ok(!launchError && fs.existsSync(resourceFile) && fs.readFileSync(resourceFile, 'utf8').includes('resource-collector-ready'), 'RESOURCE_COLLECTOR_NOT_READY');
    runExecutionPlan({ plan, root, resultFile: join(directory, 'execution.json'), reporter: join(root, 'scripts/quality-test-reporter.mjs'), buildSha256: binding.buildSha256, verifyUnchanged: verify,
      environment: {
        GEA_TEST_SOURCE_INPUTS: inputs, GEA_TEST_CANDIDATE: candidate, GEA_TEST_CANDIDATE_SHA256: binding.inputSha256, GEA_TEST_SOURCE_CORE: '1',
        GEA_TEST_CANDIDATE_INPUTS: join(job, 'source-window-inputs.json'), GEA_PLUGIN_UPDATE_SDK: join(job, 'official-latest-standard'),
        GEA_PLUGIN_UPDATE_CANDIDATE_CORE: join(job, 'official-latest-standard'), PLAYWRIGHT_BROWSERS_PATH: join(job, '.quality-browser'),
        GEA_TEST_LIFECYCLE_RECEIPT: join(directory, 'lifecycle.jsonl'), GEA_BATCH_DIAGNOSTICS: '1',
        GEA_BATCH_DIAGNOSTIC_PACKAGE: join(root, 'package.json'), GEA_BATCH_DIAGNOSTIC_OUTPUT: stateFile,
        GEA_BATCH_OVERLAP_SCOPE: scopeFile, GEA_BATCH_OVERLAP_STARTS: join(directory, 'module-starts.jsonl'),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + pathToFileURL(join(import.meta.dirname, 'public-state.mjs')).href, '--import=' + pathToFileURL(join(import.meta.dirname, 'resource-collector.mjs')).href].filter(Boolean).join(' '),
      },
    });
  } catch (error) { failure = error; }
  finally {
    collector.kill('SIGTERM');
    const timeout = new AbortController();
    collectorResult = await Promise.race([collectorExit, delay(5000, undefined, { signal: timeout.signal }).then(() => ({ timedOut: true }))]);
    timeout.abort();
    if (collectorResult.timedOut) { collector.kill('SIGKILL'); await collectorExit; }
  }
  const receipt = json(join(directory, 'execution.json'));
  const states = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const dialogs = states.filter((row) => row.kind === 'dialog');
  const coverage = { ownerReceipts: states.filter((row) => row.kind === 'owner').length, dialogSnapshots: dialogs.length,
    initialDisabledCaptured: dialogs.some((row) => row.state.remarkValue === '' && row.state.confirmDisabled),
    filledCaptured: dialogs.some((row) => row.state.remarkValue === '促销依据待补充'),
    filledEnabledCaptured: dialogs.some((row) => row.state.remarkValue === '促销依据待补充' && !row.state.confirmDisabled) };
  const resources = fs.existsSync(resourceFile) ? fs.readFileSync(resourceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const resourceCoverage = { samples: resources.filter((row) => row.kind === 'resources').length, complete: resources.at(-1)?.kind === 'resource-collector-complete', collectorExit: collectorResult };
  const record = { round, resourceCoverage, binding, bootId: environment.bootId, startedAt, finishedAt: new Date().toISOString(), status: receipt.status, coverage, counts: receipt.results[0]?.report?.summary?.counts ?? null, error: failure?.message ?? null };
  rounds.push(record); save(join(directory, 'round.json'), record); save(join(output, 'rounds.json'), rounds);
  verify(); await verifyBuild(); noLeftovers();
  console.log(JSON.stringify(record));
  if (failure) throw failure;
  assert.ok(resourceCoverage.samples >= 2 && resourceCoverage.complete && collectorResult.code === 0, 'RESOURCE_CAPTURE_INCOMPLETE');
  assert.equal(record.counts.tests, scope.expectedTests); assert.equal(record.counts.passed, scope.expectedTests);
  for (const key of ['failed', 'skipped', 'cancelled', 'todo']) assert.equal(record.counts[key], 0);
  assert.ok(coverage.initialDisabledCaptured && coverage.filledCaptured && coverage.filledEnabledCaptured, 'BATCH_PUBLIC_CAPTURE_INCOMPLETE');
}
save(join(output, 'complete.json'), { status: 'three-overlap-rounds-passed-without-original-failure', binding, rounds: rounds.length, testsPerRound: scope.expectedTests, fullCI: false, rootCauseEstablished: false });

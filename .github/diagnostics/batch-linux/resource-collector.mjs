import fs from 'node:fs';
import assert from 'node:assert/strict';
import { relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const tag = 'DEBUG-batch-overlap-20261026';
const save = (file, row) => fs.appendFileSync(file, JSON.stringify({ tag, at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });
const parseStat = (text) => {
  const end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
  return { pid: Number(text.slice(0, text.indexOf(' '))), comm: text.slice(text.indexOf('(') + 1, end), state: fields[0], ppid: Number(fields[1]), userTicks: Number(fields[11]), systemTicks: Number(fields[12]), startTicks: Number(fields[19]) };
};
const read = (path) => {
  try { return fs.readFileSync(path, 'utf8').trim(); }
  catch (error) { return { error: error.code }; }
};
const descendants = (rows, parent) => {
  const selected = new Set([parent]);
  let size;
  do {
    size = selected.size;
    for (const row of rows) if (selected.has(row.ppid)) selected.add(row.pid);
  } while (selected.size !== size);
  return rows.filter((row) => selected.has(row.pid));
};

if (process.argv.includes('--selfcheck')) {
  const values = Array.from({ length: 22 }, (_, i) => String(i));
  values[0] = 'S'; values[1] = '17'; values[11] = '120'; values[12] = '23'; values[19] = '900';
  assert.deepEqual(parseStat('42 (chrome (renderer)) ' + values.join(' ')), { pid: 42, comm: 'chrome (renderer)', state: 'S', ppid: 17, userTicks: 120, systemTicks: 23, startTicks: 900 });
  assert.deepEqual(descendants([{ pid: 5, ppid: 2 }, { pid: 7, ppid: 5 }, { pid: 9, ppid: 7 }, { pid: 10, ppid: 1 }], 5).map((row) => row.pid), [5, 7, 9]);
  console.log(JSON.stringify({ status: 'passed', nestedProcessNamesParsed: true, unrelatedProcessesExcluded: true }));
} else if (process.argv[2] === '--sample') {
  const [output, parentText, root] = process.argv.slice(3), parent = Number(parentText);
  assert.equal(process.platform, 'linux');
  assert.ok(Number.isSafeInteger(parent) && parent > 1);
  const membership = fs.readFileSync(`/proc/${parent}/cgroup`, 'utf8').split('\n').find((line) => line.startsWith('0::'))?.slice(3);
  const cgroupRoot = membership && fs.existsSync('/sys/fs/cgroup' + membership) ? '/sys/fs/cgroup' + membership : '/sys/fs/cgroup';
  let samples = 0, stopped = false;
  const sample = () => {
    const started = performance.now();
    const rows = [];
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const stat = read(`/proc/${name}/stat`);
      if (typeof stat === 'string') rows.push(parseStat(stat));
    }
    const processes = descendants(rows, parent).map((row) => {
      const status = read(`/proc/${row.pid}/status`);
      return { ...row, rssKiB: typeof status === 'string' ? Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) : null, io: read(`/proc/${row.pid}/io`), collector: row.pid === process.pid };
    });
    const space = fs.statfsSync(root);
    save(output, { kind: 'resources', collectorPid: process.pid, parentPid: parent, monotonicMs: performance.now(), cpu: read('/proc/stat'), memory: read('/proc/meminfo'), load: read('/proc/loadavg'), pressure: Object.fromEntries(['cpu', 'memory', 'io'].map((name) => [name, read(`/proc/pressure/${name}`)])), cgroupRoot, cgroup: Object.fromEntries(['cpu.stat', 'cpu.max', 'memory.current', 'memory.max', 'memory.events'].map((name) => [name, read(`${cgroupRoot}/${name}`)])), freeBytes: space.bavail * space.bsize, processes, collectionMs: performance.now() - started });
    samples++;
  };
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    sample();
    save(output, { kind: 'resource-collector-complete', samples });
    process.exit(0);
  };
  sample();
  save(output, { kind: 'resource-collector-ready' });
  const timer = setInterval(sample, 1000);
  process.on('SIGTERM', finish);
  process.on('SIGINT', finish);
} else if (process.env.GEA_BATCH_OVERLAP_SCOPE) {
  const scope = JSON.parse(fs.readFileSync(process.env.GEA_BATCH_OVERLAP_SCOPE, 'utf8'));
  const file = relative(process.cwd(), process.argv[1] ?? '').replaceAll('\\', '/');
  if (scope.files.includes(file)) {
    const output = process.env.GEA_BATCH_OVERLAP_STARTS;
    save(output, { kind: 'module-wait-entered', file, pid: process.pid });
    const offset = scope.delayFromFirstTargetPreparationMs[file];
    if (offset !== undefined) {
      let first;
      const until = performance.now() + 15000;
      while (!first && performance.now() < until) {
        const receipt = read(process.env.GEA_TEST_LIFECYCLE_RECEIPT);
        if (typeof receipt === 'string') first = receipt.split('\n').filter(Boolean).map(JSON.parse).find((row) => row.testName === scope.targetFirstCase && row.event === 'temporary-directory-created');
        if (!first) await delay(50);
      }
      assert.ok(first, 'TARGET_PREPARATION_START_MISSING');
      const deadline = Date.parse(first.timestamp) + offset;
      await delay(Math.max(0, deadline - Date.now()));
      save(output, { kind: 'module-delay-complete', file, pid: process.pid, targetPreparationAt: first.timestamp, expectedOffsetMs: offset, observedOffsetMs: Date.now() - Date.parse(first.timestamp) });
    }
    save(output, { kind: 'test-module-released', file, pid: process.pid });
  }
}

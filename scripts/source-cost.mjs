import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

const context = new AsyncLocalStorage();

function tick(root, now) {
  const key = [...root.active.keys()].sort().join("+") || "other";
  root.coverageMs[key] = (root.coverageMs[key] ?? 0) + now - root.last;
  root.last = now;
}

function metric(metrics, name) {
  return (metrics[name] ??= {
    calls: 0,
    totalMs: 0,
    unionMs: 0,
    peak: 0,
    active: 0,
    bytes: 0,
    failed: 0,
  });
}

function begin(name) {
  const scope = context.getStore();
  if (!scope) return;
  const { root } = scope,
    now = performance.now(),
    category = name.split(".")[0];
  tick(root, now);
  root.active.set(category, (root.active.get(category) ?? 0) + 1);
  const targets = [metric(root.metrics, name), metric(scope.metrics, name)];
  for (const target of targets) {
    target.calls++;
    if (target.active++ === 0) target.started = now;
    target.peak = Math.max(target.peak, target.active);
  }
  return (value, failed) => {
    const end = performance.now();
    tick(root, end);
    const remaining = root.active.get(category) - 1;
    if (remaining) root.active.set(category, remaining);
    else root.active.delete(category);
    const bytes =
      name === "read" && !failed
        ? typeof value === "string"
          ? Buffer.byteLength(value)
          : (value?.byteLength ?? 0)
        : 0;
    for (const target of targets) {
      target.totalMs += end - now;
      target.bytes += bytes;
      if (name === "read" && !failed) {
        const bucket =
          bytes < 4096
            ? "under4KiB"
            : bytes < 65536
              ? "under64KiB"
              : bytes < 1048576
                ? "under1MiB"
                : "atLeast1MiB";
        target.sizeBuckets ??= {};
        target.sizeBuckets[bucket] = (target.sizeBuckets[bucket] ?? 0) + 1;
      }
      target.failed += Number(failed);
      if (--target.active === 0) target.unionMs += end - target.started;
    }
  };
}

export function sourceCostSync(name, run) {
  const finish = begin(name);
  if (!finish) return run();
  try {
    const result = run();
    finish(result, false);
    return result;
  } catch (error) {
    finish(undefined, true);
    throw error;
  }
}

export async function sourceCostAsync(name, run) {
  const finish = begin(name);
  if (!finish) return run();
  try {
    const result = await run();
    finish(result, false);
    return result;
  } catch (error) {
    finish(undefined, true);
    throw error;
  }
}

export function sourceCostCount(name, value) {
  const scope = context.getStore();
  if (scope) scope.counts[name] = (scope.counts[name] ?? 0) + value;
}

export function sourceCostQueue(pending) {
  if (!context.getStore()) return;
  sourceCostCount("queuedFiles", pending.length);
  sourceCostCount("uniqueTargets", new Set(pending.map((entry) => entry[1])).size);
}

export async function sourceCostScope(operation, directory, run) {
  const receipt = process.env.GEA_SOURCE_COST_RECEIPT;
  if (!receipt) return run();
  const parent = context.getStore(),
    start = performance.now();
  const root = parent?.root ?? {
    startedAt: new Date().toISOString(),
    start,
    last: start,
    active: new Map(),
    coverageMs: {},
    metrics: {},
    scopes: [],
  };
  const scope = {
    root,
    id: root.scopes.length,
    parent: parent?.id ?? null,
    operation,
    directory,
    startedMs: start - root.start,
    metrics: {},
    counts: {},
  };
  root.scopes.push(scope);
  return context.run(scope, async () => {
    let status = "failed";
    try {
      const result = await run();
      status = "passed";
      return result;
    } finally {
      const end = performance.now();
      scope.durationMs = end - start;
      scope.status = status;
      if (!parent) {
        tick(root, end);
        const scopes = root.scopes.map(({ root: _root, ...value }) => value);
        try {
          appendFileSync(
            receipt,
            JSON.stringify({
              event: "source-cost",
              pid: process.pid,
              operation,
              directory,
              startedAt: root.startedAt,
              status,
              durationMs: end - start,
              metrics: root.metrics,
              coverageMs: root.coverageMs,
              scopes,
            }) + "\n",
          );
        } catch (error) {
          if (status === "passed") throw error;
        }
      }
    }
  });
}

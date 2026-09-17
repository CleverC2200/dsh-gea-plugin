import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRuns, defaultLogDir, tasks } from "./dev-observe.mjs";

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const hex = (value) =>
  typeof value === "string" && /^[a-f0-9]{16,64}$/.test(value)
    ? value
    : "unknown";
const version = (value) =>
  typeof value === "string" && /^(?:v|pnpm@)\d+\.\d+\.\d+$/.test(value)
    ? value
    : "unknown";
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n
    ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2
    : null;
};

export async function report(logDir = defaultLogDir) {
  const runs = await readRuns(logDir);
  const groups = new Map();
  const failures = [];
  const spaceTrend = [];
  const observations = [];
  let incomplete = 0;
  for (const { start, end } of runs) {
    if (start.project !== "gea" || !Object.hasOwn(tasks, start.task)) continue;
    const source = [
      "terminal",
      "codex-action",
      "benchmark",
      "unknown",
    ].includes(start.source)
      ? start.source
      : "unknown";
    const condition = [
      "unknown",
      "warm-store-empty-layout",
      "existing-layout",
      "cold-cache-isolated",
    ].includes(start.condition)
      ? start.condition
      : "unknown";
    const locks = Object.entries(start.locks ?? {})
      .filter(([k]) =>
        [
          "package.json",
          "pnpm-lock.yaml",
          "npm-shrinkwrap.json",
          "pnpm-workspace.yaml",
        ].includes(k),
      )
      .map(([k, v]) => [k, hex(v)]);
    const key = JSON.stringify([
      start.task,
      version(start.nodeVersion),
      version(start.packageManagerDeclaration),
      version(end?.packageManagerActual),
      hex(start.head),
      hex(start.sourceStatusDigest),
      locks,
      condition,
    ]);
    if (!groups.has(key))
      groups.set(key, {
        project: "gea",
        task: start.task,
        nodeVersion: version(start.nodeVersion),
        packageManagerDeclaration: version(start.packageManagerDeclaration),
        packageManagerActual: version(end?.packageManagerActual),
        head: hex(start.head),
        sourceStatusDigest: hex(start.sourceStatusDigest),
        condition,
        samples: 0,
        completed: 0,
        failures: 0,
        cancelled: 0,
        durations: [],
        overhead: [],
        sources: new Set(),
        inputCoverage: "partial; same group does not prove identical inputs",
      });
    const group = groups.get(key);
    group.samples++;
    group.sources.add(source);
    if (!end) {
      incomplete++;
      continue;
    }
    observations.push({
      runId: start.runId,
      parentRunId: /^[a-f0-9-]{36}$/.test(start.parentRunId ?? "")
        ? start.parentRunId
        : null,
      worktreeId: hex(start.worktreeId),
      task: start.task,
      source,
      collectorVersion: version(`v${start.collectorVersion}`),
      policyVersion: version(`v${start.policyVersion}`),
      skillVersion: version(`v${start.skillVersion}`),
      durationMs: finite(end.durationMs),
      preparationMs: finite(end.measurementPreparationMs),
      finalizationBeforeWriteMs: finite(
        end.measurementFinalizationBeforeWriteMs,
      ),
      reported: {
        resolved: finite(end.reported?.resolved),
        reused: finite(end.reported?.reused),
        downloaded: finite(end.reported?.downloaded),
        added: finite(end.reported?.added),
        cacheHit: null,
      },
      metricBasis:
        end.reported?.provenance ===
        "pnpm-progress-final-observed; not build-cache-hit"
          ? "pnpm-progress-final-observed; not build-cache-hit"
          : "unknown",
    });
    group.completed++;
    const elapsed = finite(end.durationMs);
    if (elapsed !== null) group.durations.push(elapsed);
    const overhead = finite(end.measurementPreparationMs);
    if (overhead !== null) group.overhead.push(overhead);
    if (end.cancelled === true) group.cancelled++;
    if (end.exitCode !== 0 || end.signal !== null) {
      group.failures++;
      failures.push({
        runId: start.runId,
        task: start.task,
        exitCode: Number.isInteger(end.exitCode) ? end.exitCode : null,
        cancelled: end.cancelled === true,
        parentRunId: /^[a-f0-9-]{36}$/.test(start.parentRunId ?? "")
          ? start.parentRunId
          : null,
      });
    }
    if (end.space)
      spaceTrend.push({
        at: /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(end.at ?? "") ? end.at : null,
        task: start.task,
        availableBytes: finite(end.space.availableBytes),
        nodeModulesAllocatedBytes: finite(
          end.space.directoryAllocatedBytes?.node_modules,
        ),
        attribution:
          "unknown; filesystem-wide changes are not per-command savings",
      });
  }
  return {
    schemaVersion: 1,
    coverage:
      "Only explicit GEA observe entrypoints; direct commands and uninstrumented child commands are unknown",
    incomplete,
    groups: [...groups.values()].map(
      ({ durations, overhead, sources, ...g }) => ({
        ...g,
        sources: [...sources],
        medianMs: median(durations),
        minMs: durations.length ? Math.min(...durations) : null,
        maxMs: durations.length ? Math.max(...durations) : null,
        medianPreparationMs: median(overhead),
        repeatCandidate: g.samples > 1,
        retryCandidate: g.samples > 1 && g.failures > 0,
        cacheHit:
          "unknown unless explicitly reported; short duration is not proof",
      }),
    ),
    failures,
    spaceTrend,
    observations,
    uncertainty: [
      "No full input hashing; untracked content and environment values excluded",
      "Repeat/retry flags are candidates, not proof of avoidable work",
      "APFS du and df are different measurements",
      "Preparation/finalization fields exclude Node startup, final write and final retention; not total overhead",
      "Malformed/foreign records excluded; absence is not evidence of no work",
      "No automatic changes, cleanup, uploads or rule learning",
    ],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  console.log(JSON.stringify(await report(), null, 2));

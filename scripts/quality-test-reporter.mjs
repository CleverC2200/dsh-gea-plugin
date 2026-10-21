/**
 * Keep spec and required-skip policy while showing actual file execution order.
 * Node 24: https://nodejs.org/docs/latest-v24.x/api/test.html#event-testdequeue
 * File starts/completions use execution events, never buffered test:start/pass.
 * Heartbeats run every 5s. Explicit CLI files supply the initial total; discovery
 * stays unknown until the stream ends. File completion does not mean success.
 */
import { once } from "node:events";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spec } from "node:test/reporters";
import { inspect } from "node:util";
import { executionFile, writeExecutionReceipt } from "./quality-test-execution.mjs";

export default async function* report(source) {
  let skipped = 0;
  const started = performance.now();
  const files = new Map();
  const observed = new Map();
  let summary;
  const root = process.env.QUALITY_TEST_ROOT ?? process.cwd();
  const args = process.argv.slice(1);
  const expected = process.env.QUALITY_TEST_FILES
    ? JSON.parse(process.env.QUALITY_TEST_FILES)
    : null;
  const matchingInvocation = () => {
    if (!expected) return true;
    try {
      return (
        JSON.stringify(args.map((file) => executionFile(root, file)).sort()) ===
        JSON.stringify([...expected].sort())
      );
    } catch {
      return false;
    }
  };
  // Test fixtures can start their own reporters. Only this invocation owns the machine receipt.
  const receipt = matchingInvocation() ? process.env.QUALITY_TEST_RECEIPT : undefined;
  const record = receipt
    ? {
        schemaVersion: 1,
        context: JSON.parse(process.env.QUALITY_TEST_CONTEXT ?? "null"),
        status: "running",
        terminal: false,
        startedAt: new Date().toISOString(),
      }
    : undefined;
  const persist = () => {
    if (receipt) writeExecutionReceipt(receipt, { ...record, files: [...observed.values()] });
  };
  const observation = (entry) => {
    const file = executionFile(root, entry);
    if (!observed.has(file))
      observed.set(file, { file, startCount: 0, completeCount: 0, summaryCount: 0 });
    return observed.get(file);
  };
  persist();
  const running = [];
  const output = new PassThrough();
  // Node consumes its flags before constructing reporter argv. Only an explicit
  // list of real files gives a denominator; discovery and globs stay unknown.
  const total =
    args.length &&
    args.every((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
      ? new Set(args.map((file) => resolve(file))).size
      : undefined;
  const elapsed = () => Math.round(performance.now() - started);
  const progress = (message) => output.write(`[quality-progress] ${message}\n`);
  const counts = (finished = false) =>
    `files=${[...files.values()].filter((file) => file.complete).length}/${total ?? (finished ? files.size : "?")}`;
  const current = () => {
    const activeFiles = [...files].filter(([, file]) => !file.complete).map(([file]) => file);
    const cases = running.slice(-3).map((item) => `${item.entry} :: ${item.name}`);
    return [...activeFiles, ...cases].join("; ") || "none";
  };
  // Fixed cadence bounds log volume; unref prevents this observer holding Node open.
  const timer = setInterval(() => {
    if (!output.writableNeedDrain)
      progress(`heartbeat ${counts()} elapsed=${elapsed()}ms running=${current()}`);
  }, 5000);
  timer.unref();
  const checked = (async function* () {
    for await (const event of source) {
      const data = event.data;
      // The wrapper name preserves the CLI path, while file/entryFile is absolute.
      // Normalize paths before matching its 1:1 process source location.
      const entry = data.entryFile ?? data.file;
      const wrapper =
        entry &&
        data.nesting === 0 &&
        typeof data.name === "string" &&
        resolve(data.name) === resolve(entry) &&
        data.line === 1 &&
        data.column === 1;
      if (wrapper && event.type === "test:dequeue") {
        if (receipt) {
          const file = observation(entry);
          file.startCount++;
          file.startedAt ??= new Date().toISOString();
          persist();
        }
        files.set(entry, { complete: false });
        progress(`file start ${entry} ${counts()} elapsed=${elapsed()}ms`);
      }
      if (wrapper && event.type === "test:complete") {
        if (receipt) {
          const file = observation(entry);
          file.completeCount++;
          file.finishedAt = new Date().toISOString();
          file.durationMs = data.details.duration_ms;
          file.passed = data.details.passed;
          persist();
        }
        const file = files.get(entry);
        if (file) {
          file.complete = true;
          progress(
            `file complete ${entry} ${counts()} duration=${Math.round(data.details.duration_ms)}ms result=${data.details.passed ? "passed" : "failed"} elapsed=${elapsed()}ms`,
          );
        }
      }
      if (receipt && event.type === "test:summary") {
        if (data.file) {
          const file = observation(data.file);
          file.summaryCount++;
          file.counts = data.counts;
          file.success = data.success;
          persist();
        } else summary = data;
      }
      if (!wrapper && (event.type === "test:dequeue" || event.type === "test:complete")) {
        // New Node 24 provides process-local testId. Earlier versions need a
        // multiset: concurrent cases may share every source coordinate and name.
        const key = JSON.stringify(
          data.testId === undefined
            ? [entry, data.file, data.line, data.column, data.nesting, data.name]
            : [entry, data.testId],
        );
        if (event.type === "test:dequeue") running.push({ key, entry, name: data.name });
        else {
          const index = running.findIndex((item) => item.key === key);
          if (index >= 0) running.splice(index, 1);
        }
      }
      if (event.type === "test:pass" && data.skip) skipped++;
      if (event.type === "test:fail") {
        if (receipt && entry) {
          const file = observation(entry);
          file.failures ??= [];
          file.failures.push({
            name: data.name,
            message: [data.details.error?.message, data.details.error?.stderr?.toString()]
              .filter(Boolean)
              .join("\n")
              .split("\n")
              .map((line) =>
                /token|secret|password|authorization|credential|bearer/i.test(line)
                  ? "[redacted sensitive test output]"
                  : line,
              )
              .join("\n")
              .slice(0, 8192),
          });
          persist();
        }
        yield {
          type: "test:diagnostic",
          data: {
            nesting: data.nesting,
            message: `Failure detail: ${data.name}\n${inspect(data.details.error, { depth: 8, colors: false })}`,
          },
        };
      }
      yield event;
    }
  })();
  const input = Readable.from(checked);
  const formatter = spec();
  const producing = pipeline(input, formatter, async (chunks, { signal }) => {
    for await (const chunk of chunks) {
      if (!output.write(chunk)) await once(output, "drain", { signal });
    }
  })
    .then(() => {
      clearInterval(timer);
      if (record) {
        Object.assign(record, {
          status: "completed",
          terminal: Boolean(summary),
          finishedAt: new Date().toISOString(),
          durationMs: elapsed(),
          summary,
        });
        persist();
      }
      progress(`summary ${counts(true)} elapsed=${elapsed()}ms running=${current()}`);
      output.end();
    })
    .catch((error) => output.destroy(error));
  try {
    yield* output;
    await producing;
    if (skipped) throw Error("QUALITY_REQUIRED_TEST_SKIPPED: " + skipped);
  } finally {
    clearInterval(timer);
    input.destroy();
    formatter.destroy();
    output.destroy();
  }
}

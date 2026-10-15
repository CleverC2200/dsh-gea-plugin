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

export default async function* report(source) {
  let skipped = 0;
  const started = performance.now();
  const files = new Map();
  const running = [];
  const output = new PassThrough();
  // Node consumes its flags before constructing reporter argv. Only an explicit
  // list of real files gives a denominator; discovery and globs stay unknown.
  const args = process.argv.slice(1);
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
      // The process wrapper has its entry path as name and source location 1:1.
      // This also works on early Node 24 versions without entryFile metadata.
      const entry = data.entryFile ?? data.file;
      const wrapper =
        entry && data.nesting === 0 && data.name === entry && data.line === 1 && data.column === 1;
      if (wrapper && event.type === "test:dequeue") {
        files.set(entry, { complete: false });
        progress(`file start ${entry} ${counts()} elapsed=${elapsed()}ms`);
      }
      if (wrapper && event.type === "test:complete") {
        const file = files.get(entry);
        if (file) {
          file.complete = true;
          progress(
            `file complete ${entry} ${counts()} duration=${Math.round(data.details.duration_ms)}ms result=${data.details.passed ? "passed" : "failed"} elapsed=${elapsed()}ms`,
          );
        }
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
      if (event.type === "test:fail")
        yield {
          type: "test:diagnostic",
          data: {
            nesting: data.nesting,
            message: `Failure detail: ${data.name}\n${inspect(data.details.error, { depth: 8, colors: false })}`,
          },
        };
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

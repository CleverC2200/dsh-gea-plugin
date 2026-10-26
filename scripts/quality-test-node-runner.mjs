import { run } from "node:test";
import * as reporters from "node:test/reporters";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [name, concurrency, nodeArgs, ...files] = process.argv.slice(2);
const report = Object.hasOwn(reporters, name)
  ? reporters[name]
  : (await import(pathToFileURL(resolve(name)).href)).default;
process.argv = [process.execPath, ...files];
const controller = new AbortController();
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
])
  process.once(signal, () => {
    process.exitCode = code;
    controller.abort();
  });
const source = run({
  files,
  concurrency: Number(concurrency),
  execArgv: JSON.parse(nodeArgs),
  isolation: "process",
  signal: controller.signal,
});
source.on("test:fail", () => {
  process.exitCode ||= 1;
});
source.compose(report).pipe(process.stdout);

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const original = (await import(pathToFileURL(resolve("scripts/quality-test-reporter.mjs")))).default;
export default function report(source) {
  async function* observed() {
    for await (const event of source) {
      if (event.type === "test:complete")
        appendFileSync(process.env.CROSSOVER_EVENTS,
          JSON.stringify({ timestamp: new Date().toISOString(), type: event.type, data: event.data }) + "\n");
      yield event;
    }
  }
  return original(observed());
}

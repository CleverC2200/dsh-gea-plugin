/** Keep ordinary test output while refusing an omitted required fixture lane. */
import { Readable } from "node:stream";
import { spec } from "node:test/reporters";
import { inspect } from "node:util";
export default async function* report(source) {
  let skipped = 0;
  const checked = (async function* () {
    for await (const event of source) {
      if (event.type === "test:pass" && event.data.skip) skipped++;
      if (event.type === "test:fail")
        yield {
          type: "test:diagnostic",
          data: {
            nesting: event.data.nesting,
            message: `Failure detail: ${event.data.name}\n${inspect(event.data.details.error, { depth: 8, colors: false })}`,
          },
        };
      yield event;
    }
  })();
  yield* Readable.from(checked).pipe(spec());
  if (skipped) throw Error("QUALITY_REQUIRED_TEST_SKIPPED: " + skipped);
}

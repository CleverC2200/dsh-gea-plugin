/** Keep ordinary test output while refusing an omitted required fixture lane. */
import { Readable } from "node:stream";
import { spec } from "node:test/reporters";
export default async function* report(source) {
  let skipped = 0;
  const checked = (async function* () {
    for await (const event of source) {
      if (event.type === "test:pass" && event.data.skip) skipped++;
      yield event;
    }
  })();
  yield* Readable.from(checked).pipe(spec());
  if (skipped) throw Error("QUALITY_REQUIRED_TEST_SKIPPED: " + skipped);
}

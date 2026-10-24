import { appendFileSync } from "node:fs";

/** Keep the browser owned by the Node test that launches it. */
export async function testBrowser(t, launch) {
  t.signal.throwIfAborted();
  let browser;
  t.after(async () => {
    await browser?.close();
  });
  const record = (event) => {
    if (process.env.GEA_TEST_LIFECYCLE_RECEIPT)
      appendFileSync(process.env.GEA_TEST_LIFECYCLE_RECEIPT,
        JSON.stringify({ timestamp: new Date().toISOString(), testName: t.name, event }) + "\n");
  };
  record("browser-launch-started");
  browser = await launch();
  record("browser-launch-ready");
  if (t.signal.aborted) {
    await browser.close();
    t.signal.throwIfAborted();
  }
  return browser;
}

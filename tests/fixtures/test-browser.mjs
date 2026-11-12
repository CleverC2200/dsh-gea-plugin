export async function testBrowser(t, launch) {
  t.signal.throwIfAborted();
  let browser;
  t.after(async () => {
    await browser?.close();
  });
  browser = await launch();
  if (t.signal.aborted) {
    await browser.close();
    t.signal.throwIfAborted();
  }
  return browser;
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const fixture = new URL("./fixtures/test-browser.mjs", import.meta.url).href;

test("a browser acquired after the Node test timeout is closed and the failed file exits", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import test from 'node:test';
       import { testBrowser } from ${JSON.stringify(fixture)};
       test('delayed browser acquisition', { timeout: 30 }, async t => {
         await testBrowser(t, async () => {
           const handle = setInterval(() => {}, 1000);
           await new Promise(resolve => setTimeout(resolve, 100));
           return { close: async () => { clearInterval(handle); console.log('owned-browser-closed'); } };
         });
         console.log('late-test-body-continued');
       });`,
    ],
    { encoding: "utf8", timeout: 2000 },
  );
  assert.equal(child.signal, null, "the failed test file must exit without the parent killing it");
  assert.equal(child.status, 1, "the original timeout must remain a failure");
  assert.match(child.stdout, /owned-browser-closed/);
  assert.doesNotMatch(child.stdout, /late-test-body-continued/);
});

test("a browser acquired before timeout is closed on normal test completion", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import test from 'node:test';
       import { testBrowser } from ${JSON.stringify(fixture)};
       test('normal browser acquisition', async t => {
         await testBrowser(t, async () => {
           const handle = setInterval(() => {}, 1000);
           return { close: async () => { clearInterval(handle); console.log('owned-browser-closed'); } };
         });
         console.log('normal-test-body-continued');
       });`,
    ],
    { encoding: "utf8", timeout: 2000 },
  );
  assert.equal(child.signal, null);
  assert.equal(child.status, 0);
  assert.match(child.stdout, /owned-browser-closed/);
  assert.match(child.stdout, /normal-test-body-continued/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { openSalesPlanPresentation } from "./fixtures/sales-plan-presentation.mjs";

test(
  "simultaneous presentation Contexts keep data and storage private",
  { timeout: 30000 },
  async (t) => {
    const first = await openSalesPlanPresentation(t, [
      { currentAmount: "777", targetAmount: "1000" },
    ]);
    await first.evaluate(() => {
      localStorage.setItem("private-marker", "secret");
      sessionStorage.setItem("private-marker", "secret");
      window.privateMarker = "secret";
    });
    await first
      .context()
      .addCookies([{ name: "private-marker", value: "secret", url: first.url() }]);
    const second = await openSalesPlanPresentation(t, [
      { currentAmount: "888", targetAmount: "1000" },
    ]);
    assert.deepEqual(
      await second.evaluate(() => [
        localStorage.getItem("private-marker"),
        sessionStorage.getItem("private-marker"),
        window.privateMarker ?? null,
      ]),
      [null, null, null],
    );
    assert.equal(
      (await second.context().cookies()).some((cookie) => cookie.name === "private-marker"),
      false,
    );
    assert.equal(await first.evaluate(() => window.fixturePlans[0].currentAmount), "777");
    assert.equal(await second.evaluate(() => window.fixturePlans[0].currentAmount), "888");
    await first
      .context()
      .route("**/private-route", (route) => route.fulfill({ body: "private-route" }));
    assert.equal(
      await first.evaluate(() => fetch("/private-route").then((r) => r.text())),
      "private-route",
    );
    assert.notEqual(
      await second.evaluate(() => fetch("/private-route").then((r) => r.text())),
      "private-route",
    );
    const held = Promise.withResolvers();
    const started = Promise.withResolvers();
    t.after(() => held.resolve());
    await first.context().route("**/held-request", async (route) => {
      started.resolve();
      await held.promise;
      await route.abort().catch(() => {});
    });
    const pending = first
      .evaluate(() => fetch("/held-request"))
      .then(
        () => false,
        () => true,
      );
    await started.promise;
    await first.context().close();
    assert.equal(await pending, true);
    held.resolve();
    assert.equal(await second.evaluate(() => window.fixturePlans[0].currentAmount), "888");
  },
);

for (const prior of ["failed", "cancelled", "browser-closed"])
  test(`presentation Context remains private after a ${prior} scene`, { timeout: 30000 }, () => {
    const fixture = new URL("./fixtures/sales-plan-presentation.mjs", import.meta.url).href;
    const source = `
import test from 'node:test';
import assert from 'node:assert/strict';
import {openSalesPlanPresentation} from ${JSON.stringify(fixture)};
const controller=new AbortController();
test('prior scene', {signal:controller.signal}, async t => {
  const page=await openSalesPlanPresentation(t,[{currentQty:'10',currentAmount:'777',targetQty:'10',targetAmount:'1000'}]);
  await page.evaluate(()=>{localStorage.setItem('private-marker','secret');sessionStorage.setItem('private-marker','secret');window.privateMarker='secret'});
  await page.context().addCookies([{name:'private-marker',value:'secret',url:page.url()}]);
  if(${JSON.stringify(prior)}==='browser-closed')await page.context().browser().close();
  if(${JSON.stringify(prior)}==='cancelled')controller.abort(Error('EXPECTED_SCENE_CANCELLED'));
  if(${JSON.stringify(prior)}==='failed')throw Error('EXPECTED_SCENE_FAILURE');
});
test('next scene', async t => {
  const page=await openSalesPlanPresentation(t,[{currentQty:'10',currentAmount:'888',targetQty:'10',targetAmount:'1000'}]);
  assert.deepEqual(await page.evaluate(()=>[localStorage.getItem('private-marker'),sessionStorage.getItem('private-marker'),window.privateMarker??null]),[null,null,null]);
  assert.equal((await page.context().cookies()).some(c=>c.name==='private-marker'),false);
  assert.ok((await page.locator('body').innerText()).includes('888'));
  console.log('CONTEXT_ISOLATION_CONFIRMED');
});`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 25000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(
      child.status,
      ["failed", "cancelled"].includes(prior) ? 1 : 0,
      child.stdout + child.stderr,
    );
    assert.match(child.stdout, /CONTEXT_ISOLATION_CONFIRMED/);
    if (prior === "failed") assert.match(child.stdout, /EXPECTED_SCENE_FAILURE/);
  });

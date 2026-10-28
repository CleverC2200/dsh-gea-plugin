import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

for (const prior of ["passed", "failed", "cancelled", "browser-closed"])
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

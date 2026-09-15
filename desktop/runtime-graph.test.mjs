import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {profile} from '../tests/profile.mjs';
import {readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';

test('the desktop boots its selected external graph without requiring login or the GEA network', {timeout:60000}, async t=>{
  const graph=process.env.GEA_DESKTOP_TEST_GRAPH;
  assert.ok(graph,'Provide GEA_DESKTOP_TEST_GRAPH with a prepared graph');
  const app=await profile(t,{desktopGraph:resolve(graph)});
  const manifest=JSON.parse(await readFile(join(app.runtime,'home/profiles/full/package.json'),'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('@cleverc2200/gea-dsh-prototype'));
  assert.equal(await realpath(join(app.runtime,'home/profiles/full/node_modules')),await realpath(join(graph,'node_modules')));
  assert.equal((await app.rpc('status')).value.authenticated,false);
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();
  await context.addCookies(app.cookie.split('; ').map(c=>({name:c.slice(0,c.indexOf('=')),value:c.slice(c.indexOf('=')+1),url:app.origin})));
  const page=await context.newPage();
  await page.goto(app.origin);
  await page.frameLocator('iframe[data-gea-workbench]').getByRole('button',{name:'刷新二维码',exact:true}).waitFor();
  assert.equal((await app.login()).ok,true);
});

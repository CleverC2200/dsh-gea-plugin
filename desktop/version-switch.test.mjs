import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {profile} from '../tests/profile.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

test('restarting with a prepared company plugin changes the rendered version and preserves user settings', {timeout:90000}, async t=>{
  assert.ok(process.env.GEA_DESKTOP_BASELINE && process.env.GEA_DESKTOP_NEXT);
  const options={desktopGraph:resolve(process.env.GEA_DESKTOP_BASELINE)};
  const app=await profile(t,options);
  const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:960}});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  async function openVersion(version){
    await context.addCookies(app.cookie.split('; ').map(c=>({name:c.slice(0,c.indexOf('=')),value:c.slice(c.indexOf('=')+1),url:app.origin})));
    await page.goto(app.origin);
    await page.getByRole("button", {name:"账户菜单",exact:true}).click();
    await page.getByRole("menuitem", {name:"设置",exact:true}).click();
    await page.getByRole('button',{name:'插件市场',exact:true}).click().catch(async error=>{console.error(await page.locator('body').innerText());throw error;});
    await expect(page.getByText('v'+version,{exact:true})).toBeVisible();
  }
  await openVersion('1.4.3-company.1');
  await writeFile(join(app.runtime,'workspace','keep.txt'),'user workspace');
  const settingsPath=join(app.runtime,'home/settings.yaml');
  const before=await readFile(settingsPath,'utf8');
  await app.stop();options.desktopGraph=resolve(process.env.GEA_DESKTOP_NEXT);await app.start();
  await openVersion('1.4.3-company.2');
  assert.equal(await readFile(join(app.runtime,'workspace','keep.txt'),'utf8'),'user workspace');
  assert.equal(await readFile(settingsPath,'utf8'),before);
});

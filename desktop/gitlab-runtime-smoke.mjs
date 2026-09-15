/** Boot the real prepared graph and verify the rendered Hub version in a browser. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {profile} from '../tests/profile.mjs';
const {chromium,expect}=await import(process.env.GEA_PLAYWRIGHT_MODULE??'@playwright/test');
const receipt=resolve(process.argv[2]);const result=JSON.parse(await readFile(receipt,'utf8'));
const cleanup=[];let browser;
try {
 const app=await profile({after:callback=>cleanup.push(callback)},{desktopGraph:result.selection.path,env:{DSH_DESKTOP_BASELINE:process.env.GEA_GITLAB_BASELINE}});
 assert.equal((await app.rpc('status')).ok,true);
 browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});
 await context.addCookies(app.cookie.split('; ').map(c=>({name:c.slice(0,c.indexOf('=')),value:c.slice(c.indexOf('=')+1),url:app.origin})));
 const page=await context.newPage();page.setDefaultTimeout(20000);await page.goto(app.origin);
 await page.getByRole('button',{name:'账户菜单',exact:true}).click();
 await page.getByRole('menuitem',{name:'设置',exact:true}).click();
 await page.screenshot({path:join(result.data,'settings-before.png')});
 await page.getByRole('button',{name:/^(插件市场|插件中心|软件更新)$/}).first().click();
 await expect(page.getByRole('heading',{name:'软件更新',exact:true})).toBeVisible();
 const runtime=await page.evaluate(()=>fetch('/dsh-plugin-hub/installed').then(r=>r.json()));
 assert.ok(runtime.loaded.includes('dsh-plugin'));
 result.loadedPlugins=runtime.loaded;
 const evidence=join(result.data,'runtime.png');await page.screenshot({path:evidence});
 result.runtimeStarted=true;result.renderedHub=result.after['dsh-plugin'];result.screenshot=evidence;
 await writeFile(receipt,JSON.stringify(result,null,2));
 console.log('RUNTIME_RENDER_PASS',result.renderedHub,evidence);
}finally{await browser?.close();for(const close of cleanup.reverse())await close();}

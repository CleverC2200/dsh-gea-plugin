import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from '@playwright/test';
const [root,entry,expectedVersion]=process.argv.slice(2);
assert.ok(['card','settings'].includes(entry));
const {cdp}=JSON.parse(await readFile(join(root,'process.json')));
const browser=await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`,{timeout:10000});
const page=browser.contexts()[0].pages().find(p=>p.url().startsWith('dsh-app://app/'));
assert.ok(page,'Opened packaged desktop renderer required');
const oldVersion=await page.evaluate(()=>window.dshDesktop?.appVersion());
assert.ok(oldVersion && oldVersion!==expectedVersion);
const login=page.locator('.gea-account-login-backdrop');
const closeLogin=login.getByRole('button',{name:'关闭',exact:true});
await closeLogin.waitFor({timeout:25000}).catch(()=>{});
if(await closeLogin.isVisible())await closeLogin.click({timeout:5000});
await page.addLocatorHandler(login.filter({has:page.getByRole('button',{name:'关闭',exact:true})}),async()=>{
  await closeLogin.click({timeout:5000});
});
const settings=page.getByRole('dialog').filter({hasText:'通用设置'});
if(await settings.isVisible()) await settings.getByRole('button',{name:'关闭',exact:true}).click();
const account=page.getByRole('button',{name:'账户菜单',exact:true});
async function chooseAccountAction(name){
  const menuitem=page.getByRole('menuitem',{name,exact:true});
  for(let attempt=0;attempt<3;attempt++){
    if(await account.getAttribute('aria-expanded')!=='true')await account.click({timeout:6000});
    try{await menuitem.click({timeout:6000});return;}
    catch(error){if(attempt===2||error.name!=='TimeoutError')throw error;}
  }
}
await chooseAccountAction('检查更新');
const card=page.getByRole('article',{name:'版本更新',exact:true});
await card.getByRole('button',{name:'是',exact:true}).click();
const buttonName={name:'更新全部',exact:true};
await card.getByRole('button',buttonName).click({trial:true,timeout:85000});
assert.equal(await card.getByRole('button',buttonName).count(),1);
const initial=await page.evaluate(async()=>{
  const [desktop,status]=await Promise.all([window.dshDesktop.updates.status(),fetch('/api/gea/plugin-updates/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pageIdentity:crypto.randomUUID()})}).then(response=>response.json())]);
  return {desktop,items:status.value?.items?.map(({packageName,state,installedVersion,runningHostVersion,runningClientVersion,candidateVersion,diagnostic})=>({packageName,state,installedVersion,runningHostVersion,runningClientVersion,candidateVersion,diagnostic}))};
});
assert.equal(initial.desktop.version,expectedVersion);
assert.ok(['available','ready'].includes(initial.desktop.phase));
assert.ok(initial.items?.some(row=>row.state==='available'),'A real plugin plan must be available');
assert.ok(initial.items.every(row=>['available','current'].includes(row.state)));
const expectedPlugins=initial.items.filter(row=>row.state==='available').map(({packageName,installedVersion,candidateVersion})=>({packageName,installedVersion,candidateVersion}));
let target=card;
if(entry==='settings'){
  await chooseAccountAction('设置');
  await settings.waitFor({timeout:10000});
  await settings.getByRole('button',{name:'通用设置',exact:true}).click();
  target=settings.locator('[data-slot="settings.general.item"]');
}
const button=target.getByRole('button',buttonName);
await button.waitFor({timeout:8000});
assert.equal(await button.count(),1);
assert.equal(await button.isDisabled(),false);
await page.screenshot({path:join(root,`before-${entry}.png`)});
await writeFile(join(root,`before-${entry}.json`),JSON.stringify({entry,oldVersion,expectedVersion,expectedPlugins,initial},null,2),{flag:'wx',mode:0o600});
await button.click();
await writeFile(join(root,`clicked-${entry}.json`),JSON.stringify({entry,clicks:1,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
process.exit(0);

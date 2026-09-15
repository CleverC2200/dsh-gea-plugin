import test from 'node:test';import assert from 'node:assert/strict';import {_electron as electron,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {profile,readSession} from '../tests/profile.mjs';
test('the market downloads a private release, prepares once, restarts via Electron, and preserves login, session and workspace', {timeout:240000},async t=>{
 assert.ok(process.env.GEA_RELEASE_TOKEN);const fixture=await profile(t,{config:{workbenchExample:true}});await fixture.stop();
 const data=await mkdtemp(join(tmpdir(),'gea-market-update-'));await mkdir(join(data,'plugins'),{recursive:true});await writeFile(join(data,'gea.config.json'),await readFile(join(fixture.dir,'gea.json')));
 await writeFile(join(data,'plugins/update-state.json'),JSON.stringify({settings:{automatic:false,intervalHours:24,channel:'stable'}}));
 const app=await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env:{...process.env,NODE_EXTRA_CA_CERTS:join(fixture.dir,'cert.pem'),DSH_GEA_DESKTOP_DATA:data,GEA_DESKTOP_PAYLOAD:resolve(process.env.GEA_DESKTOP_PAYLOAD)}});
 t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const status=()=>page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())).catch(()=>null);
 await expect.poll(status,{timeout:40000}).toMatchObject({ok:true,value:{authenticated:true}});
 await page.getByRole('button',{name:'示例 Agent',exact:true}).click();await expect(page.locator('[data-example-session]')).toContainText('session-');
 const session=await page.locator('[data-example-session]').textContent();
 await page.locator('[contenteditable="true"]').fill('market-upgrade-history');await page.locator('[contenteditable="true"]').press('Enter');await page.getByText('market-upgrade-history',{exact:true}).first().waitFor();
 await writeFile(join(data,'data/workspace/keep.txt'),'existing workspace');const login=await readFile(join(data,'login.encrypted'));
 async function market(){await page.getByRole('button',{name:'账户菜单',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'插件市场',exact:true}).click();await page.locator('[data-desktop-updates]').waitFor();}
 await market();const panel=page.locator('[data-desktop-updates]');await panel.getByRole('button',{name:'检查更新',exact:true}).click();
 await expect(panel).toContainText('0.0.2 → 0.0.3',{timeout:30000});
 await panel.getByRole('button',{name:'准备更新',exact:true}).first().click();await expect(panel).toContainText('准备完成，等待重启',{timeout:150000});
 assert.equal((await status()).value.authenticated,true);const old=page.url();
 await panel.getByRole('button',{name:'重启并应用（会停止当前任务）',exact:true}).click();await expect.poll(()=>page.url(),{timeout:30000}).not.toBe(old);
 await expect.poll(status,{timeout:30000}).toMatchObject({ok:true,value:{authenticated:true}});await market();
 await expect(panel).toContainText('更新成功',{timeout:30000});await expect(panel).toContainText('0.0.3 → 0.0.3');
 assert.deepEqual(await readFile(join(data,'login.encrypted')),login);assert.equal(await readFile(join(data,'data/workspace/keep.txt'),'utf8'),'existing workspace');
 assert.ok(JSON.stringify(await readSession(join(data,'data'),session)).includes('market-upgrade-history'));
 await mkdir('.runtime/verification',{recursive:true});await page.screenshot({path:'.runtime/verification/market-update-success.png'});
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(820,900));await page.screenshot({path:'.runtime/verification/market-update-narrow.png'});
});

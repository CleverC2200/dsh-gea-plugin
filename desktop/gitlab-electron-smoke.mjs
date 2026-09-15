/** Real packaged Electron UI: discover GitLab update, download, install, restart, verify. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {_electron as electron,expect} from '@playwright/test';
import {PluginStore} from './plugin-store.mjs';
import {profile} from '../tests/profile.mjs';
const baseline=resolve(process.env.GEA_GITLAB_BASELINE);
const executable=resolve(process.env.GEA_GITLAB_ELECTRON);
const cleanup=[];let app;
const data=await mkdtemp(join(tmpdir(),'gea-gitlab-electron-'));
try {
 const fixture=await profile({after:callback=>cleanup.push(callback)},{desktopGraph:baseline,env:{DSH_DESKTOP_BASELINE:baseline}});await fixture.stop();
 const store=new PluginStore({data,baseline});
 await store.prepare({id:'previous-install',install:async()=>{}});await store.activate('previous-install');
 await mkdir(join(data,'data/workspace'),{recursive:true});await writeFile(join(data,'data/workspace/keep.txt'),'existing workspace');
 await writeFile(join(data,'gea.config.json'),await readFile(join(fixture.dir,'gea.json')));
 await writeFile(join(data,'plugins/update-state.json'),JSON.stringify({settings:{automatic:false,intervalHours:24,channel:'stable'}}));
 const env={...process.env,DSH_GEA_DESKTOP_DATA:data,NODE_EXTRA_CA_CERTS:join(fixture.dir,'cert.pem')};delete env.GEA_RELEASE_TOKEN;
 app=await electron.launch({executablePath:executable,args:[],env,timeout:45000});
 let stderr='';app.process().stderr?.on('data',chunk=>{stderr+=chunk.toString();});app.process().once('exit',code=>{if(code)console.log('ELECTRON_EXIT',code,stderr.slice(-1500).replace(/https?:\/\/\S+/g,'[URL]'));});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);
 const status=()=>page.evaluate(()=>fetch('/dsh-plugin-hub/desktop-updates').then(r=>r.json())).catch(()=>null);
 await expect.poll(status,{timeout:60000}).toMatchObject({desktop:true,current:{'dsh-plugin':'1.4.3-company.4'}});
 // The local QR fixture confirms a synthetic account; no production login is used.
 await page.screenshot({path:join(data,'00-login.png')});
 let qrFrame;await expect.poll(async()=>{for(const frame of page.frames()){if(await frame.getByRole('button',{name:'刷新二维码',exact:true}).count()){qrFrame=frame;return true;}}return false;}).toBe(true);
 await qrFrame.getByRole('button',{name:'刷新二维码',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())),{timeout:30000}).toMatchObject({ok:true,value:{authenticated:true}});
 const savedLogin=await readFile(join(data,'login.encrypted'));
 async function openUpdates(){await page.getByRole('button',{name:'账户菜单',exact:true}).click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('button',{name:/^(插件市场|公司插件|软件更新)$/}).first().click();await page.locator('[data-desktop-updates]').waitFor();}
 console.log('MOCK_LOGIN_READY');await openUpdates();console.log('UPDATES_PAGE_READY');const panel=page.locator('[data-desktop-updates]');
 await panel.getByRole('button',{name:'检查更新',exact:true}).click();
 await expect.poll(status).toMatchObject({checkError:null,releases:expect.arrayContaining([expect.objectContaining({package:'dsh-plugin',version:'1.4.3-company.7'})])});
 await panel.getByRole('button',{name:'查看更新',exact:true}).click();
 console.log('GITLAB_UPDATE_FOUND');await page.screenshot({path:join(data,'01-update-found.png')});
 await panel.getByRole('button',{name:'下载更新',exact:true}).click();
 await expect.poll(status,{timeout:300000}).toMatchObject({phase:'pending',current:{'dsh-plugin':'1.4.3-company.4'}});
 console.log('GITLAB_UPDATE_PREPARED');await page.screenshot({path:join(data,'02-update-ready.png')});
 await panel.getByRole('button',{name:'重启并应用（会停止当前任务）',exact:true}).click();
 await expect.poll(status,{timeout:60000}).toMatchObject({phase:'succeeded',current:{'dsh-plugin':'1.4.3-company.7'}});
 await openUpdates();await panel.getByRole('button',{name:'检查更新',exact:true}).click();
 await expect(panel).toContainText('已是最新版本');await page.screenshot({path:join(data,'03-updated.png')});
 assert.equal(await readFile(join(data,'data/workspace/keep.txt'),'utf8'),'existing workspace');
 assert.deepEqual(await readFile(join(data,'login.encrypted')),savedLogin);
 const state=await status();assert.ok(state.releases.every(entry=>entry.url.startsWith('http://100.100.6.191:20656/')));
 await writeFile(join(data,'result.json'),JSON.stringify({data,executable,from:'1.4.3-company.4',to:state.current['dsh-plugin'],phase:state.phase,gitlabOnly:true,noToken:true,workspacePreserved:true,mockLoginPreserved:true},null,2));
 console.log('ELECTRON_GITLAB_UPDATE_PASS '+data);
}finally{await app?.close();for(const close of cleanup.reverse())await close();}

import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron,expect} from '@playwright/test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('Electron restores the baseline when the selected backend cannot start, then confirms local health while logged out', {timeout:90000},async t=>{
  assert.ok(process.env.GEA_ELECTRON_EXECUTABLE && process.env.GEA_DESKTOP_PAYLOAD);
  const data=await mkdtemp(join(tmpdir(),'gea-electron-recovery-'));
  const broken=join(data,'plugins/versions/broken');await mkdir(broken,{recursive:true});
  await writeFile(join(broken,'version.json'),JSON.stringify({id:'broken',state:'prepared'}));
  await writeFile(join(data,'plugins/selection.json'),JSON.stringify({active:'broken',previous:'baseline',verified:'baseline'}));
  await writeFile(join(data,'gea.config.json'),await readFile('gea.config.example.json'));
  const app=await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env:{...process.env,DSH_GEA_DESKTOP_DATA:data,GEA_DESKTOP_PAYLOAD:resolve(process.env.GEA_DESKTOP_PAYLOAD)}});
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});await app.firstWindow();
  await app.evaluate(({dialog})=>{dialog.showMessageBox=async()=>({response:0,checkboxChecked:false});dialog.showErrorBox=()=>{};});
  await expect.poll(async()=>JSON.parse(await readFile(join(data,'plugins/selection.json'),'utf8')),{timeout:60000}).toMatchObject({active:'baseline',booting:null,verified:'baseline'});
  const page=await app.firstWindow();
  const status=await page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()));
  assert.equal(status.ok,true);assert.equal(status.value.authenticated,false);
});

test('Electron encrypted identity survives restart and is removed by explicit logout', {timeout:90000},async t=>{
  const data=await mkdtemp(join(tmpdir(),'gea-electron-login-'));
  await writeFile(join(data,'gea.config.json'),await readFile('gea.config.example.json'));
  const app=await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env:{...process.env,DSH_GEA_DESKTOP_DATA:data,GEA_DESKTOP_PAYLOAD:resolve(process.env.GEA_DESKTOP_PAYLOAD)}});
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});await app.firstWindow();
  await expect.poll(async()=>JSON.parse(await readFile(join(data,'plugins/selection.json'),'utf8')),{timeout:30000}).toMatchObject({booting:null,verified:'baseline'});
  const config=JSON.parse(await readFile('gea.config.example.json','utf8'));
  const secret='fixture-encrypted-only-token';
  const snapshot={schema:1,environment:'production',base:config.geaBaseUrl,auth:{token:secret,tenantId:'0',name:'Tester',id:'1',username:'tester'}};
  const encrypted=await app.evaluate(({safeStorage},saved)=>{if(!safeStorage.isEncryptionAvailable())throw Error('Encryption unavailable');return Array.from(safeStorage.encryptString(JSON.stringify(saved)));},snapshot);
  await writeFile(join(data,'login.encrypted'),Buffer.from(encrypted));
  assert.ok(!(await readFile(join(data,'login.encrypted'))).includes(Buffer.from(secret)));
  await writeFile(join(data,'gea.config.json'),JSON.stringify(config));
  const restart=()=>app.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='重新启动工作台').click());
  await restart();
  const page=await app.firstWindow();
  const status=()=>page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json())).catch(()=>null);
  await expect.poll(status,{timeout:30000}).toMatchObject({ok:true,value:{authenticated:true}});
  await expect.poll(async()=>JSON.parse(await readFile(join(data,'plugins/selection.json'),'utf8')),{timeout:30000}).toMatchObject({booting:null});
  const before=page.url();await restart();await expect.poll(()=>page.url(),{timeout:30000}).not.toBe(before);
  await expect.poll(status,{timeout:30000}).toMatchObject({ok:true,value:{authenticated:true}});
  await expect.poll(async()=>JSON.parse(await readFile(join(data,'plugins/selection.json'),'utf8')),{timeout:30000}).toMatchObject({booting:null});
  const logout=await page.evaluate(()=>fetch('/api/gea-proof/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()));
  assert.equal(logout.ok,true);
  await assert.rejects(readFile(join(data,'login.encrypted')),{code:'ENOENT'});
  const after=page.url();await restart();await expect.poll(()=>page.url(),{timeout:30000}).not.toBe(after);
  await expect.poll(status,{timeout:30000}).toMatchObject({ok:true,value:{authenticated:false}});
});

test('a fresh Electron installation opens the workbench without a connection or model form', {timeout:60000},async t=>{
  const data=await mkdtemp(join(tmpdir(),'gea-electron-first-'));
  const app=await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env:{...process.env,DSH_GEA_DESKTOP_DATA:data,GEA_DESKTOP_PAYLOAD:resolve(process.env.GEA_DESKTOP_PAYLOAD)}});
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});const page=await app.firstWindow();
  await expect.poll(()=>page.url(),{timeout:30000}).toMatch(/^http:\/\/127\.0\.0\.1:/);
  await expect.poll(async()=>JSON.parse(await readFile(join(data,'plugins/selection.json'),'utf8')),{timeout:30000}).toMatchObject({booting:null,verified:'baseline'});
  await expect(page.locator('input[name="production"],input[name="test"],input[name="model"],#setup')).toHaveCount(0);
  const labels=await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.flatMap(item=>item.submenu?.items.map(i=>i.label)??[]));assert.ok(!labels.includes('连接设置'));
  const config=JSON.parse(await readFile(join(data,'gea.config.json'),'utf8'));assert.equal(config.analysis.model,'2085162185715609601');
  const status=await page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()));assert.equal(status.value.authenticated,false);
  await mkdir('.runtime/verification',{recursive:true});await page.screenshot({path:'.runtime/verification/desktop-first-launch.png'});
});

test('a hung new-version health request times out and automatically restores the verified baseline', {timeout:60000},async t=>{
  const {symlink}=await import('node:fs/promises');
  const data=await mkdtemp(join(tmpdir(),'gea-electron-health-'));
  await writeFile(join(data,'gea.config.json'),await readFile('gea.config.example.json'));
  const app=await electron.launch({executablePath:resolve(process.env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env:{...process.env,DSH_GEA_DESKTOP_DATA:data,GEA_DESKTOP_PAYLOAD:resolve(process.env.GEA_DESKTOP_PAYLOAD)}});
  t.after(async()=>{await app.close();await rm(data,{recursive:true,force:true});});const page=await app.firstWindow();
  const state=async()=>JSON.parse(await readFile(join(data,'plugins/selection.json'),'utf8'));
  await expect.poll(state,{timeout:30000}).toMatchObject({booting:null,verified:'baseline'});
  const next=join(data,'plugins/versions/health-timeout');await mkdir(next,{recursive:true});
  const baseline=resolve(process.env.GEA_DESKTOP_PAYLOAD);
  await symlink(join(baseline,'node_modules'),join(next,'node_modules'),'dir');await writeFile(join(next,'package.json'),await readFile(join(baseline,'package.json')));
  await writeFile(join(next,'version.json'),JSON.stringify({id:'health-timeout',state:'prepared'}));
  await writeFile(join(data,'plugins/selection.json'),JSON.stringify({active:'health-timeout',previous:'baseline',verified:'baseline'}));
  let hung=false;
  await page.route('**/api/gea-proof/status',route=>{if(!hung&&route.request().headers()['x-gea-desktop-health']==='1'){hung=true;return;}return route.continue();});
  await app.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='重新启动工作台').click());
  await expect.poll(async()=>await readFile(join(data,'desktop.log'),'utf8'),{timeout:40000}).toContain('自动恢复上一版本');
  await expect.poll(state,{timeout:15000}).toMatchObject({active:'baseline',booting:null,verified:'baseline'});
});

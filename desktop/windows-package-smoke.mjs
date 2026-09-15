/** Runs only against installers in an isolated Windows CI user profile. */
import {chromium,expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const executablePath=process.env.GEA_SMOKE_EXECUTABLE,kind=process.env.GEA_SMOKE_KIND,report=process.env.GEA_SMOKE_REPORT,repo=process.env.GEA_SMOKE_REPO;
assert.equal(process.platform,'win32');assert.ok(executablePath&&kind&&report&&repo);
const data=join(report,kind+'-user');await mkdir(data,{recursive:true});
const sources=JSON.parse(await readFile(join(repo,'desktop/release-sources.json'),'utf8'));
let gitlabReachable=false;
try {const response=await fetch(sources.stable,{signal:AbortSignal.timeout(8000)});gitlabReachable=response.ok&&(await response.json()).schema===1;}
catch(error){await writeFile(join(report,'gitlab-network-error.txt'),error.name+': '+error.message);}
await writeFile(join(report,'gitlab-network.json'),JSON.stringify({url:sources.stable,reachable:gitlabReachable}));
if(!gitlabReachable){await mkdir(join(data,'plugins'),{recursive:true});await writeFile(join(data,'plugins/update-state.json'),JSON.stringify({settings:{automatic:false,intervalHours:24,channel:'stable'}}));}
/** Connect to this test-owned Electron main process to drive its existing native menu. */
async function inspector(endpoint){
 const socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let sequence=0;const pending=new Map();
 socket.addEventListener('message',event=>{const result=JSON.parse(event.data);if(!result.id)return;const task=pending.get(result.id);if(!task)return;pending.delete(result.id);clearTimeout(task.timer);result.error||result.result?.exceptionDetails?task.reject(Error(JSON.stringify(result.error??result.result.exceptionDetails))):task.resolve(result.result);});
 return {evaluate:expression=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Main inspector evaluation timeout'));},30000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));}),close:()=>socket.close()};
}
// Older installers required the same connection form before reaching their login page.
if(kind==='baseline')await writeFile(join(data,'gea.config.json'),await readFile(join(repo,'desktop/company.config.json')));
const records=[];
async function launch(update=false){
 console.log(JSON.stringify({kind,stage:'launch',run:records.length+1,update}));
 const env={...process.env,DSH_GEA_DESKTOP_DATA:data};delete env.GEA_RELEASE_TOKEN;
 const started=performance.now();
 const child=spawn(executablePath,['--remote-debugging-port=0','--inspect=0'],{env,stdio:['ignore','pipe','pipe']});
 let output='',browser,main;
 const exited=new Promise(resolve=>child.once('exit',resolve));
 try{
 const endpoint=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Browser debugging endpoint did not appear')),60000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('exit',code=>{clearTimeout(timer);reject(Error('Desktop exited before ready: '+code));});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
 });
  browser=await chromium.connectOverCDP(endpoint,{timeout:60000});
  const context=browser.contexts()[0];const page=context.pages()[0]??await context.waitForEvent('page');
  const windowMs=performance.now()-started;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  console.log(JSON.stringify({kind,stage:'window',windowMs:Math.round(windowMs)}));
  await expect.poll(()=>page.url(),{timeout:120000}).toMatch(/^http:\/\/127\.0\.0\.1:/);
  await expect.poll(()=>page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json','X-GEA-Desktop-Health':'1'},body:'{}'}).then(r=>r.json())).catch(()=>null),{timeout:30000}).toMatchObject({ok:true});
  const readyMs=performance.now()-started;
  console.log(JSON.stringify({kind,stage:'ready',readyMs:Math.round(readyMs)}));
  const action=(action,value={})=>page.evaluate(({action,value})=>fetch('/dsh-plugin-hub/desktop-updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})}).then(r=>r.json()),{action,value});
  const status=()=>page.evaluate(()=>fetch('/dsh-plugin-hub/desktop-updates').then(r=>r.json())).catch(()=>null);
  if(kind==='current'){
   const overview=await page.evaluate(()=>fetch('/api/agent-plugins/overview').then(r=>r.json()));
   assert.equal(overview.suites.length,2);assert.equal(overview.sources[0].id,'company-agent-suites');
   assert.equal(overview.sources[0].kind,'archive');assert.equal(overview.sources[0].cloned,true);
   const refresh=await page.evaluate(()=>fetch('/api/agent-plugins/sources/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"id":"company-agent-suites"}'}).then(r=>r.json()));assert.equal(refresh.ok,true,JSON.stringify(refresh));
   const checked=gitlabReachable?await action('check'):await status();
   if(gitlabReachable){assert.equal(checked.checkError,null);assert.equal(checked.releases.length,4);assert.ok(checked.releases.every(release=>release.url.startsWith('http://100.100.6.191:20656/')));}
   if(update){
    assert.equal(checked.current['@cleverc2200/gea-dsh-prototype'],'0.0.7');
    const config=await readFile(join(data,'gea.config.json'));await writeFile(join(data,'data/workspace/keep.txt'),'business data');
    if(gitlabReachable){
     assert.deepEqual(await action('prepare',{package:'@cleverc2200/gea-dsh-prototype'}),{accepted:true});
     await expect.poll(status,{timeout:300000,intervals:[1000,2000]}).toMatchObject({phase:'pending'});
     assert.equal((await action('restart')).ok,true);
     await expect.poll(status,{timeout:120000,intervals:[500,1000]}).toMatchObject({phase:'succeeded',current:{'@cleverc2200/gea-dsh-prototype':'0.0.8'}});
    }else{
     const endpoint=output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1];assert.ok(endpoint);
     main=await inspector(endpoint);const existing=new Set(await readdir(join(data,'plugins/versions')));
     await main.evaluate(`{const e=process.mainModule.require('electron');e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(process.env.GEA_CURRENT_PLUGIN)}]});e.dialog.showMessageBox=async()=>({response:0});e.Menu.getApplicationMenu().items.find(item=>item.label==='插件版本').submenu.items[0].click();}`);
     let prepared;
     await expect.poll(async()=>{for(const id of await readdir(join(data,'plugins/versions'))){if(existing.has(id))continue;const receipt=JSON.parse(await readFile(join(data,'plugins/versions',id,'version.json'),'utf8'));if(receipt.state==='prepared'){prepared=id;return receipt.versions['@cleverc2200/gea-dsh-prototype'];}}return null;},{timeout:300000,intervals:[1000,2000]}).toBe('0.0.8');
     await main.evaluate(`{const e=process.mainModule.require('electron');e.dialog.showMessageBox=async(_window,options)=>({response:options.buttons?.indexOf(${JSON.stringify(prepared)})??0});e.Menu.getApplicationMenu().items.find(item=>item.label==='插件版本').submenu.items[1].click();}`);
     await expect.poll(status,{timeout:120000,intervals:[500,1000]}).toMatchObject({current:{'@cleverc2200/gea-dsh-prototype':'0.0.8'}});
    }
    assert.deepEqual(await readFile(join(data,'gea.config.json')),config);assert.equal(await readFile(join(data,'data/workspace/keep.txt'),'utf8'),'business data');
   }
   assert.deepEqual(errors,[]);
  }
  records.push({run:records.length+1,update,updateTransport:gitlabReachable?'live-gitlab':'local-verified-archive',windowMs:Math.round(windowMs),readyMs:Math.round(readyMs),totalMs:Math.round(performance.now()-started),errors});
 }finally{
  console.log(JSON.stringify({kind,stage:'closing'}));
  let timer;
  try {
   main?.close();
   if(browser){const session=await browser.newBrowserCDPSession();await session.send('Browser.close').catch(()=>{});}else child.kill();
   await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill();reject(Error('Desktop close exceeded 30 seconds'));},30000);})]);
  }
  finally {clearTimeout(timer);}
 }
 await writeFile(join(report,kind+'.json'),JSON.stringify({kind,installMs:Number(process.env.GEA_INSTALL_MS),records},null,2));
}
try{
 await launch();await launch();
 if(kind==='current'){
  const {PluginStore}=await import(pathToFileURL(join(repo,'desktop/plugin-store.mjs')));
  const {installArtifact}=await import(pathToFileURL(join(repo,'desktop/installer.mjs')));
  const baseline=join(dirname(executablePath),'resources/payload'),store=new PluginStore({data,baseline});
  await store.prepare({id:'previous-0.0.7',install:(directory,{registerProcess})=>installArtifact({directory,optimizedBaseline:baseline,artifact:process.env.GEA_PREVIOUS_PLUGIN,node:join(baseline,'node/node.exe'),pnpm:join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProcess:registerProcess,onProgress:line=>console.log(line)})});
  await store.activate('previous-0.0.7');await launch(true);
 }
 console.log(JSON.stringify({kind,records}));
}catch(error){
 let log='';try{log=(await readFile(join(data,'desktop.log'),'utf8')).slice(-6000);}catch(readError){if(readError.code!=='ENOENT')throw readError;}
 await writeFile(join(report,kind+'-error.txt'),(String(error.stack)+'\n'+log).replace(/https?:\/\/\S+/g,'[URL]'));throw error;
}

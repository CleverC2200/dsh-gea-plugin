/** Runs only against installers in an isolated Windows CI user profile. */
import {_electron as electron,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const executablePath=process.env.GEA_SMOKE_EXECUTABLE,kind=process.env.GEA_SMOKE_KIND,report=process.env.GEA_SMOKE_REPORT,repo=process.env.GEA_SMOKE_REPO;
assert.equal(process.platform,'win32');assert.ok(executablePath&&kind&&report&&repo);
const data=join(report,kind+'-user');await mkdir(data,{recursive:true});
// Older installers required the same connection form before reaching their login page.
if(kind==='baseline')await writeFile(join(data,'gea.config.json'),await readFile(join(repo,'desktop/company.config.json')));
const records=[];
async function launch(update=false){
 const env={...process.env,DSH_GEA_DESKTOP_DATA:data};delete env.GEA_RELEASE_TOKEN;
 const started=performance.now();const app=await electron.launch({executablePath,env,args:[],timeout:60000});
 try{
  const page=await app.firstWindow();const windowMs=performance.now()-started;const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await expect.poll(()=>page.url(),{timeout:120000}).toMatch(/^http:\/\/127\.0\.0\.1:/);
  await expect.poll(()=>page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json','X-GEA-Desktop-Health':'1'},body:'{}'}).then(r=>r.json())).catch(()=>null),{timeout:30000}).toMatchObject({ok:true});
  const readyMs=performance.now()-started;
  const action=(action,value={})=>page.evaluate(({action,value})=>fetch('/dsh-plugin-hub/desktop-updates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,value})}).then(r=>r.json()),{action,value});
  const status=()=>page.evaluate(()=>fetch('/dsh-plugin-hub/desktop-updates').then(r=>r.json())).catch(()=>null);
  if(kind==='current'){
   const overview=await page.evaluate(()=>fetch('/api/agent-plugins/overview').then(r=>r.json()));
   assert.equal(overview.suites.length,2);assert.equal(overview.sources[0].id,'company-agent-suites');
   assert.equal(overview.sources[0].kind,'archive');assert.equal(overview.sources[0].cloned,true);
   const refresh=await page.evaluate(()=>fetch('/api/agent-plugins/sources/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"id":"company-agent-suites"}'}).then(r=>r.json()));assert.equal(refresh.ok,true);
   const checked=await action('check');assert.equal(checked.checkError,null);assert.equal(checked.releases.length,4);
   if(update){
    assert.equal(checked.current['@cleverc2200/gea-dsh-prototype'],'0.0.7');
    const config=await readFile(join(data,'gea.config.json'));await writeFile(join(data,'data/workspace/keep.txt'),'business data');
    assert.deepEqual(await action('prepare',{package:'@cleverc2200/gea-dsh-prototype'}),{accepted:true});
    await expect.poll(status,{timeout:300000,intervals:[1000,2000]}).toMatchObject({phase:'pending'});
    assert.equal((await action('restart')).ok,true);
    await expect.poll(status,{timeout:120000,intervals:[500,1000]}).toMatchObject({phase:'succeeded',current:{'@cleverc2200/gea-dsh-prototype':'0.0.8'}});
    assert.deepEqual(await readFile(join(data,'gea.config.json')),config);assert.equal(await readFile(join(data,'data/workspace/keep.txt'),'utf8'),'business data');
   }
   assert.deepEqual(errors,[]);
  }
  records.push({run:records.length+1,update,windowMs:Math.round(windowMs),readyMs:Math.round(readyMs),totalMs:Math.round(performance.now()-started),errors});
 }finally{await app.close();}
 await writeFile(join(report,kind+'.json'),JSON.stringify({kind,installMs:Number(process.env.GEA_INSTALL_MS),records},null,2));
}
try{
 await launch();await launch();
 if(kind==='current'){
  const {PluginStore}=await import(pathToFileURL(join(repo,'desktop/plugin-store.mjs')));
  const {installArtifact}=await import(pathToFileURL(join(repo,'desktop/installer.mjs')));
  const baseline=join(dirname(executablePath),'resources/payload'),store=new PluginStore({data,baseline});
  await store.prepare({id:'previous-0.0.7',install:(directory,{registerProcess})=>installArtifact({directory,artifact:process.env.GEA_PREVIOUS_PLUGIN,node:join(baseline,'node/node.exe'),pnpm:join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProcess:registerProcess})});
  await store.activate('previous-0.0.7');await launch(true);
 }
 console.log(JSON.stringify({kind,records}));
}catch(error){await writeFile(join(report,kind+'-error.txt'),String(error.stack).replace(/https?:\/\/\S+/g,'[URL]'));throw error;}

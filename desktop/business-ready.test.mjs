/** Real Electron smoke against the exact distribution payload; external sync is explicitly enabled. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {_electron as electron,expect} from '@playwright/test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('business first launch needs no repository input and preserves the company catalog on restart',{timeout:120000},async t=>{
 assert.ok(process.env.GEA_DESKTOP_PAYLOAD);assert.ok(process.env.GEA_ELECTRON_EXECUTABLE);
 const data=await mkdtemp(join(tmpdir(),'gea-business-ready-'));t.after(()=>rm(data,{recursive:true,force:true}));
 for(let run=0;run<2;run++){
  const env={...process.env,DSH_GEA_DESKTOP_DATA:data};delete env.GEA_RELEASE_TOKEN;
  const app=await electron.launch({executablePath:resolve(env.GEA_ELECTRON_EXECUTABLE),args:[resolve('desktop')],env});
  try{
   const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await expect.poll(()=>page.url(),{timeout:60000}).toMatch(/^http:\/\/127\.0\.0\.1:/);
   await expect.poll(()=>page.evaluate(()=>fetch('/api/gea-proof/status',{method:'POST',headers:{'Content-Type':'application/json','X-GEA-Desktop-Health':'1'},body:'{}'}).then(r=>r.json())),{timeout:30000}).toMatchObject({ok:true});
   const overview=await page.evaluate(()=>fetch('/api/agent-plugins/overview').then(r=>r.json()));
   assert.ok(overview.sources.some(s=>s.id==='company-agent-suites'&&s.kind==='archive'&&s.cloned));
   assert.deepEqual(overview.suites.map(s=>s.suiteId).sort(),['business-analysis-starter','sinian-demand-forecast']);
   if(process.env.GEA_LIVE_SYNC==='1'){
    const result=await page.evaluate(()=>fetch('/api/agent-plugins/sources/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"id":"company-agent-suites"}'}).then(r=>r.json()));
    assert.equal(result.ok,true);
    const updates=await page.evaluate(()=>fetch('/dsh-plugin-hub/desktop-updates',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"check"}'}).then(r=>r.json()));
    assert.equal(updates.checkError,null);assert.equal(updates.releases.length,4);
   }
   assert.equal(JSON.parse(await readFile(join(data,'gea.config.json'),'utf8')).environment,'production');
   assert.deepEqual(errors,[]);
  }finally{await app.close();}
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginStore} from './plugin-store.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'gea-recovery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const baseline=join(root,'baseline');await mkdir(baseline);await writeFile(join(baseline,'package.json'),'{}');
 return {root,store:new PluginStore({data:join(root,'user'),baseline})};
}
test('a failed new backend returns to the verified graph without changing user data',async t=>{
 const {root,store}=await fixture(t);await mkdir(join(root,'user','data'),{recursive:true});
 await writeFile(join(root,'user','data','session'),'existing conversation');
 await store.prepare({id:'new',install:async()=>{}});await store.activate('new');
 await store.beginBoot();await store.failBoot('BACKEND_START_FAILED');
 assert.equal((await store.selected()).id,'baseline');
 assert.equal(await readFile(join(root,'user','data','session'),'utf8'),'existing conversation');
});

test('interrupted version switching recovers, while a confirmed logged-out backend remains selected',async t=>{
 const {store}=await fixture(t);
 await store.prepare({id:'new',install:async()=>{}});await store.activate('new');await store.beginBoot();
 assert.equal((await store.beginBoot()).id,'baseline');
 await store.confirmBoot();await store.activate('new');await store.beginBoot();await store.confirmBoot();
 assert.equal((await store.beginBoot()).id,'new');
});

test('unsupported data migrations are rejected before the current version or user data changes',async t=>{
 const {store}=await fixture(t);
 await assert.rejects(store.prepare({id:'future',install:async directory=>writeFile(join(directory,'package.json'),JSON.stringify({desktopDataSchema:2}))}),/DATA_SCHEMA_UNSUPPORTED/);
 assert.equal((await store.selected()).id,'baseline');
});

test('a process killed while preparing can be recovered without touching the active graph',async t=>{
 const {root,store}=await fixture(t);
 const {spawn}=await import('node:child_process');const {once}=await import('node:events');
 const worker=spawn(process.execPath,['--input-type=module','-e',`
 import {PluginStore} from ${JSON.stringify(new URL('./plugin-store.mjs',import.meta.url).href)};
 const store=new PluginStore({data:${JSON.stringify(join(root,'user'))},baseline:${JSON.stringify(join(root,'baseline'))}});
 await store.prepare({id:'interrupted',install:async()=>{console.log('READY');await new Promise(()=>setInterval(()=>{},1000));}});
 `],{stdio:['ignore','pipe','pipe']});
 const closed=once(worker,'close');
 await once(worker.stdout,'data');worker.kill('SIGKILL');await closed;
 assert.equal(await store.recoverPreparation(),'recovered');
 assert.equal((await store.selected()).id,'baseline');
 await store.prepare({id:'retry',install:async()=>{}});
});

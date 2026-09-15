import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PluginStore} from './plugin-store.mjs';import {createUpdates} from './updates.mjs';
const until=async(fn,predicate)=>{for(let i=0;i<150;i++){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');};
async function fixture(t,overrides={},initialState){
 const data=await mkdtemp(join(tmpdir(),'gea-updates-'));t.after(()=>rm(data,{recursive:true,force:true}));const baseline=join(data,'baseline');
 const dependencies={'@deepseek-ai/dsh':'0.1.5-rc.2','@cleverc2200/dsh-agent-workbench':'0.1.1','dsh-plugin':'1.4.3-company.1'};
 for(const [name,version] of Object.entries(dependencies)){await mkdir(join(baseline,'node_modules',name),{recursive:true});await writeFile(join(baseline,'node_modules',name,'package.json'),JSON.stringify({name,version}));}
 await writeFile(join(baseline,'package.json'),JSON.stringify({dependencies}));
 if(initialState){await mkdir(join(data,'plugins'),{recursive:true});await writeFile(join(data,'plugins/update-state.json'),JSON.stringify(initialState));}
 const store=new PluginStore({data,baseline});const release={package:'dsh-plugin',version:'1.4.3-company.2',notes:{zh:'更新',en:'Update'}};
 let installs=0,restarts=0,checks=0;
 const updates=await createUpdates({data,store,desktopVersion:'0.0.2',sources:{stable:'stable',test:'test'},
  releases:{validateReleaseChannel:value=>value,fetchCompanyChannel:async(source)=>{checks++;return {releases:source==='stable'?[release]:[]}},verifyReleaseHistory:(_,history)=>history,fetchReleasePackage:async()=>new Uint8Array([1]),...overrides},
  install:async directory=>{installs++;await writeFile(join(directory,'node_modules/dsh-plugin/package.json'),JSON.stringify({name:'dsh-plugin',version:release.version}));},
  restart:async id=>{restarts++;await store.activate(id);await store.beginBoot();await store.confirmBoot();}});
 t.after(()=>updates.close());return {updates,store,counts:()=>({installs,restarts,checks})};
}
test('checks do not install; duplicate preparations reserve one graph and explicit restart verifies its actual version',async t=>{
 const {updates,store,counts}=await fixture(t);await updates.check();assert.equal(counts().installs,0);
 await Promise.all([updates.prepare({package:'dsh-plugin'}),updates.prepare({package:'dsh-plugin'})]);
 await until(updates.status,s=>s.phase==='pending');assert.equal(counts().installs,1);assert.equal((await store.selected()).id,'baseline');
 assert.deepEqual(await updates.prepare({package:'dsh-plugin'}),{error:'UPDATE_BUSY'});
 await updates.restart();assert.equal((await updates.status()).phase,'restarting');
 await until(updates.status,s=>s.phase==='succeeded');assert.equal(counts().restarts,1);assert.equal((await updates.status()).current['dsh-plugin'],'1.4.3-company.2');
});
test('download cancellation keeps the current graph; channel change clears prior offers and failed checks do not install',async t=>{
 let fail=false;
 const {updates,store,counts}=await fixture(t,{fetchCompanyChannel:async(source)=>{if(fail)throw Error('RELEASE_HTTP_404');return {releases:source==='stable'?[{package:'dsh-plugin',version:'1.4.3-company.2'}]:[]}},fetchReleasePackage:async(_release,{signal})=>new Promise((_,reject)=>{if(signal.aborted)reject(Error('ABORTED'));else signal.addEventListener('abort',()=>reject(Error('ABORTED')),{once:true});})});
 await updates.check();await updates.prepare({package:'dsh-plugin'});await until(updates.status,s=>s.phase==='downloading');await updates.cancel();
 await until(updates.status,s=>s.phase==='cancelled');assert.equal((await store.selected()).id,'baseline');assert.equal(counts().installs,0);
 await updates.settings({automatic:false,intervalHours:6,channel:'test'});assert.equal((await updates.status()).releases.length,0);await updates.check();assert.equal((await updates.status()).releases.length,0);
 fail=true;await updates.check();assert.equal((await updates.status()).checkError,'RELEASE_HTTP_404');assert.equal(counts().installs,0);
});
test('startup reconciles an interrupted restart and closing cancels an unstarted restart',async t=>{
 const restored=await fixture(t,{}, {phase:'restarting',pending:'missing',settings:{automatic:false,intervalHours:24,channel:'stable'}});
 await restored.updates.start();assert.equal((await restored.updates.status()).phase,'failed');await restored.updates.check();assert.equal(restored.counts().checks,1);
 const ready=await fixture(t);await ready.updates.check();await ready.updates.prepare({package:'dsh-plugin'});await until(ready.updates.status,s=>s.phase==='pending');await ready.updates.restart();await ready.updates.close();
 await new Promise(r=>setTimeout(r,150));assert.equal(ready.counts().restarts,0);assert.equal((await ready.store.selected()).id,'baseline');
});

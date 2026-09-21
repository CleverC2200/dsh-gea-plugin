import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PluginStore} from './plugin-store.mjs';import {createUpdates,nextCheckDelayMs} from './updates.mjs';
const until=async(fn,predicate)=>{for(let i=0;i<150;i++){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');};
async function fixture(t,overrides={},initialState,options={}){
 const data=await mkdtemp(join(tmpdir(),'gea-updates-'));const baseline=join(data,'baseline');
 const dependencies={'@deepseek-ai/dsh':'0.1.5-rc.2','@cleverc2200/dsh-agent-workbench':'0.1.1','dsh-plugin':'1.4.3-company.1'};
 for(const [name,version] of Object.entries(dependencies)){await mkdir(join(baseline,'node_modules',name),{recursive:true});await writeFile(join(baseline,'node_modules',name,'package.json'),JSON.stringify({name,version}));}
 await writeFile(join(baseline,'package.json'),JSON.stringify({dependencies}));
 if(initialState){await mkdir(join(data,'plugins'),{recursive:true});await writeFile(join(data,'plugins/update-state.json'),JSON.stringify(initialState));}
 const store=new PluginStore({data,baseline});const release={package:'dsh-plugin',version:'1.4.3-company.2',notes:{zh:'更新',en:'Update'}};
 let installs=0,restarts=0,checks=0,desktopChecks=0;
 const updates=await createUpdates({data,store,desktopVersion:'0.0.2',sources:{stable:'stable',test:'test'},checkDesktop:async()=>{desktopChecks++;},...options,
  releases:{validateReleaseChannel:value=>value,fetchCompanyChannel:async(source)=>{checks++;return {releases:source==='stable'?[release]:[]}},verifyReleaseHistory:(_,history)=>history,fetchReleasePackage:async()=>new Uint8Array([1]),...overrides},
  install:async directory=>{installs++;await writeFile(join(directory,'node_modules/dsh-plugin/package.json'),JSON.stringify({name:'dsh-plugin',version:release.version}));},
  restartRuntime:overrides.restartRuntime,
  restart:async id=>{restarts++;await store.activate(id);await store.beginBoot();await store.confirmBoot();}});
 t.after(async()=>{await updates.close();await rm(data,{recursive:true,force:true});});return {updates,store,data,desktopChecks:()=>desktopChecks,counts:()=>({installs,restarts,checks})};
}
test('checks do not install; duplicate preparations reserve one graph and explicit restart verifies its actual version',async t=>{
 const {updates,store,counts}=await fixture(t);await updates.check();assert.equal(counts().installs,0);
 await Promise.all([updates.prepare({package:'dsh-plugin'}),updates.prepare({package:'dsh-plugin'})]);
 const prepared=await until(updates.status,s=>s.phase==='pending');assert.ok(prepared.timings.downloadMs>=0);assert.ok(prepared.timings.prepareMs>=0);assert.equal(counts().installs,1);assert.equal((await store.selected()).id,'baseline');
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
test('a check that cannot read the selected graph drops the stale release list instead of re-offering it',async t=>{
 const stale={package:'dsh-plugin',version:'1.4.3-company.1',notes:{zh:'旧版本',en:'Stale release'}};
 const {updates,data,counts}=await fixture(t,{}, {settings:{automatic:false,intervalHours:24,channel:'stable'},releases:[stale]});
 const manifest=JSON.parse(await readFile(join(data,'baseline/package.json'),'utf8'));
 manifest.dependencies['dsh-agent-plugins-market']='0.6.2'; // declared by an older graph, no longer on disk
 await writeFile(join(data,'baseline/package.json'),JSON.stringify(manifest));
 await updates.check().catch(()=>{});
 const failed=JSON.parse(await readFile(join(data,'plugins/update-state.json'),'utf8'));
 assert.deepEqual(failed.releases,[]);
 assert.equal(failed.checkError,'MODULE_NOT_FOUND');
 assert.ok(failed.lastCheck);
 await assert.rejects(updates.prepare({package:'dsh-plugin'}),/CHECK_RELEASE_FIRST/);
 assert.equal(counts().installs,0);
 delete manifest.dependencies['dsh-agent-plugins-market'];
 await writeFile(join(data,'baseline/package.json'),JSON.stringify(manifest));
 await updates.check();
 const recovered=await updates.status();
 assert.equal(recovered.checkError,null);
 assert.equal(recovered.releases.length,1);
});
test('a released list restored from disk is not offered until this run checks the channel',async t=>{
 const stale={package:'dsh-plugin',version:'1.4.3-company.1',notes:{zh:'旧版本',en:'Stale release'}};
 const {updates}=await fixture(t,{}, {settings:{automatic:false,intervalHours:24,channel:'stable'},releases:[stale]});
 const before=await updates.status();
 assert.deepEqual(before.releases,[]);
 await assert.rejects(updates.prepare({package:'dsh-plugin'}),/CHECK_RELEASE_FIRST/);
});
test('startup reconciles an interrupted restart and closing cancels an unstarted restart',async t=>{
 const restored=await fixture(t,{}, {phase:'restarting',pending:'missing',settings:{automatic:false,intervalHours:24,channel:'stable'}});
 await restored.updates.start();assert.equal((await restored.updates.status()).phase,'failed');await restored.updates.check();assert.equal(restored.counts().checks,1);
 const ready=await fixture(t);await ready.updates.check();await ready.updates.prepare({package:'dsh-plugin'});await until(ready.updates.status,s=>s.phase==='pending');await ready.updates.restart();await ready.updates.close();
 await new Promise(r=>setTimeout(r,150));assert.equal(ready.counts().restarts,0);assert.equal((await ready.store.selected()).id,'baseline');
});

async function batchFixture(t,{badDownload=false,badInstall=false}={}) {
  const offers=[{package:'dsh-plugin',version:'1.4.3-company.2'},{package:'@cleverc2200/dsh-agent-workbench',version:'0.1.2'}];
  const f=await fixture(t,{fetchCompanyChannel:async()=>({releases:offers})});
  await f.updates.close();
  let installs=0,restarts=0,downloads=0;
  const data=await mkdtemp(join(tmpdir(),'gea-batch-state-'));
  const updates=await createUpdates({data,store:f.store,desktopVersion:'0.0.9',sources:{stable:'stable'},
    releases:{validateReleaseChannel:value=>value,fetchCompanyChannel:async()=>({releases:offers}),verifyReleaseHistory:(_,history)=>history,
      fetchReleasePackage:async release=>{downloads++;if(badDownload&&downloads===2)throw Error('RELEASE_CHECKSUM_MISMATCH');return Buffer.from(JSON.stringify(release));}},
    install:async(directory,artifacts)=>{installs++;assert.equal(artifacts.length,2);for(const artifact of artifacts){const release=JSON.parse(await readFile(artifact,'utf8'));await writeFile(join(directory,'node_modules',release.package,'package.json'),JSON.stringify({name:release.package,version:release.version}));}if(badInstall)throw Error('PLUGIN_INSTALL_FAILED');},
    restart:async id=>{restarts++;await f.store.activate(id);await f.store.beginBoot();await f.store.confirmBoot();}});
  t.after(async()=>{await updates.close();await rm(data,{recursive:true,force:true});});return {...f,updates,data,counts:()=>({installs,restarts,downloads})};
}
test('batch prepares two plugins in one graph and applies both with one explicit restart',async t=>{
  const {updates,store,counts}=await batchFixture(t);await updates.check();assert.equal((await updates.status()).capabilities.batchPrepare,true);
  await Promise.all([updates.prepare({all:true}),updates.prepare({all:true})]);
  const ready=await until(updates.status,s=>s.phase==='pending');assert.equal(ready.targets.length,2);assert.equal(ready.progress.completed,2);
  assert.deepEqual(counts(),{installs:1,restarts:0,downloads:2});assert.equal((await store.selected()).id,'baseline');
  await updates.restart();const done=await until(updates.status,s=>s.phase==='succeeded');
  assert.equal(counts().restarts,1);assert.equal(done.current['dsh-plugin'],'1.4.3-company.2');assert.equal(done.current['@cleverc2200/dsh-agent-workbench'],'0.1.2');
  await updates.check();assert.deepEqual(await updates.prepare({all:true}),{error:'ALREADY_CURRENT'});
});
test('batch download or install failure keeps all current versions and offers no partial restart',async t=>{
 for(const options of [{badDownload:true},{badInstall:true}]){
  const {updates,store,data,counts}=await batchFixture(t,options);await updates.check();await updates.prepare({all:true});
  await until(updates.status,s=>s.phase==='failed');assert.equal((await store.selected()).id,'baseline');
  await assert.rejects(updates.restart(),/NO_PREPARED_UPDATE/);assert.equal(counts().restarts,0);
  assert.equal((await readdir(join(data,'plugins'))).filter(name=>name.endsWith('.tgz')).length,0);
 }
});

test('one click downloads all updates and automatically restarts exactly once',async t=>{
  const {updates,counts,store}=await batchFixture(t);
  await updates.check();
  assert.equal((await updates.status()).settings.intervalHours,1);
  assert.equal((await updates.status()).capabilities.prepareAndRestart,true);
  await Promise.all([updates.prepare({all:true,restart:true}),updates.prepare({all:true,restart:true})]);
  const done=await until(updates.status,s=>s.phase==='succeeded');
  assert.deepEqual(counts(),{installs:1,restarts:1,downloads:2});
  assert.equal(done.current['dsh-plugin'],'1.4.3-company.2');
  assert.equal(done.current['@cleverc2200/dsh-agent-workbench'],'0.1.2');
  assert.equal(done.updateHistory.length,1);
  assert.deepEqual(done.updateHistory[0].items,[
    {package:'dsh-plugin',fromVersion:'1.4.3-company.1',toVersion:'1.4.3-company.2'},
    {package:'@cleverc2200/dsh-agent-workbench',fromVersion:'0.1.1',toVersion:'0.1.2'},
  ]);
  assert.notEqual((await store.selected()).id,'baseline');
});
test('one-click failure never restarts or partially applies an update',async t=>{
  for(const options of [{badDownload:true},{badInstall:true}]){
    const {updates,counts,store}=await batchFixture(t,options);
    await updates.check();await updates.prepare({all:true,restart:true});
    await until(updates.status,s=>s.phase==='failed');
    assert.equal(counts().restarts,0);assert.equal((await store.selected()).id,'baseline');assert.deepEqual((await updates.status()).updateHistory,[]);
  }
});
test('one-click cancellation prevents automatic restart',async t=>{
  const {updates,counts}=await fixture(t,{fetchReleasePackage:async(_release,{signal})=>new Promise((_,reject)=>{
    if(signal.aborted)reject(Error('ABORTED'));else signal.addEventListener('abort',()=>reject(Error('ABORTED')),{once:true});
  })});
  await updates.check();await updates.prepare({all:true,restart:true});await updates.cancel();
  await until(updates.status,s=>s.phase==='cancelled');assert.equal(counts().restarts,0);
});
test('startup always checks once, even with legacy automatic checks disabled',async t=>{
  const {updates,counts,desktopChecks}=await fixture(t,{}, {settings:{automatic:false,intervalHours:24,channel:'stable'}});
  await updates.start();await until(updates.status,s=>!!s.lastCheck&&!s.checking);
  await updates.start();await until(updates.status,s=>!s.checking);assert.equal(counts().checks,1);assert.equal(desktopChecks(),1);assert.equal(counts().installs,0);
});
test('optional plugin toggle persists and restarts the runtime graph',async t=>{
  let runtimeRestarts=0;
  const f=await fixture(t,{restartRuntime:async()=>{runtimeRestarts++;}});
  const manifest=JSON.parse(await readFile(join(f.data,'baseline/package.json'),'utf8'));
  manifest.dependencies['@dsh-external/dsh-visualize']='0.1.2';
  await writeFile(join(f.data,'baseline/package.json'),JSON.stringify(manifest));
  await mkdir(join(f.data,'baseline/node_modules/@dsh-external/dsh-visualize'),{recursive:true});
  await writeFile(join(f.data,'baseline/node_modules/@dsh-external/dsh-visualize/package.json'),JSON.stringify({name:'@dsh-external/dsh-visualize',version:'0.1.2'}));
  assert.equal((await f.updates.status()).optional.plugins.find(p=>p.key==='@dsh-external/dsh-visualize').enabled,true);
  await f.updates.optionalToggle({name:'@dsh-external/dsh-visualize',enabled:false});
  assert.equal(runtimeRestarts,1);assert.equal((await f.updates.status()).optional.plugins.find(p=>p.key==='@dsh-external/dsh-visualize').enabled,false);
  const saved=JSON.parse(await readFile(join(f.data,'plugins/optional-state.json'),'utf8'));assert.equal(saved['@dsh-external/dsh-visualize'],false);
});
test('interval settings validate, persist and reschedule without installing',async t=>{
  const {updates,counts,data}=await fixture(t,{},undefined,{random:()=>0.5});
  for(const hours of [0,-1,1.5,169,'24']) await assert.rejects(updates.settings({automatic:true,intervalHours:hours,channel:'stable'}),/INVALID_UPDATE_SETTINGS/);
  await assert.rejects(updates.settings(null),/INVALID_UPDATE_SETTINGS/);
  // 中文：间隔改成链式 setTimeout 后只模拟定时器；轮询改用 setImmediate，避免依赖被模拟的 setTimeout。
  t.mock.timers.enable({apis:['setTimeout']});
  const idle=async()=>!(await updates.status()).checking;
  const flush=async predicate=>{for(let i=0;i<500;i++){if(await predicate())return;await new Promise(resolve=>setImmediate(resolve));}};
  await updates.settings({automatic:true,intervalHours:2,channel:'stable'});
  t.mock.timers.tick(3600000);await flush(idle);assert.equal(counts().checks,0);
  t.mock.timers.tick(3600000);await flush(idle);assert.equal(counts().checks,1);
  await updates.settings({automatic:true,intervalHours:3,channel:'stable'});
  t.mock.timers.tick(2*3600000);await flush(idle);assert.equal(counts().checks,1);
  t.mock.timers.tick(3600000);await flush(idle);assert.equal(counts().checks,2);
  assert.equal((await updates.status()).settings.intervalHours,3);assert.equal(counts().installs,0);
  assert.equal(JSON.parse(await readFile(join(data,'plugins/update-state.json'),'utf8')).settings.intervalHours,3);
});

test('the automatic interval defaults to one hour and legacy defaults migrate once',async t=>{
  const fresh=await fixture(t,{},undefined,{random:()=>0.5});
  assert.equal((await fresh.updates.status()).settings.intervalHours,1);
  for(const legacy of [24,2]){
    const {updates,data}=await fixture(t,{}, {settings:{automatic:true,intervalHours:legacy,channel:'stable'}});
    assert.equal((await updates.status()).settings.intervalHours,1);
    const saved=JSON.parse(await readFile(join(data,'plugins/update-state.json'),'utf8'));
    assert.equal(saved.settings.intervalHours,1);assert.equal(saved.defaultsMigration,1);
  }
  // 迁移只做一次：迁移后用户自己设的值、以及从未是默认值的自定义间隔都保持不动。
  const manual=await fixture(t,{}, {settings:{automatic:true,intervalHours:24,channel:'stable'},defaultsMigration:1});
  assert.equal((await manual.updates.status()).settings.intervalHours,24);
  const custom=await fixture(t,{}, {settings:{automatic:true,intervalHours:6,channel:'stable'}});
  assert.equal((await custom.updates.status()).settings.intervalHours,6);
});

test('scheduled checks are measured from this client and jittered off the clock hour',async t=>{
  assert.equal(nextCheckDelayMs(1,()=>0.5),3600000);
  assert.equal(nextCheckDelayMs(1,()=>0),3600000-6*60*1000);
  assert.equal(nextCheckDelayMs(1,()=>1),3600000+6*60*1000);
  // 长间隔的随机偏移封顶 15 分钟，极短间隔也不会短于一分钟。
  assert.equal(nextCheckDelayMs(168,()=>1)-168*3600000,15*60*1000);
  assert.equal(nextCheckDelayMs(1/60,()=>0),60000);
  // 每轮重新取偏移，避免所有客户端固定在整点同时请求。
  const draws=new Set(Array.from({length:50},()=>nextCheckDelayMs(1)));
  assert.ok(draws.size>40);
});

test('core upgrade discards old pending actions while retaining update preferences and verified history',async t=>{
 const history={'dsh-plugin@1.4.3-company.1':'saved-digest'};
 const settings={automatic:false,intervalHours:12,channel:'test'};
 const {updates,store}=await fixture(t,{}, {phase:'pending',pending:'legacy-graph',releases:[{package:'old'}],history,settings});
 store.dataSchema=2;await store.beginBoot();await store.confirmBoot();await updates.start();
 const state=await updates.status();assert.equal(state.phase,'idle');assert.equal(state.pending,undefined);assert.deepEqual(state.releases,[]);assert.deepEqual(state.history,history);assert.deepEqual(state.settings,settings);
 await assert.rejects(updates.restart(),/NO_PREPARED_UPDATE/);
});

// Compatibility must hold both before preparation and after the selected upgrades.
test('rejects a batch whose resulting host combination is incompatible before downloads',async t=>{
 const hosts=[];let downloads=0;
 const offer={package:'@cleverc2200/dsh-agent-workbench',version:'0.1.2'};
 const {updates,counts,store}=await fixture(t,{
  fetchCompanyChannel:async()=>({releases:[offer]}),
  validateReleaseChannel:(_value,_channel,host)=>{hosts.push(host.workbench);if(host.workbench==='0.1.2')throw Error('INCOMPATIBLE_TARGET');},
  fetchReleasePackage:async()=>{downloads++;return new Uint8Array([1]);},
 });
 await updates.check();await assert.rejects(updates.prepare({all:true}),/INCOMPATIBLE_TARGET/);
 assert.deepEqual(hosts,['0.1.1','0.1.2']);assert.equal(downloads,0);assert.equal(counts().installs,0);
 assert.equal((await store.selected()).id,'baseline');
});

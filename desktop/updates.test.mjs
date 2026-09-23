import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {PluginStore} from './plugin-store.mjs';import {createUpdates} from './updates.mjs';
const until=async(fn,predicate)=>{for(let i=0;i<150;i++){const value=await fn();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw Error('timed out');};
async function fixture(t,overrides={},initialState,sources){
 const data=await mkdtemp(join(tmpdir(),'gea-updates-'));const baseline=join(data,'baseline');
 const dependencies={'@deepseek-ai/dsh':'0.1.5-rc.2','@cleverc2200/dsh-agent-workbench':'0.1.1','dsh-plugin':'1.4.3-company.1'};
 for(const [name,version] of Object.entries(dependencies)){await mkdir(join(baseline,'node_modules',name),{recursive:true});await writeFile(join(baseline,'node_modules',name,'package.json'),JSON.stringify({name,version}));}
 await writeFile(join(baseline,'package.json'),JSON.stringify({dependencies}));
 if(initialState){await mkdir(join(data,'plugins'),{recursive:true});await writeFile(join(data,'plugins/update-state.json'),JSON.stringify(initialState));}
 const store=new PluginStore({data,baseline});const release={package:'dsh-plugin',version:'1.4.3-company.2',notes:{zh:'更新',en:'Update'}};
 let installs=0,restarts=0,checks=0,desktopChecks=0;
 const updates=await createUpdates({data,store,desktopVersion:'0.0.2',sources:sources??{stable:'stable',test:'test'},checkDesktop:async()=>{desktopChecks++;},
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
test('a leftover failure notice is dropped once the channel offers different versions',async t=>{
 const settings={automatic:false,intervalHours:24,channel:'stable'};
 const failed={phase:'failed',error:'PLUGIN_INSTALL_FAILED_1',targets:[{package:'dsh-plugin',version:'1.4.3-company.1'}],settings};
 const {updates}=await fixture(t,{},failed);
 await updates.check();
 const state=await updates.status();
 assert.equal(state.phase,'idle');
 assert.equal(state.error,null);
 assert.equal(state.targets,undefined);
 assert.equal(state.releases.length,1);
});
test('a failed attempt keeps its notice while the channel still offers the same version',async t=>{
 const settings={automatic:false,intervalHours:24,channel:'stable'};
 const failed={phase:'failed',error:'PLUGIN_INSTALL_FAILED_1',targets:[{package:'dsh-plugin',version:'1.4.3-company.2'}],settings};
 const {updates}=await fixture(t,{},failed);
 await updates.check();
 const state=await updates.status();
 assert.equal(state.phase,'failed');
 assert.equal(state.error,'PLUGIN_INSTALL_FAILED_1');
});
test('a failure whose batch changed is dropped even when one package kept its version',async t=>{
 const settings={automatic:false,intervalHours:24,channel:'stable'};
 const failed={phase:'failed',error:'UPDATE_ROLLED_BACK',settings,
  targets:[{package:'dsh-plugin',version:'1.4.3-company.2'},{package:'@cleverc2200/dsh-agent-workbench',version:'0.1.2'}]};
 const {updates}=await fixture(t,{},failed);
 await updates.check();
 const state=await updates.status();
 assert.equal(state.phase,'idle');
 assert.equal(state.error,null);
 assert.equal(state.targets,undefined);
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
  assert.equal((await updates.status()).settings.intervalHours,2);
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
  manifest.dependencies['dsh-raw-html-v2']='0.1.0';
  await writeFile(join(f.data,'baseline/package.json'),JSON.stringify(manifest));
  await mkdir(join(f.data,'baseline/node_modules/dsh-raw-html-v2'),{recursive:true});
  await writeFile(join(f.data,'baseline/node_modules/dsh-raw-html-v2/package.json'),JSON.stringify({name:'dsh-raw-html-v2',version:'0.1.0'}));
  assert.equal((await f.updates.status()).optional.plugins.find(p=>p.key==='dsh-raw-html-v2').enabled,true);
  await f.updates.optionalToggle({name:'dsh-raw-html-v2',enabled:false});
  assert.equal(runtimeRestarts,1);assert.equal((await f.updates.status()).optional.plugins.find(p=>p.key==='dsh-raw-html-v2').enabled,false);
  const saved=JSON.parse(await readFile(join(f.data,'plugins/optional-state.json'),'utf8'));assert.equal(saved['dsh-raw-html-v2'],false);
});
test('interval settings validate and persist; the plugin owns the schedule',async t=>{
  const {updates,counts,data}=await fixture(t);
  for(const hours of [0,-1,1.5,169,'24']) await assert.rejects(updates.settings({automatic:true,intervalHours:hours,channel:'stable'}),/INVALID_UPDATE_SETTINGS/);
  await assert.rejects(updates.settings(null),/INVALID_UPDATE_SETTINGS/);
  await updates.settings({automatic:true,intervalHours:3,channel:'stable'});
  // 中文：宿主不再自带定时器，只持久化设置；节奏（默认值/随机错开）由插件中心排期。
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(counts().checks,0);
  assert.equal((await updates.status()).settings.intervalHours,3);assert.equal(counts().installs,0);
  assert.equal(JSON.parse(await readFile(join(data,'plugins/update-state.json'),'utf8')).settings.intervalHours,3);
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

// 兼容版频道来源：一个频道可以有多个地址，按顺序尝试，前一个读不到才用下一个。
test('prefers the first channel source and falls back to the next one only when it fails',async t=>{
 const candidates=['https://oss.example/dsh-0.1.6-stable.json','http://gitlab.example/dsh-0.1.6-stable.json'];
 const attempts=[];
 const fallback=await fixture(t,{fetchCompanyChannel:async source=>{attempts.push(source);if(source===candidates[0])throw Error('RELEASE_HTTP_404');return {releases:[{package:'dsh-plugin',version:'1.4.3-company.2'}]}}},undefined,{stable:candidates,test:candidates});
 const state=await fallback.updates.check();
 assert.deepEqual(attempts,candidates);
 assert.equal(state.channelSource,candidates[1]);
 assert.equal(state.checkError,null);
 assert.equal(state.releases.length,1);

 attempts.length=0;
 const preferred=await fixture(t,{fetchCompanyChannel:async source=>{attempts.push(source);return {releases:[{package:'dsh-plugin',version:'1.4.3-company.2'}]}}},undefined,{stable:candidates,test:candidates});
 const first=await preferred.updates.check();
 assert.deepEqual(attempts,[candidates[0]],'a working first source must not be re-fetched from the fallback');
 assert.equal(first.channelSource,candidates[0]);
});

test('reports the last error and offers nothing when every channel source fails',async t=>{
 const candidates=['https://oss.example/dsh-0.1.6-stable.json','http://gitlab.example/dsh-0.1.6-stable.json'];
 const attempts=[];
 const {updates}=await fixture(t,{fetchCompanyChannel:async source=>{attempts.push(source);throw Error(source===candidates[0]?'RELEASE_HTTP_404':'RELEASE_HTTP_503')}},undefined,{stable:candidates,test:candidates});
 const state=await updates.check();
 assert.deepEqual(attempts,candidates);
 assert.equal(state.channelSource,null);
 assert.equal(state.checkError,'RELEASE_HTTP_503');
 assert.deepEqual(state.releases,[]);
});

test('a single channel address still works without a fallback list',async t=>{
 const attempts=[];
 const {updates}=await fixture(t,{fetchCompanyChannel:async source=>{attempts.push(source);return {releases:[{package:'dsh-plugin',version:'1.4.3-company.2'}]}}});
 const state=await updates.check();
 assert.deepEqual(attempts,['stable']);
 assert.equal(state.channelSource,'stable');
});

// 内置基线高于频道时不能把降级当成升级：频道是唯一真相，但“本地更新”不是更新。
test('a channel release older than the installed package is never offered as an update',async t=>{
 const stale={package:'dsh-plugin',version:'1.4.3-company.0'};
 const {updates,store,counts}=await fixture(t,{fetchCompanyChannel:async()=>({releases:[stale]})});
 const state=await updates.check();
 assert.equal(state.releases.length,1,'频道内容仍然要展示，只是不构成更新');
 assert.deepEqual(await updates.prepare({package:'dsh-plugin'}),{error:'ALREADY_CURRENT'});
 assert.equal(counts().installs,0);
 assert.equal((await store.selected()).id,'baseline');
});

test('an equal channel release is not an update, a higher one is, and pre-release suffixes compare numerically',async t=>{
 for(const wanted of [{version:'1.4.3-company.1',expected:'ALREADY_CURRENT'},{version:'1.4.3-company.2',expected:undefined},{version:'1.4.3-company.10',expected:undefined}]){
  const {updates}=await fixture(t,{fetchCompanyChannel:async()=>({releases:[{package:'dsh-plugin',version:wanted.version}]})});
  await updates.check();
  const answer=await updates.prepare({package:'dsh-plugin'});
  if(wanted.expected)assert.deepEqual(answer,{error:wanted.expected},wanted.version);
  else assert.deepEqual(answer,{accepted:true},wanted.version);
 }
});

// 随包发出去的频道配置必须真的做到“公网来源优先、公司 GitLab 兜底”。
test('the shipped channel configuration keeps a public source ahead of the company GitLab fallback',async()=>{
 const sources=JSON.parse(await readFile(new URL('./release-sources.json',import.meta.url),'utf8'));
 for(const channel of ['stable','test']){
  const candidates=sources[channel];
  assert.ok(Array.isArray(candidates)&&candidates.length>=2,channel+' must carry a fallback list');
  assert.ok(candidates.every(url=>typeof url==='string'&&/^https?:\/\//.test(url)),channel+' entries must be absolute URLs');
  assert.match(candidates[0],/^https:\/\//,channel+' must try the public https source first');
  assert.ok(!candidates[0].includes('100.100.6.191'),channel+' must not try the internal GitLab host first');
  assert.match(candidates[candidates.length-1],/^http:\/\/100\.100\.6\.191:20656\/chenyonghao\/dsh-plugin-releases\//,channel+' must keep the company GitLab channel last');
 }
});

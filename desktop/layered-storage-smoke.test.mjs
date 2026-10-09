import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,cp,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {PluginStore} from './plugin-store.mjs';
import {profile} from '../tests/profile.mjs';
import {createRequire} from 'node:module';

test('real ASAR core is shared across two plugin graphs and rollback survives loss of the application baseline',{
  skip:!process.versions.electron||!process.env.GEA_LAYERED_TEST_PAYLOAD,timeout:180000,
},async t=>{
  const baseline=resolve(process.env.GEA_LAYERED_TEST_PAYLOAD),data=await mkdtemp(join(tmpdir(),'gea-layered-store-'));
  const physicalFs=createRequire(import.meta.url)('original-fs').promises;
  t.after(()=>physicalFs.rm(data,{recursive:true,force:true}));
  const store=new PluginStore({data,baseline,dataSchema:2});
  await mkdir(join(data,'data'),{recursive:true});await writeFile(join(data,'data/session'),'saved-session');
  await store.beginBoot();await store.confirmBoot();
  const first='channel-00000000-0000-4000-8000-000000000001',second='channel-00000000-0000-4000-8000-000000000002';
  const marker=path=>join(path,'node_modules/@cleverc2200/gea-dsh-prototype/layer-probe.txt');
  const one=await store.prepare({id:first,install:async path=>{await writeFile(marker(path),'first');}});
  assert.equal(one.coreDataSchema,2);assert.equal(one.dataSchema,'layered-v1:2');
  assert.equal(one.layout,'layered');await store.activate(first);await store.beginBoot();await store.confirmBoot();
  const two=await store.prepare({id:second,install:async path=>{assert.equal(await readFile(marker(path),'utf8'),'first');await writeFile(marker(path),'second');}});
  assert.equal(two.layout,'layered');assert.equal(one.coreId,two.coreId);
  await store.activate(second);await store.beginBoot();await store.failBoot('fixture-failure');
  const selected=await store.selected();assert.equal(selected.id,first);assert.equal(await readFile(marker(selected.path),'utf8'),'first');
  assert.equal(await readFile(join(data,'data/session'),'utf8'),'saved-session');
  assert.equal((await readdir(join(store.root,'cores'))).length,1);
  // Exercise physical ASAR removal in Electron, whose ordinary fs treats the
  // archive as a virtual directory and cannot safely remove it recursively.
  const unused='f'.repeat(64),unusedDir=join(store.root,'cores',unused);
  await mkdir(unusedDir);
  await physicalFs.copyFile(selected.core.path,join(unusedDir,'node_modules.asar'));
  await writeFile(join(unusedDir,'core.json'),JSON.stringify({...selected.core.metadata,id:unused}));
  await store.beginBoot();await store.confirmBoot();
  assert.deepEqual((await store.collectGarbage()).coresRemoved,[unused]);
  await assert.rejects(physicalFs.stat(unusedDir),{code:'ENOENT'});
  const newBaseline=join(data,'new-app');await mkdir(newBaseline);
  await cp(join(baseline,'resources'),join(newBaseline,'resources'),{recursive:true});
  store.baseline=newBaseline;assert.equal((await store.selected()).core.id,one.coreId);
  const archive=join(baseline,'node_modules.asar'),hidden=archive+'.smoke-hidden';
  await physicalFs.rename(archive,hidden);await physicalFs.rename(archive+'.unpacked',hidden+'.unpacked');
  try{
    await assert.rejects(physicalFs.readFile(archive),{code:'ENOENT'});
    const app=await profile(t,{desktopGraph:selected.path,execArgv:['--expose-internals'],env:{ELECTRON_RUN_AS_NODE:'1',GEA_LAYERED_CORE:selected.core.path,GEA_LAYERED_GRAPH:selected.path,DSH_DESKTOP_BASELINE:newBaseline}});
    assert.equal((await app.rpc('status')).value.authenticated,false);assert.equal((await app.login()).ok,true);
    await app.stop();
  }finally{
    await physicalFs.rename(hidden+'.unpacked',archive+'.unpacked');await physicalFs.rename(hidden,archive);
  }
  console.log(JSON.stringify({sharedCore:one.coreId,graphs:[first,second],rollback:first,booted:true}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PluginStore} from './plugin-store.mjs';
import {pruneUnreferencedArchives} from './plugin-storage.mjs';

const id=n=>'channel-00000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'gea-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const data=join(root,'user'),baseline=join(root,'baseline');await mkdir(join(baseline,'node_modules'),{recursive:true});
  await writeFile(join(baseline,'package.json'),'{"dependencies":{}}');
  await writeFile(join(baseline,'node_modules/runtime.bin'),Buffer.alloc(65536,7));
  const store=new PluginStore({data,baseline});
  const update=async name=>{await store.prepare({id:name,install:async()=>{}});await store.activate(name);await store.beginBoot();await store.confirmBoot();};
  return {root,data,baseline,store,update};
}
test('six successful updates retain current and previous and preserve business data',async t=>{
  const {data,store,update}=await fixture(t);
  await mkdir(join(data,'data'),{recursive:true});await writeFile(join(data,'data/session'),'session');await writeFile(join(data,'login.encrypted'),'login');
  for(let n=1;n<=6;n++)await update(id(n));
  assert.equal((await readdir(join(store.root,'versions'))).length,6);
  const result=await store.collectGarbage();assert.equal(result.removed.length,4);
  assert.deepEqual(await readdir(join(store.root,'versions')),[id(5),id(6)]);
  assert.equal((await store.selected()).id,id(6));
  assert.equal(await readFile(join(data,'data/session'),'utf8'),'session');assert.equal(await readFile(join(data,'login.encrypted'),'utf8'),'login');
});
test('pending, manual, pinned and migration references are retained',async t=>{
  const {store,update}=await fixture(t);
  for(let n=1;n<=4;n++)await update(id(n));
  await store.prepare({id:'local-keep',install:async()=>{}});
  await writeFile(join(store.root,'update-state.json'),JSON.stringify({phase:'pending',pending:id(1)}));
  const file=join(store.root,'selection.json');const state=JSON.parse(await readFile(file));
  await writeFile(file,JSON.stringify({...state,upgradedFrom:{active:id(2)}}));
  await store.collectGarbage();assert.equal((await readdir(join(store.root,'versions'))).length,5);
  await writeFile(join(store.root,'update-state.json'),JSON.stringify({phase:'cancelled',pending:id(1)}));
  const receipt=join(store.root,'versions',id(1),'version.json');await writeFile(receipt,JSON.stringify({...JSON.parse(await readFile(receipt)),pinned:true}));
  await store.collectGarbage();assert.equal((await readdir(join(store.root,'versions'))).length,5);
});
test('unconfirmed boot, malformed update state and an active writer all block collection',async t=>{
  const {store,update}=await fixture(t);for(let n=1;n<=3;n++)await update(id(n));
  await store.beginBoot();assert.equal((await store.collectGarbage()).skipped,'boot-not-verified');await store.confirmBoot();
  await writeFile(join(store.root,'update-state.json'),'{broken');assert.equal((await store.collectGarbage()).skipped,'invalid-storage-state');
  await rm(join(store.root,'update-state.json'));
  await store.withLock(async()=>{assert.equal((await store.collectGarbage()).skipped,'store-busy');});
  assert.equal((await readdir(join(store.root,'versions'))).length,3);
});
test('unknown receipts, directory links and abandoned staging are not deleted',async t=>{
  const {root,store,update}=await fixture(t);for(let n=1;n<=3;n++)await update(id(n));
  await writeFile(join(store.root,'versions',id(1),'version.json'),'{broken');
  const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'keep');
  await symlink(outside,join(store.root,'versions',id(4)),process.platform==='win32'?'junction':'dir');
  await mkdir(join(store.root,'staging-unknown'));await writeFile(join(store.root,'staging-unknown/keep'),'keep');
  await store.collectGarbage();assert.equal((await readdir(join(store.root,'versions'))).length,4);
  assert.equal(await readFile(join(outside,'keep'),'utf8'),'keep');assert.equal(await readFile(join(store.root,'staging-unknown/keep'),'utf8'),'keep');
});
test('archive pruning retains manifest, workspace and lock references and named core archives',async t=>{
  const {baseline}=await fixture(t);const archives=join(baseline,'packages');await mkdir(archives);
  const names=['a','b','c','d'].map(x=>x.repeat(64)+'.tgz');
  for(const name of [...names,'core.tgz'])await writeFile(join(archives,name),'archive');
  await writeFile(join(baseline,'package.json'),JSON.stringify({dependencies:{plugin:'file:packages/'+names[0]}}));
  await writeFile(join(baseline,'pnpm-workspace.yaml'),'overrides:\n  plugin: file:packages/'+names[1]);
  await writeFile(join(baseline,'pnpm-lock.yaml'),'packages:\n  file:packages/'+names[2]+': {}');
  assert.deepEqual(await pruneUnreferencedArchives(baseline),[names[3]]);
  assert.deepEqual(await readdir(archives),[...names.slice(0,3),'core.tgz'].sort());
});

test('core collection keeps references and refuses an incomplete version inventory',async t=>{
  const {store,update}=await fixture(t);await update(id(1));
  const current='a'.repeat(64),unused='b'.repeat(64),unknown='c'.repeat(64);
  for(const core of [current,unused,unknown]){
    const path=join(store.root,'cores',core);await mkdir(path,{recursive:true});
    await writeFile(join(path,'node_modules.asar'),'owned core');
    await writeFile(join(path,'core.json'),JSON.stringify({schema:1,id:core,archiveSha256:'d'.repeat(64)}));
  }
  const receipt=join(store.root,'versions',id(1),'version.json');
  await writeFile(receipt,JSON.stringify({...JSON.parse(await readFile(receipt)),coreId:current}));
  await writeFile(join(store.root,'cores',unknown,'core.json'),'{broken');
  const staging=join(store.root,'staging-unknown');await mkdir(staging);
  assert.deepEqual((await store.collectGarbage()).coresRemoved,[]);
  await rm(staging,{recursive:true});
  assert.deepEqual((await store.collectGarbage()).coresRemoved,[unused]);
  assert.deepEqual(await readdir(join(store.root,'cores')),[current,unknown]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginStore} from './plugin-store.mjs';

test('two preparations normalize Windows-style absolute metadata before install and before version rename',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea move 中文 '));t.after(()=>rm(root,{recursive:true,force:true}));
 const baseline=join(root,'baseline'),store=new PluginStore({data:join(root,'user'),baseline});
 await mkdir(join(baseline,'node_modules/.pnpm'),{recursive:true});
 await writeFile(join(baseline,'package.json'),'{"dependencies":{}}');
 const metadata={nodeLinker:'hoisted',layoutVersion:5,storeDir:'real-store',virtualStoreDirMaxLength:60,virtualStoreDir:join(store.root,'staging-12345678-1234-1234-1234-123456789abc/node_modules/.pnpm')};
 const file=join(baseline,'node_modules/.modules.yaml');await writeFile(file,JSON.stringify(metadata));
 for(const id of ['first','second']){
  await store.prepare({id,install:async directory=>{
   const path=join(directory,'node_modules/.modules.yaml');
   const current=JSON.parse(await readFile(path));assert.equal(current.virtualStoreDir,'.pnpm');
   await writeFile(path,JSON.stringify({...current,virtualStoreDir:join(directory,'node_modules/.pnpm')}));
  }});
  await store.activate(id);
  assert.equal(JSON.parse(await readFile(join((await store.selected()).path,'node_modules/.modules.yaml'))).virtualStoreDir,'.pnpm');
 }
 assert.deepEqual(JSON.parse(await readFile(file)),metadata);
});

test('preparing a version leaves the running selection and user data unchanged until explicit activation', async t => {
  const root=await mkdtemp(join(tmpdir(),'gea-versions-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const baseline=join(root,'baseline');
  await mkdir(join(baseline,'node_modules'),{recursive:true});
  await writeFile(join(baseline,'package.json'),JSON.stringify({name:'baseline',version:'1',dependencies:{}}));
  const store=new PluginStore({data:join(root,'user'),baseline});
  assert.equal((await store.status()).active,'baseline');
  const prepared=await store.prepare({id:'gea-2',install:async directory=>{
    await writeFile(join(directory,'receipt.json'),'version two');
  }});
  assert.equal(prepared.id,'gea-2');
  assert.equal((await store.status()).active,'baseline');
  await store.activate('gea-2');
  assert.equal((await store.selected()).id,'gea-2');
  assert.equal(await readFile(join((await store.selected()).path,'receipt.json'),'utf8'),'version two');
});

test('failed preparation and duplicate version ids preserve the last usable graph', async t => {
  const root=await mkdtemp(join(tmpdir(),'gea-failed-version-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const baseline=join(root,'baseline');await mkdir(baseline);
  await writeFile(join(baseline,'package.json'),JSON.stringify({dependencies:{}}));
  const store=new PluginStore({data:join(root,'user'),baseline});
  await assert.rejects(store.prepare({id:'bad',install:async()=>{throw Error('DOWNLOAD_FAILED');}}),/DOWNLOAD_FAILED/);
  assert.equal((await store.status()).active,'baseline');
  await store.prepare({id:'good',install:async()=>{}});
  await assert.rejects(store.prepare({id:'good',install:async()=>{}}),/PLUGIN_VERSION_EXISTS/);
  await store.activate('good');
  assert.equal((await store.selected()).id,'good');
});

test('version storage rejects path traversal and does not copy local credentials', async t => {
  const root=await mkdtemp(join(tmpdir(),'gea paths '));t.after(()=>rm(root,{recursive:true,force:true}));
  const baseline=join(root,'baseline');await mkdir(baseline);await writeFile(join(baseline,'package.json'),'{}');
  await writeFile(join(baseline,'gea.config.json'),'private connection');
  const store=new PluginStore({data:join(root,'用户数据'),baseline});
  await assert.rejects(store.activate('../escape'),/INVALID_VERSION_ID/);
  await store.prepare({id:'with-spaces',install:async directory=>{
    await assert.rejects(readFile(join(directory,'gea.config.json')), {code:'ENOENT'});
  }});
  await store.activate('with-spaces');
  assert.equal((await store.selected()).id,'with-spaces');
});

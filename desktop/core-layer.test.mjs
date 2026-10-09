import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp,symlink,lstat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {packageDigest,materializeGraph,compactGraph} from './core-layer.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'gea-core-layer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const coreRoot=join(root,'core'),graph=join(root,'graph');
  for(const [name,source,deps] of [['a',"module.exports=require('b')",{b:'1.0.0'}],['b',"module.exports='old'",{}]]){
    const dir=join(coreRoot,'node_modules',name);await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',main:'index.cjs',dependencies:deps}));await writeFile(join(dir,'index.cjs'),source);
  }
  await writeFile(join(coreRoot,'package.json'),JSON.stringify({dependencies:{a:'1.0.0',b:'1.0.0'}}));
  await cp(coreRoot,graph,{recursive:true});const packages={};for(const name of ['a','b'])packages[name]={version:'1.0.0',sha256:await packageDigest(join(coreRoot,'node_modules',name))};
  return {root,graph,core:{id:'a'.repeat(64),path:coreRoot,metadata:{packages}}};
}
test('unchanged core can be removed from a version and fully materialized for its next update',async t=>{
  const {root,graph,core}=await fixture(t);const before=await packageDigest(join(graph,'node_modules'));
  assert.deepEqual(await compactGraph(graph,core),{layout:'layered',coreId:core.id});
  await assert.rejects(readFile(join(graph,'node_modules/a/index.cjs')),{code:'ENOENT'});
  const restored=join(root,'restored');await materializeGraph({path:graph,core},restored);
  assert.equal(await packageDigest(join(restored,'node_modules')),before);
  assert.equal(createRequire(join(restored,'package.json'))('a'),'old');
});
test('unchanged A depending on upgraded B keeps a full graph and really loads the new B',async t=>{
  const {graph,core}=await fixture(t);await writeFile(join(graph,'node_modules/b/index.cjs'),"module.exports='new'");
  assert.deepEqual(await compactGraph(graph,core),{layout:'full',reason:'core-dependency-changed'});
  assert.equal(createRequire(join(graph,'package.json'))('a'),'new');
  assert.equal(await readFile(join(core.path,'node_modules/b/index.cjs'),'utf8'),"module.exports='old'");
});
test('a removed shared dependency is not resurrected by fallback',async t=>{
  const {graph,core}=await fixture(t);await rm(join(graph,'node_modules/b'),{recursive:true});
  assert.equal((await compactGraph(graph,core)).layout,'full');await assert.rejects(readFile(join(graph,'node_modules/b/index.cjs')),{code:'ENOENT'});
});
test('a previously absent optional dependency appearing in the new graph forces full mode',async t=>{
  const {graph,core}=await fixture(t);
  for(const root of [graph,core.path]){
    const file=join(root,'node_modules/a/package.json');const meta=JSON.parse(await readFile(file));meta.optionalDependencies={c:'1.0.0'};await writeFile(file,JSON.stringify(meta));
  }
  core.metadata.packages.a.sha256=await packageDigest(join(core.path,'node_modules/a'));
  await mkdir(join(graph,'node_modules/c'));await writeFile(join(graph,'node_modules/c/package.json'),'{"name":"c","version":"1.0.0"}');
  assert.deepEqual(await compactGraph(graph,core),{layout:'full',reason:'core-dependency-changed'});
  assert.ok(await readFile(join(graph,'node_modules/a/package.json')));
});
test('core command links leave no dangling package links and work after hydration',async t=>{
  const {root,graph,core}=await fixture(t);
  for(const dir of [graph,core.path])await writeFile(join(dir,'node_modules/a/cli.cjs'),"#!/usr/bin/env node\nconsole.log(require('b'))\n",{mode:0o755});
  core.metadata.packages.a.sha256=await packageDigest(join(core.path,'node_modules/a'));
  await mkdir(join(graph,'node_modules/.bin'));await symlink('../a/cli.cjs',join(graph,'node_modules/.bin/a'));
  assert.equal((await compactGraph(graph,core)).layout,'layered');
  await assert.rejects(lstat(join(graph,'node_modules/.bin/a')),{code:'ENOENT'});
  const restored=join(root,'restored');await materializeGraph({path:graph,core},restored);
  assert.equal(execFileSync(process.execPath,[join(restored,'node_modules/.bin/a')],{encoding:'utf8'}).trim(),'old');
});

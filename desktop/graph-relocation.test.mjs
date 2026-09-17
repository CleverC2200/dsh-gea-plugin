import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {relocateVirtualStore} from './copy-graph.mjs';

test('only owned hoisted virtual stores become portable; other compatibility metadata is retained',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-relocation-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const directory=join(root,'plugins/staging-new'),source=join(root,'plugins/versions/old');
 await mkdir(join(directory,'node_modules/.pnpm'),{recursive:true});
 const file=join(directory,'node_modules/.modules.yaml');
 const oldStage=join(root,'plugins/staging-12345678-1234-1234-1234-123456789abc/node_modules/.pnpm');
 const base={nodeLinker:'hoisted',layoutVersion:5,storeDir:'foreign-store',virtualStoreDirMaxLength:120};
 for(const oldPath of [join(source,'node_modules/.pnpm'),oldStage,join(directory,'node_modules/.pnpm'),'.pnpm']){
  await writeFile(file,JSON.stringify({...base,virtualStoreDir:oldPath}));
  await relocateVirtualStore(directory,{sourceDirectory:source,storeRoot:join(root,'plugins')});
  assert.deepEqual(JSON.parse(await readFile(file)),{...base,virtualStoreDir:'.pnpm'});
 }
 for(const change of [{virtualStoreDir:join(root,'unrelated/node_modules/.pnpm')},{virtualStoreDir:oldStage,nodeLinker:'isolated'},{virtualStoreDir:oldStage,layoutVersion:99}]){
  const bytes=JSON.stringify({...base,...change});await writeFile(file,bytes);
  await relocateVirtualStore(directory,{sourceDirectory:source,storeRoot:join(root,'plugins')});
  assert.equal(await readFile(file,'utf8'),bytes);
 }
 await rm(join(directory,'node_modules/.pnpm'),{recursive:true});
 const external=join(root,'external');await mkdir(external);
 await symlink(external,join(directory,'node_modules/.pnpm'),process.platform==='win32'?'junction':'dir');
 const bytes=JSON.stringify({...base,virtualStoreDir:oldStage});await writeFile(file,bytes);
 await relocateVirtualStore(directory,{sourceDirectory:source,storeRoot:join(root,'plugins')});
 assert.equal(await readFile(file,'utf8'),bytes);
});

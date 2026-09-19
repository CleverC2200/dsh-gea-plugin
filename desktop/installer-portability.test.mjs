/** Exercises pnpm's real relocation path with copied builder metadata. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {PluginStore} from './plugin-store.mjs';
import {installArtifact} from './installer.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

test('a graph copied from another machine installs without changing the active graph or business data',{timeout:180000},async t=>{
 assert.ok(process.env.GEA_DESKTOP_PAYLOAD);assert.ok(process.env.GEA_PLUGIN_ARTIFACT);
 assert.ok(process.env.GEA_EXPECTED_PLUGIN_VERSION);
 const baseline=resolve(process.env.GEA_DESKTOP_PAYLOAD),data=await mkdtemp(join(tmpdir(),'gea-portable-install-'));
 t.after(()=>rm(data,{recursive:true,force:true}));
 const marker=join(data,'gea.config.json');await writeFile(marker,'{"keep":"business configuration"}');
 const dataSchema=JSON.parse(await readFile(join(baseline,'package.json'))).desktopDataSchema??1;
 const store=new PluginStore({data,baseline,dataSchema});let log='';
 const receipt=await store.prepare({id:'relocated',install:async(directory,{registerProcess})=>{
  const path=join(directory,'node_modules/.modules.yaml');
  const {parse}=createRequire(join(directory,'package.json'))('yaml');
  const metadata=parse(await readFile(path,'utf8'));
  metadata.storeDir=join(data,'other-machine-store');
  metadata.virtualStoreDirMaxLength=process.platform==='win32'?120:60;
  await writeFile(path,JSON.stringify(metadata));
  await installArtifact({directory,optimizedBaseline:baseline,artifact:resolve(process.env.GEA_PLUGIN_ARTIFACT),node:join(baseline,process.platform==='win32'?'node/node.exe':'node/bin/node'),pnpm:process.env.GEA_TEST_PNPM??join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProcess:registerProcess,onProgress:line=>{log=(log+line).slice(-12000);}}).catch(error=>{throw Error(error.message+'\n'+log,{cause:error});});
 }});
 assert.equal(receipt.state,'prepared');
 const host='node_modules/@deepseek-ai/dsh-client-modules/lib/index.js';
 assert.deepEqual(await readFile(join(data,'plugins/versions/relocated',host)),await readFile(join(baseline,host)));
 assert.match(await readFile(join(data,'plugins/versions/relocated',host),'utf8'),/offset = value.indexOf/);
 const optimized=JSON.parse(await readFile(join(baseline,'client-artifacts.json')));
 const shared=optimized.files.find(file=>file.file.startsWith('node_modules/@deepseek-ai/'));
 assert.equal(digest(await readFile(join(data,'plugins/versions/relocated',shared.file))),digest(await readFile(join(baseline,shared.file))));
 assert.equal(digest(await readFile(join(data,'plugins/versions/relocated',shared.file+'.map'))),digest(await readFile(join(baseline,shared.file+'.map'))));
 assert.equal(receipt.versions['@cleverc2200/gea-dsh-prototype'],process.env.GEA_EXPECTED_PLUGIN_VERSION);
 const changed='node_modules/@cleverc2200/gea-dsh-prototype/lib/host.js';
 assert.notDeepEqual(await readFile(join(data,'plugins/versions/relocated',changed)),await readFile(join(baseline,changed)));
 assert.equal((await store.selected()).id,'baseline');
 assert.equal(await readFile(marker,'utf8'),'{"keep":"business configuration"}');
});

test('successive real plugin installations retain the copied core across staging and version renames',{timeout:180000,skip:!process.env.GEA_PREVIOUS_PLUGIN_ARTIFACT},async t=>{
 assert.ok(process.env.GEA_PREVIOUS_PLUGIN_ARTIFACT);
 const baseline=resolve(process.env.GEA_DESKTOP_PAYLOAD),data=await mkdtemp(join(tmpdir(),'gea-repeat-install-'));
 t.after(()=>rm(data,{recursive:true,force:true}));
 const dataSchema=JSON.parse(await readFile(join(baseline,'package.json'))).desktopDataSchema??1;
 const store=new PluginStore({data,baseline,dataSchema});
 await store.beginBoot();await store.confirmBoot();
 for(const [i,artifact] of [process.env.GEA_PREVIOUS_PLUGIN_ARTIFACT,process.env.GEA_PLUGIN_ARTIFACT].entries()){
  let log='';
  const receipt=await store.prepare({id:'repeat-'+i,install:async(directory,{registerProcess})=>{
   const core=join(directory,'node_modules/@deepseek-ai/dsh/lib/bin.js');
   const before=await stat(core),bytes=await readFile(core);
   await installArtifact({directory,optimizedBaseline:baseline,artifact:resolve(artifact),node:join(baseline,process.platform==='win32'?'node/node.exe':'node/bin/node'),pnpm:process.env.GEA_TEST_PNPM??join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProcess:registerProcess,onProgress:line=>{log+=line;}}).catch(error=>{throw Error(error.message+'\n'+log,{cause:error});});
   // A new Windows machine legitimately imports the builder's foreign real store once.
   // The next version must reuse its own store without any relocation/rebuild fallback.
   if(i===0)assert.doesNotMatch(log,/ERR_PNPM_(?!UNEXPECTED_STORE\b)/);
   else assert.doesNotMatch(log,/ERR_PNPM_|Recreating .*node_modules/);
   if(!/Recreating .*node_modules/.test(log))assert.equal((await stat(core)).ino,before.ino);
   assert.equal(digest(await readFile(core)),digest(bytes));
   // On Mac simulate Windows' write before PluginStore renames staging into versions.
   const path=join(directory,'node_modules/.modules.yaml');
   const metadata=JSON.parse(await readFile(path,'utf8'));
   metadata.virtualStoreDir=join(directory,'node_modules/.pnpm');
   await writeFile(path,JSON.stringify(metadata));
  }});
  const graph=join(data,'plugins/versions/repeat-'+i);
  assert.equal(JSON.parse(await readFile(join(graph,'node_modules/.modules.yaml'))).virtualStoreDir,'.pnpm');
  if(i===1)assert.equal(receipt.versions['@cleverc2200/gea-dsh-prototype'],process.env.GEA_EXPECTED_PLUGIN_VERSION);
  await store.activate('repeat-'+i);
 }
});

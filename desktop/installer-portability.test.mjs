/** Exercises pnpm's real relocation path with copied builder metadata. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {PluginStore} from './plugin-store.mjs';
import {installArtifact} from './installer.mjs';

test('a graph copied from another machine installs without changing the active graph or business data',{timeout:180000},async t=>{
 assert.ok(process.env.GEA_DESKTOP_PAYLOAD);assert.ok(process.env.GEA_PLUGIN_ARTIFACT);
 const baseline=resolve(process.env.GEA_DESKTOP_PAYLOAD),data=await mkdtemp(join(tmpdir(),'gea-portable-install-'));
 t.after(()=>rm(data,{recursive:true,force:true}));
 const marker=join(data,'gea.config.json');await writeFile(marker,'{"keep":"business configuration"}');
 const store=new PluginStore({data,baseline});let log='';
 const receipt=await store.prepare({id:'relocated',install:async(directory,{registerProcess})=>{
  const path=join(directory,'node_modules/.modules.yaml');
  const {parse}=createRequire(join(directory,'package.json'))('yaml');
  const metadata=parse(await readFile(path,'utf8'));
  metadata.storeDir=join(data,'other-machine-store');
  metadata.virtualStoreDirMaxLength=process.platform==='win32'?120:60;
  await writeFile(path,JSON.stringify(metadata));
  await installArtifact({directory,optimizedBaseline:baseline,artifact:resolve(process.env.GEA_PLUGIN_ARTIFACT),node:join(baseline,process.platform==='win32'?'node/node.exe':'node/bin/node'),pnpm:join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),onProcess:registerProcess,onProgress:line=>{log=(log+line).slice(-12000);}}).catch(error=>{throw Error(error.message+'\n'+log,{cause:error});});
 }});
 assert.equal(receipt.state,'prepared');
 const optimized=JSON.parse(await readFile(join(baseline,'client-artifacts.json')));
 const shared=optimized.files.find(file=>file.file.startsWith('node_modules/@deepseek-ai/'));
 assert.deepEqual(await readFile(join(data,'plugins/versions/relocated',shared.file)),await readFile(join(baseline,shared.file)));
 assert.deepEqual(await readFile(join(data,'plugins/versions/relocated',shared.file+'.map')),await readFile(join(baseline,shared.file+'.map')));
 assert.equal(receipt.versions['@cleverc2200/gea-dsh-prototype'],'0.0.7');
 const changed='node_modules/@cleverc2200/gea-dsh-prototype/lib/workbench.js';
 assert.notDeepEqual(await readFile(join(data,'plugins/versions/relocated',changed)),await readFile(join(baseline,changed)));
 assert.equal((await store.selected()).id,'baseline');
 assert.equal(await readFile(marker,'utf8'),'{"keep":"business configuration"}');
});

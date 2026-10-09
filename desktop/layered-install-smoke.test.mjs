import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {PluginStore} from './plugin-store.mjs';
import {installArtifact} from './installer.mjs';
import {physicalFs} from './physical-fs.mjs';
import {profile} from '../tests/profile.mjs';
import {corePackageInventory,ensureCoreCache} from './core-layer.mjs';

test('real pinned pnpm installation safely handles dependency relocation and boots the updated graph',{
  skip:!process.versions.electron||!process.env.GEA_LAYERED_TEST_PAYLOAD||!process.env.GEA_PLUGIN_ARTIFACT,timeout:300000,
},async t=>{
  const baseline=resolve(process.env.GEA_LAYERED_TEST_PAYLOAD),data=await mkdtemp(join(tmpdir(),'gea-layered-install-'));
  t.after(()=>physicalFs.rm(data,{recursive:true,force:true}));
  const store=new PluginStore({data,baseline,dataSchema:2});
  await mkdir(join(data,'data'));await writeFile(join(data,'data/session'),'keep');
  await store.beginBoot();await store.confirmBoot();
  store.corePromise=ensureCoreCache(baseline,store.root);
  let log='';
  const receipt=await store.prepare({id:'channel-00000000-0000-4000-8000-000000000003',install:async(directory,{registerProcess})=>{
    await installArtifact({directory,artifact:resolve(process.env.GEA_PLUGIN_ARTIFACT),optimizedBaseline:baseline,
      node:join(baseline,process.platform==='win32'?'node/node.exe':'node/bin/node'),pnpm:join(baseline,'tools/node_modules/pnpm/bin/pnpm.cjs'),
      onProcess:registerProcess,onProgress:line=>{log=(log+line).slice(-16000);},
    }).catch(error=>{throw Error(error.message+'\n'+log,{cause:error});});
    const expected=(await store.corePromise).metadata.packages;
    const actual=await corePackageInventory(directory,{seeds:Object.keys(expected)});
    console.log(JSON.stringify({changedCore:Object.keys({...expected,...actual}).filter(name=>JSON.stringify(expected[name])!==JSON.stringify(actual[name])).map(name=>({name,before:expected[name],after:actual[name]}))}));
  }});
  assert.ok(['layered','full'].includes(receipt.layout));
  if(receipt.layout==='full')assert.equal(receipt.reason,'core-dependency-changed');
  await store.activate(receipt.id);const selected=await store.beginBoot();
  const app=await profile(t,{desktopGraph:selected.path,
    executablePath:selected.core?process.execPath:join(baseline,process.platform==='win32'?'node/node.exe':'node/bin/node'),
    execArgv:selected.core?['--expose-internals']:[],
    env:{ELECTRON_RUN_AS_NODE:'1',...(selected.core?{GEA_LAYERED_CORE:selected.core.path,GEA_LAYERED_GRAPH:selected.path}:{}),DSH_DESKTOP_BASELINE:baseline}});
  assert.equal((await app.login()).ok,true);await app.stop();await store.confirmBoot();
  assert.equal(await readFile(join(data,'data/session'),'utf8'),'keep');
  console.log(JSON.stringify({layout:receipt.layout,version:receipt.versions['@cleverc2200/gea-dsh-prototype'],booted:true}));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,cp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {createUpdates} from './updates.mjs';
import {createControlServer} from './control-server.mjs';

test('new shell onboarding loads yaml from the selected legacy full graph',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gea-legacy-runtime-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const shell=join(root,'new-payload'),graph=join(root,'old-version');await mkdir(shell);await mkdir(join(graph,'node_modules'),{recursive:true});
  await writeFile(join(graph,'package.json'),'{}');
  const require=createRequire(import.meta.url);await cp(dirname(require.resolve('yaml/package.json')),join(graph,'node_modules/yaml'),{recursive:true});
  await cp(new URL('./onboarding.mjs',import.meta.url),join(shell,'onboarding.mjs'));
  await writeFile(join(shell,'probe.mjs'),"import {configureWelcomeNotice} from './onboarding.mjs';await configureWelcomeNotice(process.argv[2]);");
  const settings=join(root,'settings.yml');await writeFile(settings,'other: keep\n');
  const env={...process.env,DSH_PLUGIN_GRAPH:graph};delete env.GEA_LAYERED_CORE;delete env.GEA_LAYERED_GRAPH;
  const result=spawnSync(process.execPath,[join(shell,'probe.mjs'),settings],{env,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(await readFile(settings,'utf8'),/other: keep/);assert.match(await readFile(settings,'utf8'),/2026-08-13.1/);
});

test('layered baseline exposes update status and checks through the real control endpoint',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gea-layered-updates-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const graph=join(root,'overlay'),core=join(root,'immutable');
  const dependencies={'@deepseek-ai/dsh':'0.1.6-alpha.1-company.1','@cleverc2200/dsh-agent-workbench':'0.1.1','dsh-plugin':'1.4.3-company.35'};
  for(const [name,version] of Object.entries(dependencies)){
    const dir=join(name==='@deepseek-ai/dsh'?core:graph,'node_modules',name);await mkdir(dir,{recursive:true});await writeFile(join(dir,'package.json'),JSON.stringify({name,version}));
  }
  await writeFile(join(graph,'package.json'),JSON.stringify({dependencies}));await writeFile(join(core,'package.json'),'{}');
  let checked=0;
  const store={selected:async()=>({id:'baseline',path:graph,core:{path:core,metadata:{packages:{'@deepseek-ai/dsh':{version:dependencies['@deepseek-ai/dsh']}}}}})};
  const updates=await createUpdates({data:root,store,desktopVersion:'0.0.24',sources:{stable:'fixture'},releases:{fetchCompanyChannel:async(_url,_channel,host)=>{checked++;assert.equal(host.dsh,dependencies['@deepseek-ai/dsh']);return {releases:[]};},verifyReleaseHistory:(_value,history)=>history}});
  const control=await createControlServer({'GET /updates/status':()=>updates.status(),'POST /updates/check':()=>updates.check()});
  t.after(async()=>{await control.close();await updates.close();});
  for(const [path,method] of [['status','GET'],['check','POST']]){
    const response=await fetch(control.url+'/updates/'+path,{method,headers:{Authorization:'Bearer '+control.token}});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.deepEqual(body.current,dependencies);
    if(path==='check')assert.equal(body.checkError,null);
  }
  assert.equal(checked,1);
});

/** Use the pinned official DSH plugin command and bundled pnpm, only inside a staging graph. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,copyFile,symlink,rm,readdir,realpath,unlink} from 'node:fs/promises';
import {join,dirname,resolve,sep} from 'node:path';
import {createRequire} from 'node:module';

export async function installArtifact({directory,artifact,node,pnpm,optimizedBaseline,signal,onProcess=async()=>{},onProgress=()=>{}}) {
  const deadline=AbortSignal.timeout(5*60*1000);
  signal=AbortSignal.any([...(signal?[signal]:[]),deadline]);
  const tool=JSON.parse(await readFile(join(dirname(dirname(pnpm)),'package.json'),'utf8'));
  if(tool.version!=='11.27.0')throw Error('INSTALL_TOOL_VERSION_MISMATCH');
  const manifestPath=join(directory,'package.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.dsh={profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...['@cleverc2200/gea-dsh-prototype','dsh-plugin','dsh-agent-manage','dsh-agent-plugins-market'].filter(name=>manifest.dependencies?.[name])],patchReload:'startup'}};
  delete manifest.pnpm;
  const overrides={...manifest.overrides};
  const {parse}=createRequire(manifestPath)('yaml');
  const workspace=parse(await readFile(join(directory,'pnpm-workspace.yaml'),'utf8'));
  const official={};
  for(const entry of await readdir(join(directory,'node_modules/@deepseek-ai'))) {
    const name='@deepseek-ai/'+entry;
    const pkg=JSON.parse(await readFile(join(directory,'node_modules',name,'package.json'),'utf8'));
    official[name]=pkg.version;
    const pinned=workspace.overrides?.[name];
    overrides[name]=typeof pinned==='string'&&pinned.startsWith('file:packages/')?pinned:pkg.version;
  }
  for(const name of Object.keys(manifest.dependencies??{})) {
    if(name.startsWith('@cleverc2200/')||['dsh-plugin','dsh-agent-manage','dsh-agent-plugins-market'].includes(name)) overrides[name]='$'+name;
  }
  await writeFile(manifestPath,JSON.stringify(manifest,null,2));
  await writeFile(join(directory,'pnpm-workspace.yaml'),JSON.stringify({nodeLinker:'hoisted',virtualStoreDirMaxLength:process.platform==='win32'?60:120,minimumReleaseAge:0,overrides,...(workspace.patchedDependencies?{patchedDependencies:workspace.patchedDependencies}:{})}));
  const artifacts=Array.isArray(artifact)?artifact:[artifact];
  if(!artifacts.length)throw Error('NO_PLUGIN_ARTIFACTS');
  await mkdir(join(directory,'packages'),{recursive:true});
  const targets=[];
  for(const file of artifacts){
    const digest=createHash('sha256').update(await readFile(file)).digest('hex');
    targets.push('file:packages/'+digest+'.tgz');
    await copyFile(file,join(directory,'packages',digest+'.tgz'));
  }
  const home=join(directory,'.installer-home'),bin=join(directory,'.installer-bin');
  await mkdir(join(home,'profiles'),{recursive:true});await mkdir(bin);
  await symlink(directory,join(home,'profiles/prepared'),process.platform==='win32'?'junction':'dir');
  const wrapper=join(bin,'pnpm-driver.cjs');
  // Normal updates resolve once; only foreign store/layout metadata needs relocation first.
  await writeFile(wrapper,`const {spawn}=require('node:child_process');
const run=args=>new Promise((resolve,reject)=>{
 const child=spawn(process.env.GEA_INSTALL_NODE,[process.env.GEA_INSTALL_PNPM,...args],{stdio:['ignore','pipe','pipe']});let output='';
 for(const [stream,destination] of [[child.stdout,process.stdout],[child.stderr,process.stderr]])stream.on('data',chunk=>{destination.write(chunk);output=(output+chunk).slice(-65536);});
 child.once('error',reject);child.once('close',status=>resolve({status,output}));
});
(async()=>{
 const add=['add',...JSON.parse(process.env.GEA_INSTALL_TARGETS),'--ignore-scripts','--save-exact','--prefer-offline'];
 let result=await run(add);
 if(result.status!==0&&/ERR_PNPM_(UNEXPECTED_STORE|VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF|UNEXPECTED_VIRTUAL_STORE)/.test(result.output)){
  result=await run(['install','--ignore-scripts','--prefer-offline','--no-frozen-lockfile']);
  if(result.status===0)result=await run(add);
 }
 process.exitCode=result.status??1;
})().catch(error=>{console.error(error);process.exitCode=1;});`);
  await writeFile(join(bin,'pnpm'),`#!/bin/sh\nexec "$GEA_INSTALL_NODE" "$GEA_INSTALL_DRIVER"\n`,{mode:0o755});
  await writeFile(join(bin,'pnpm.cmd'),'@echo off\r\n"%GEA_INSTALL_NODE%" "%GEA_INSTALL_DRIVER%"\r\n');
  const cli=join(directory,'node_modules/@deepseek-ai/dsh/lib/bin.js');
  try {
    await new Promise((resolve,reject)=>{
      const installEnv={...process.env};delete installEnv.GEA_RELEASE_TOKEN;delete installEnv.GEA_DESKTOP_CONTROL_TOKEN;
      delete installEnv.GEA_LAYERED_GRAPH;delete installEnv.GEA_LAYERED_CORE;
      const child=spawn(node,[cli,'plugin','--profile','prepared','add',...targets],{
        cwd:directory,detached:process.platform!=='win32',windowsHide:true,stdio:['ignore','pipe','pipe'],
        env:{...installEnv,DSH_HOME:home,PATH:bin+(process.platform==='win32'?';':':')+dirname(node),GEA_INSTALL_NODE:node,GEA_INSTALL_PNPM:pnpm,GEA_INSTALL_DRIVER:wrapper,GEA_INSTALL_TARGETS:JSON.stringify(targets),CI:'true'},
      });
      const registered=Promise.resolve().then(()=>onProcess(child.pid));
      let cancelled=false;
      let stopped=Promise.resolve();
      const cancel=()=>{
        cancelled=true;
        if(!child.pid)return;
        if(process.platform==='win32')stopped=new Promise(done=>{
          const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
          killer.once('error',done);killer.once('close',done);
        });
        else {try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')reject(error);}}
      };
      void registered.catch(cancel);
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)cancel();
      child.once('error',error=>{signal?.removeEventListener('abort',cancel);reject(error);});
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>onProgress(chunk.toString().replace(/https?:\/\/\S+/g,'[package source]')));
      child.once('close',async code=>{
        signal?.removeEventListener('abort',cancel);await stopped;
        try{await registered;}catch(error){reject(error);return;}
        if(cancelled)reject(Error(deadline.aborted?'PLUGIN_INSTALL_TIMEOUT':'PLUGIN_INSTALL_CANCELLED'));
        else if(code===0)resolve();else reject(Error('PLUGIN_INSTALL_FAILED_'+code));
      });
    });
    const require=createRequire(manifestPath);
    await verifyOfficialVersions(directory, official, Object.keys(manifest.dependencies ?? {}));
    const cordis=require.resolve('@deepseek-ai/cordis');
    for(const name of Object.keys(JSON.parse(await readFile(manifestPath,'utf8')).dependencies??{}).filter(name=>name.startsWith('@cleverc2200/')||['dsh-plugin','dsh-agent-manage','dsh-agent-plugins-market'].includes(name))) {
      const pluginRequire=createRequire(require.resolve(name+'/package.json'));
      if(pluginRequire.resolve('@deepseek-ai/cordis')!==cordis)throw Error('SHARED_CORDIS_MISMATCH');
    }
    if(optimizedBaseline)await restoreClientArtifacts(directory,optimizedBaseline);
  } finally {
    await rm(home,{recursive:true,force:true});await rm(bin,{recursive:true,force:true});
  }
}

/** Reuse build outputs only when pnpm materialized exactly the source that produced them. */
async function restoreClientArtifacts(directory,baseline) {
  let receipt;
  try {receipt=JSON.parse(await readFile(join(baseline,'client-artifacts.json'),'utf8'));}
  catch(error){if(error.code==='ENOENT')return;throw error;}
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const modules=await realpath(join(directory,'node_modules'));
  for(const record of receipt.files){
    let source=resolve(baseline,record.file);const target=resolve(directory,record.file);
    if(!source.startsWith(resolve(baseline,'node_modules')+sep)||!target.startsWith(resolve(directory,'node_modules')+sep)||![record.beforeSha256,record.afterSha256].every(value=>/^[a-f0-9]{64}$/.test(value)))throw Error('CLIENT_ARTIFACT_RECEIPT_INVALID');
    let installed;
    try {
      if(!(await realpath(target)).startsWith(modules+sep))throw Error('CLIENT_ARTIFACT_PATH_INVALID');
      installed=await readFile(target);
    }catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(![record.beforeSha256,record.afterSha256].includes(digest(installed)))continue;
    let baselineModules=await realpath(join(baseline,'node_modules'));
    try{await readFile(source);}catch(error){
      if(error.code!=='ENOENT')throw error;
      source=join(baseline,'node_modules.asar',record.file);
      baselineModules=await realpath(join(baseline,'node_modules.asar','node_modules'));
    }
    const optimized=await readFile(source);
    if(digest(optimized)!==record.afterSha256)throw Error('CLIENT_ARTIFACT_DIGEST_MISMATCH');
    if(!(await realpath(source)).startsWith(baselineModules+sep)||!(await realpath(source+'.map')).startsWith(baselineModules+sep))throw Error('CLIENT_ARTIFACT_PATH_INVALID');
    await unlink(target);
    await writeFile(target,optimized,{flag:'wx'});
    await rm(target+'.map',{force:true});
    await copyFile(source+'.map',target+'.map');
  }
}

/** Retained SDK packages must stay pinned; obsolete transitive SDKs may be pruned by pnpm. */
export async function verifyOfficialVersions(directory, official, required) {
  const require=createRequire(join(directory,'package.json'));
  for(const [name,version] of Object.entries(official)) {
    let path;
    try {path=require.resolve(name+'/package.json');}
    catch(error) {
      if(error.code==='MODULE_NOT_FOUND'&&!required.includes(name))continue;
      throw error;
    }
    if(JSON.parse(await readFile(path,'utf8')).version!==version)throw Error('RUNTIME_VERSION_CHANGED');
  }
}

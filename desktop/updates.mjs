/** Desktop owner coordinates channel checks and immutable preparation; never reloads a live Agent. */
import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const errorCode=error=>/^[A-Z][A-Z_0-9]+$/.test(error?.message)?error.message:'UPDATE_FAILED';
export async function createUpdates({data,store,desktopVersion,releases,install,restart,sources,token}) {
  const path=join(data,'plugins/update-state.json');await mkdir(join(data,'plugins'),{recursive:true});
  let state={settings:{automatic:true,intervalHours:24,channel:'stable'},history:{},phase:'idle',releases:[]};
  try{state={...state,...JSON.parse(await readFile(path,'utf8'))};}catch(error){if(error.code!=='ENOENT')throw Error('UPDATE_STATE_INVALID');}
  if(['downloading','installing'].includes(state.phase))state={...state,phase:'failed',error:'PREPARATION_INTERRUPTED'};
  let checking,checkAbort,preparing,abort,timer,restartTimer,restartTask,closed=false,writes=Promise.resolve();
  const save=()=>{const bytes=JSON.stringify(state,null,2);const next=writes.catch(()=>{}).then(async()=>{const temp=path+'.'+randomUUID();await writeFile(temp,bytes,{mode:0o600});await rename(temp,path);});writes=next;return next;};
  const versions=async()=>{
    const selected=await store.selected();const require=createRequire(join(selected.path,'package.json'));const manifest=JSON.parse(await readFile(join(selected.path,'package.json'),'utf8'));const result={};
    for(const name of Object.keys(manifest.dependencies??{}))result[name]=JSON.parse(await readFile(require.resolve(name+'/package.json'),'utf8')).version;
    return result;
  };
  const status=async()=>{
    return {...state,current:await versions(),checking:Boolean(checking)};
  };
  const check=()=>{
    if(closed)return Promise.resolve({error:'DESKTOP_CLOSING'});
    if(checking)return checking;
    if(preparing||state.phase==='restarting')return Promise.resolve({error:'UPDATE_BUSY'});
    checkAbort=new AbortController();
    checking=(async()=>{
      const current=await versions();const channel=state.settings.channel;
      try{
        const result=await releases.fetchCompanyChannel(sources[channel],channel,{dsh:current['@deepseek-ai/dsh'],workbench:current['@cleverc2200/dsh-agent-workbench'],desktop:desktopVersion},{token,signal:AbortSignal.any([checkAbort.signal,AbortSignal.timeout(60000)])});
        state.history=releases.verifyReleaseHistory(result,state.history);state.releases=result.releases;state.lastCheck=new Date().toISOString();state.checkError=null;
      }catch(error){state.releases=[];state.lastCheck=new Date().toISOString();state.checkError=errorCode(error);}
      await save();return status();
    })().finally(()=>{checking=undefined;});
    return checking;
  };
  const schedule=()=>{clearInterval(timer);if(state.settings.automatic){timer=setInterval(()=>void check().catch(()=>{}),state.settings.intervalHours*3600000);timer.unref();}};
  const settings=async value=>{
    if(checking||preparing||state.phase==='restarting')throw Error('UPDATE_BUSY');
    if(typeof value.automatic!=='boolean'||!Number.isInteger(value.intervalHours)||value.intervalHours<1||value.intervalHours>168||!['stable','test'].includes(value.channel))throw Error('INVALID_UPDATE_SETTINGS');
    if(value.channel!==state.settings.channel)state.releases=[];
    state.settings={automatic:value.automatic,intervalHours:value.intervalHours,channel:value.channel};await save();schedule();return status();
  };
  const prepare=async value=>{
    if(closed||preparing||checking||['pending','restarting'].includes(state.phase))return {error:'UPDATE_BUSY'};
    const release=state.releases.find(entry=>entry.package===value.package);
    if(!release||state.checkError)throw Error('CHECK_RELEASE_FIRST');
    const current=await versions();
    releases.validateReleaseChannel({schema:1,channel:state.settings.channel,releases:[release]},state.settings.channel,{dsh:current['@deepseek-ai/dsh'],workbench:current['@cleverc2200/dsh-agent-workbench'],desktop:desktopVersion});
    if(current[release.package]===release.version)return {error:'ALREADY_CURRENT'};
    if(closed||preparing||checking||['pending','restarting'].includes(state.phase))return {error:'UPDATE_BUSY'};
    // Reserve before asynchronous download; duplicate requests share one operation.
    state.phase='downloading';state.target={package:release.package,version:release.version};state.error=null;abort=new AbortController();
    const id='channel-'+randomUUID();state.pending=id;
    preparing=(async()=>{
      const artifact=join(data,'plugins',id+'.tgz');
      try{
        await save();const bytes=await releases.fetchReleasePackage(release,{token,signal:AbortSignal.any([abort.signal,AbortSignal.timeout(60000)])});
        await writeFile(artifact,bytes,{mode:0o600});if(abort.signal.aborted)throw Error('UPDATE_CANCELLED');
        state.phase='installing';await save();
        const receipt=await store.prepare({id,install:async(directory,owner)=>{
          await install(directory,artifact,abort.signal,owner.registerProcess);
          const require=createRequire(join(directory,'package.json'));const actual=JSON.parse(await readFile(require.resolve(release.package+'/package.json'),'utf8'));
          if(actual.version!==release.version)throw Error('RELEASE_PACKAGE_VERSION_MISMATCH');
        }});
        if(receipt.versions[release.package]!==release.version)throw Error('RELEASE_PACKAGE_VERSION_MISMATCH');
        state.phase=abort.signal.aborted?'cancelled':'pending';
      }catch(error){state.phase=abort.signal.aborted?'cancelled':'failed';state.error=errorCode(error);}
      finally{await rm(artifact,{force:true});await save();}
    })().finally(()=>{preparing=undefined;abort=undefined;});
    void preparing.catch(()=>{});return {accepted:true};
  };
  schedule();
  return {
    status,check,settings,prepare,
    cancel:async()=>{abort?.abort();if(state.phase==='pending'){state.phase='cancelled';await save();}return {ok:true};},
    restart:async()=>{if(state.phase!=='pending'||preparing)throw Error('NO_PREPARED_UPDATE');state.phase='restarting';await save();restartTimer=setTimeout(()=>{if(closed)return;restartTask=restart(state.pending).then(async()=>{const selected=await store.status();state.phase=selected.active===state.pending&&selected.verified===state.pending&&!selected.booting?'succeeded':'failed';state.error=state.phase==='failed'?'UPDATE_ROLLED_BACK':null;await save();}).catch(async error=>{state.phase='failed';state.error=errorCode(error);await save();});},100);return {ok:true};},
    start:async()=>{if(state.phase==='restarting'){const selection=await store.status();state.phase=selection.active===state.pending&&!selection.booting?'succeeded':'failed';state.error=state.phase==='failed'?'UPDATE_ROLLED_BACK':null;await save();}if(state.settings.automatic)void check().catch(()=>{});},
    close:async()=>{closed=true;clearInterval(timer);clearTimeout(restartTimer);abort?.abort();checkAbort?.abort();await preparing;await checking;await restartTask;await writes;},
  };
}

/** The desktop owns installer downloads; the renderer never chooses URLs or local paths. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createInstallerCache,installerFileName,validCachedFile} from './installer-cache.mjs';
import {differentialDescriptor,decodeBlockmap} from './installer-blockmap.mjs';
import {verifyInstallerSignature} from './installer-signature.mjs';

const MAX_BYTES=1024*1024*1024;
const version=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CHANNEL_ATTEMPT_TIMEOUT_MS=15000;
/** 兼容版频道来源：单个地址，或按优先级排列的地址列表。 */
const channelCandidates=value=>Array.isArray(value)?value.filter(item=>typeof item==='string'&&item.length>0):typeof value==='string'&&value.length>0?[value]:[];
const fail=code=>{throw Error(code);};
export function validateInstallerManifest(value,source,channel,platform,arch) {
  if(value?.schema!==1||value.channel!==channel||!version.test(value.release?.version??''))fail('INVALID_DESKTOP_MANIFEST');
  const release=value.release;
  if(!release.notes||!['zh','en'].every(key=>typeof release.notes[key]==='string'&&release.notes[key].trim())||!Array.isArray(release.artifacts)||release.artifacts.length>8)fail('INVALID_DESKTOP_MANIFEST');
  const origin=new URL(source),prefix=origin.pathname.split('/raw/')[0]+'/raw/';
  const seen=new Set();
  for(const artifact of release.artifacts){
    const key=artifact.platform+'-'+artifact.arch;
    if(!['darwin-arm64','win32-x64'].includes(key)||seen.has(key))fail('INVALID_DESKTOP_PLATFORM');
    seen.add(key);
    const suffix=key==='darwin-arm64'?'mac-arm64.dmg':'win-x64.exe';
    const filename=`GEA-Desktop-${release.version}-${suffix}`;
    if(!Number.isSafeInteger(artifact.bytes)||artifact.bytes<=0||artifact.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(artifact.sha256))fail('INVALID_DESKTOP_ARTIFACT');
    let url;try{url=new URL(artifact.url);}catch{fail('INVALID_DESKTOP_URL');}
    if(url.origin!==origin.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix))fail('INVALID_DESKTOP_URL');
    const path=url.pathname.slice(prefix.length);
    if(!/^[a-f0-9]{40}\//.test(path)||path.slice(41)!=='desktop/'+filename)fail('INVALID_DESKTOP_URL');
  }
  return {version:release.version,notes:{zh:release.notes.zh,en:release.notes.en},artifact:release.artifacts.find(a=>a.platform===platform&&a.arch===arch)??null};
}
const newer=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]>y[i];}return false;};
async function fileDigest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}

export function createClientInstaller({data,currentVersion,platform=process.platform,arch=process.arch,sources,openPath,fetchImpl=fetch,idleTimeoutMs=60000,trust,verifySignature=verifyInstallerSignature,reconstruct,requestFactory,cacheOptions}) {
  let state={supported:true,currentVersion,platform,arch,channel:'stable',checkSource:null,phase:'idle',checking:false,downloadedBytes:0,error:null};
  let selected,ready,work,controller,closed=false;
  const cache=createInstallerCache(data,cacheOptions),shown=new Set();
  const status=()=>({...state,release:selected?{version:selected.version,notes:selected.notes,bytes:selected.artifact?.bytes??0,platformSupported:Boolean(selected.artifact)}:null,updateAvailable:!!selected&&newer(selected.version,currentVersion)});
  const request=async(url,signal)=>{const response=await fetchImpl(url,{signal,redirect:'error',headers:{Accept:'application/octet-stream'}});if(!response.ok||!response.body){await response.body?.cancel().catch(()=>{});fail('DESKTOP_DOWNLOAD_HTTP');}return response;};
  const transfer=async(url,signal,limit,onChunk)=>{
    const idle=new AbortController();let timer,size=0;
    const touch=()=>{clearTimeout(timer);timer=setTimeout(()=>idle.abort(Error('DESKTOP_DOWNLOAD_IDLE_TIMEOUT')),idleTimeoutMs);};
    touch();
    try{
      const response=await request(url,AbortSignal.any([signal,idle.signal]));touch();
      for await(const chunk of response.body){signal.throwIfAborted();touch();size+=chunk.length;if(size>limit)fail('DESKTOP_INSTALLER_SIZE_MISMATCH');await onChunk(chunk);}
      return size;
    }catch(error){if(idle.signal.aborted)throw idle.signal.reason;throw error;}
    finally{clearTimeout(timer);idle.abort();}
  };
  const blockmap=async(artifact,signal)=>{
    const d=differentialDescriptor(artifact);if(!d)return null;
    const chunks=[];await transfer(d.blockmap.url,signal,d.blockmap.bytes,chunk=>chunks.push(chunk));
    const bytes=Buffer.concat(chunks);return {bytes,map:decodeBlockmap(bytes,artifact)};
  };
  const check=async({channel='stable'}={})=>{
    if(closed||work||state.checking)fail('DESKTOP_INSTALLER_BUSY');
    if(ready&&state.phase==='ready')return status();
    const candidates=channelCandidates(sources?.[channel]);
    if(!['stable','test'].includes(channel)||!candidates.length)fail('INVALID_DESKTOP_CHANNEL');
    state={...state,channel,checking:true,error:null};
    controller=new AbortController();
    work=(async()=>{
      try{
        // 兼容版频道读取：一个频道可以有多个来源，按顺序尝试；清单里的产物地址按命中的那个来源校验。
        let next,failure;
        for(const candidate of candidates){
          try{
            const response=await request(candidate,AbortSignal.any([controller.signal,AbortSignal.timeout(CHANNEL_ATTEMPT_TIMEOUT_MS)]));
            const chunks=[];let size=0;
            for await(const chunk of response.body){size+=chunk.length;if(size>65536)fail('INVALID_DESKTOP_MANIFEST');chunks.push(chunk);}
            next=validateInstallerManifest(JSON.parse(Buffer.concat(chunks).toString()),candidate,channel,platform,arch);
            state.checkSource=candidate;
            break;
          }catch(error){
            failure=error;
            // 主动取消（关闭应用）不算来源不可用，不再继续尝试后面的来源。
            if(controller.signal.aborted)break;
          }
        }
        if(!next)throw failure;
        if(ready?.sha256!==next.artifact?.sha256){ready=undefined;state.phase='idle';state.downloadedBytes=0;}
        selected=next;
      }catch(error){selected=undefined;ready=undefined;state.checkSource=null;state.phase='failed';state.error=error.message;}
      finally{state.checking=false;}
    })().finally(()=>{work=undefined;controller=undefined;});
    await work;return status();
  };
  const download=async({version:requestedVersion}={})=>{
    if(closed||work||state.checking)fail('DESKTOP_INSTALLER_BUSY');
    if(!selected?.artifact)fail('DESKTOP_INSTALLER_UNAVAILABLE');
    if(requestedVersion!==undefined&&requestedVersion!==selected.version)fail('DESKTOP_INSTALLER_TARGET_CHANGED');
    const artifact=selected.artifact;
    controller=new AbortController();const signal=controller.signal;
    state={...state,phase:'downloading',downloadedBytes:0,networkBytes:0,downloadMode:'full',signature:null,error:null};ready=undefined;
    let outcome;
    work=(async()=>{
      const directory=cache.directory,part=join(directory,randomUUID()+'.part');
      let file,newMap;
      try{
        await cache.ensure();
        const cached=await cache.find(artifact);
        if(cached){
          state.phase='verifying';state.signature=await verifySignature(cached,{platform,trust,signal});signal.throwIfAborted();
          ready={path:cached,sha256:artifact.sha256};state.downloadedBytes=artifact.bytes;state.downloadMode='cache';outcome={phase:'ready',error:null};return;
        }
        try{newMap=await blockmap(artifact,signal);}catch(error){if(signal.aborted)throw error;state.differentialFallback='blockmap-unavailable';}
        let rebuilt=false;
        const base=newMap?await cache.base(artifact):null;
        if(base){
          try{
            const oldMap=decodeBlockmap(base.map,base.artifact);
            const run=reconstruct??(await import('./download-differential.cjs')).reconstructInstaller;
            state.downloadMode='differential';
            const result=await run({artifact,oldFile:base.path,newFile:part,oldMap,newMap:newMap.map,signal,idleTimeoutMs,requestFactory,onProgress:info=>{state.networkBytes=info.networkBytes;state.downloadedBytes=info.networkBytes;}});
            state.networkBytes=result.networkBytes;rebuilt=true;
          }catch(error){
            if(signal.aborted||['ENOSPC','EACCES','EPERM'].includes(error.code))throw error;
            state.differentialFallback='reconstruction-failed';await rm(part,{force:true});
          }
        }
        if(!rebuilt){
          state.downloadMode='full';state.downloadedBytes=0;
          file=await open(part,'wx',0o600);
          await transfer(artifact.url,signal,artifact.bytes,async chunk=>{state.downloadedBytes+=chunk.length;state.networkBytes+=chunk.length;await file.writeFile(chunk);});
          await file.sync();await file.close();file=undefined;
        }
        state.phase='verifying';
        if(!await validCachedFile(part,artifact))fail('DESKTOP_INSTALLER_CHECKSUM_MISMATCH');
        state.signature=await verifySignature(part,{platform,trust,signal});signal.throwIfAborted();
        const path=join(directory,installerFileName(artifact));
        await rename(part,path);
        await cache.save(artifact,newMap?.bytes);
        await cache.collect([...shown,installerFileName(artifact)],{signal});
        signal.throwIfAborted();ready={path,sha256:artifact.sha256};outcome={phase:'ready',error:null};
        state.downloadedBytes=artifact.bytes;
      }catch(error){outcome={phase:signal.aborted?'cancelled':'failed',error:signal.aborted?null:error.message};}
      finally{await file?.close();await rm(part,{force:true});}
    })().finally(()=>{if(controller?.signal.aborted&&outcome?.phase==='ready'){ready=undefined;outcome={phase:'cancelled',error:null};}work=undefined;controller=undefined;if(outcome)state={...state,...outcome};});
    void work.catch(()=>{state.phase='failed';state.error='DESKTOP_DOWNLOAD_FAILED';});
    return {accepted:true};
  };
  const openInstaller=async()=>{
    if(closed||work)fail('DESKTOP_INSTALLER_BUSY');
    if(!ready||state.phase!=='ready')fail('DESKTOP_INSTALLER_NOT_READY');
    state.phase='opening';const file=ready;
    work=(async()=>{
      try{
        if(await fileDigest(file.path)!==file.sha256)fail('DESKTOP_INSTALLER_CHECKSUM_MISMATCH');
        state.signature=await verifySignature(file.path,{platform,trust});
        shown.add(installerFileName(selected.artifact));
        const error=await openPath(file.path);if(error)fail('DESKTOP_INSTALLER_OPEN_FAILED');
        state.phase='ready';return {ok:true};
      }catch(error){state.phase='failed';state.error=error.message;ready=undefined;throw error;}
    })().finally(()=>{work=undefined;});
    return work;
  };
  return {status,check,download,open:openInstaller,cancel:()=>{if(['downloading','verifying'].includes(state.phase))controller?.abort();return {ok:true};},close:async()=>{closed=true;controller?.abort();await work?.catch(()=>{});}};
}

/** The desktop owns installer downloads; the renderer never chooses URLs or local paths. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';

const MAX_BYTES=1024*1024*1024;
const version=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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

export function createClientInstaller({data,currentVersion,platform=process.platform,arch=process.arch,sources,openPath,fetchImpl=fetch}) {
  let state={supported:true,currentVersion,platform,arch,channel:'stable',phase:'idle',checking:false,downloadedBytes:0,error:null};
  let selected,ready,work,controller,closed=false;
  const status=()=>({...state,release:selected?{version:selected.version,notes:selected.notes,bytes:selected.artifact?.bytes??0,platformSupported:Boolean(selected.artifact)}:null,updateAvailable:!!selected&&newer(selected.version,currentVersion)});
  const request=async(url,signal)=>{const response=await fetchImpl(url,{signal,redirect:'error',headers:{Accept:'application/octet-stream'}});if(!response.ok||!response.body)fail('DESKTOP_DOWNLOAD_HTTP');return response;};
  const check=async({channel='stable'}={})=>{
    if(closed||work||state.checking)fail('DESKTOP_INSTALLER_BUSY');
    if(!['stable','test'].includes(channel)||!sources[channel])fail('INVALID_DESKTOP_CHANNEL');
    state={...state,channel,checking:true,error:null};
    controller=new AbortController();
    work=(async()=>{
      try{
        const response=await request(sources[channel],AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]));
        const chunks=[];let size=0;
        for await(const chunk of response.body){size+=chunk.length;if(size>65536)fail('INVALID_DESKTOP_MANIFEST');chunks.push(chunk);}
        const next=validateInstallerManifest(JSON.parse(Buffer.concat(chunks).toString()),sources[channel],channel,platform,arch);
        if(ready?.sha256!==next.artifact?.sha256){ready=undefined;state.phase='idle';state.downloadedBytes=0;}
        selected=next;
      }catch(error){selected=undefined;ready=undefined;state.phase='failed';state.error=error.message;}
      finally{state.checking=false;}
    })().finally(()=>{work=undefined;controller=undefined;});
    await work;return status();
  };
  const download=async()=>{
    if(closed||work||state.checking)fail('DESKTOP_INSTALLER_BUSY');
    if(!selected?.artifact)fail('DESKTOP_INSTALLER_UNAVAILABLE');
    const artifact=selected.artifact;
    controller=new AbortController();const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10*60*1000)]);
    state={...state,phase:'downloading',downloadedBytes:0,error:null};ready=undefined;
    let outcome;
    work=(async()=>{
      const directory=join(data,'desktop-downloads'),part=join(directory,randomUUID()+'.part');
      let file;
      try{
        await mkdir(directory,{recursive:true,mode:0o700});
        file=await open(part,'wx',0o600);
        const response=await request(artifact.url,signal),hash=createHash('sha256');
        for await(const chunk of response.body){
          signal.throwIfAborted();state.downloadedBytes+=chunk.length;
          if(state.downloadedBytes>artifact.bytes)fail('DESKTOP_INSTALLER_SIZE_MISMATCH');
          hash.update(chunk);await file.writeFile(chunk);
        }
        state.phase='verifying';
        if(state.downloadedBytes!==artifact.bytes||hash.digest('hex')!==artifact.sha256)fail('DESKTOP_INSTALLER_CHECKSUM_MISMATCH');
        signal.throwIfAborted();await file.sync();await file.close();file=undefined;
        const path=join(directory,artifact.sha256+'-'+new URL(artifact.url).pathname.split('/').pop());
        await rename(part,path);ready={path,sha256:artifact.sha256};outcome={phase:'ready',error:null};
      }catch(error){outcome={phase:signal.aborted?'cancelled':'failed',error:signal.aborted?null:error.message};}
      finally{await file?.close();await rm(part,{force:true});}
    })().finally(()=>{work=undefined;controller=undefined;if(outcome)state={...state,...outcome};});
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
        const error=await openPath(file.path);if(error)fail('DESKTOP_INSTALLER_OPEN_FAILED');
        state.phase='ready';return {ok:true};
      }catch(error){state.phase='failed';state.error=error.message;ready=undefined;throw error;}
    })().finally(()=>{work=undefined;});
    return work;
  };
  return {status,check,download,open:openInstaller,cancel:()=>{if(['downloading','verifying'].includes(state.phase))controller?.abort();return {ok:true};},close:async()=>{closed=true;controller?.abort();await work?.catch(()=>{});}};
}

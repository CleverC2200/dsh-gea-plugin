import {mkdir,lstat,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,win32} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const owned=/^[a-f0-9]{64}-GEA-Desktop-\d+\.\d+\.\d+-(?:win-x64\.exe|mac-arm64\.dmg)$/;
const execute=promisify(execFile);
export const installerFileName=artifact=>artifact.sha256+'-'+new URL(artifact.url).pathname.split('/').pop();
export async function fileDigest(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function validCachedFile(path,artifact){
  try{const s=await lstat(path);return s.isFile()&&!s.isSymbolicLink()&&s.size===artifact.bytes&&await fileDigest(path)===artifact.sha256;}catch{return false;}
}
async function inUse(path){
  if(process.platform==='win32'){
    const command="$ErrorActionPreference='Stop'; $p=$env:GEA_CACHE_FILE; $v=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and $_.ExecutablePath -eq $p}); Write-Output ($v.Count -gt 0)";
    try{
      const exe=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const {stdout}=await execute(exe,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{env:{...process.env,GEA_CACHE_FILE:path},windowsHide:true,timeout:5000,maxBuffer:4096});
      return stdout.trim()!=='False';
    }catch{return true;}
  }
  try{const {stdout}=await execute('/usr/sbin/lsof',['-t','--',path],{timeout:3000,maxBuffer:4096});return Boolean(stdout.trim());}
  catch(error){return error.code!==1;}
}
export function createInstallerCache(data,{isInUse=inUse}={}){
  const directory=join(data,'desktop-downloads'),index=join(directory,'cache.json');
  const ensure=async()=>{await mkdir(directory,{recursive:true,mode:0o700});const s=await lstat(directory);if(!s.isDirectory()||s.isSymbolicLink())throw Error('DESKTOP_CACHE_UNSAFE');};
  const entries=async()=>{
    try{const s=await lstat(index);if(!s.isFile()||s.isSymbolicLink()||s.size>65536)return [];const raw=await readFile(index,'utf8');const value=JSON.parse(raw);return value.schema===1&&Array.isArray(value.entries)?value.entries.filter(e=>owned.test(e.file)&&e.file.startsWith(e.artifact?.sha256+'-')).slice(0,2):[];}
    catch{return [];}
  };
  return {
    directory,ensure,entries,
    async find(artifact){const file=installerFileName(artifact);if(!owned.test(file))throw Error('INVALID_DESKTOP_ARTIFACT');await ensure();const path=join(directory,file);return await validCachedFile(path,artifact)?path:null;},
    async base(artifact){
      for(const entry of await entries())if(entry.artifact.sha256!==artifact.sha256&&entry.artifact.platform===artifact.platform&&entry.artifact.arch===artifact.arch&&entry.artifact.differential&&await validCachedFile(join(directory,entry.file),entry.artifact)){
        try{const s=await lstat(join(directory,entry.file+'.blockmap'));if(!s.isFile()||s.isSymbolicLink())continue;return {...entry,path:join(directory,entry.file),map:await readFile(join(directory,entry.file+'.blockmap'))};}catch{}
      }
      return null;
    },
    async save(artifact,map){
      await ensure();const file=installerFileName(artifact);
      if(map){
        const sidecar=join(directory,file+'.blockmap'),temp=sidecar+'.'+randomUUID()+'.tmp';
        try{await writeFile(temp,map,{flag:'wx',mode:0o600});await rename(temp,sidecar);}finally{await rm(temp,{force:true});}
      }
      const value={schema:1,entries:[{file,artifact},...(await entries()).filter(e=>e.file!==file)].slice(0,2)};
      const temp=index+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(value),{flag:'wx',mode:0o600});await rename(temp,index);
    },
    async collect(pinned=[],{signal}={}){
      await ensure();const keep=new Set(pinned);for(const e of await entries())keep.add(e.file);
      const files=[];for(const e of await readdir(directory,{withFileTypes:true}))if(e.isFile()&&owned.test(e.name)){const s=await lstat(join(directory,e.name));files.push({name:e.name,time:s.mtimeMs});}
      // Legacy downloads have no receipt. Keep the newest two as well as pins.
      for(const f of files.sort((a,b)=>b.time-a.time).slice(0,2))keep.add(f.name);
      const removed=[],failed=[];
      for(const f of files){if(signal?.aborted)break;if(keep.has(f.name)||await isInUse(join(directory,f.name)))continue;if(signal?.aborted)break;
        try{await rm(join(directory,f.name));await rm(join(directory,f.name+'.blockmap'),{force:true});removed.push(f.name);}catch{failed.push(f.name);}
      }
      return {removed,failed};
    },
  };
}

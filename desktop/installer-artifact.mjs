/** Describe final signed bytes; never append a blockmap to or rewrite an EXE. */
import {createReadStream} from 'node:fs';
import {readFile,lstat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeBlockmap} from './installer-blockmap.mjs';

export async function describeInstaller(file,{url}={}){
  const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('INVALID_INSTALLER_FILE');
  const name=basename(file);const match=/^GEA-Desktop-(\d+\.\d+\.\d+)-(win-x64\.exe|mac-arm64\.dmg)$/.exec(name);
  if(!match)throw Error('INVALID_INSTALLER_FILENAME');
  const sha256=createHash('sha256'),sha512=createHash('sha512');for await(const bytes of createReadStream(file)){sha256.update(bytes);sha512.update(bytes);}
  const artifact={platform:match[2]==='win-x64.exe'?'win32':'darwin',arch:match[2]==='win-x64.exe'?'x64':'arm64',bytes:stat.size,sha256:sha256.digest('hex'),...(url?{url}:{file:name})};
  if(artifact.platform==='win32'){
    const map=await readFile(file+'.blockmap');
    const differential={algorithm:'electron-blockmap-v2',sha512:sha512.digest('base64'),blockmap:{...(url?{url:url+'.blockmap'}:{file:name+'.blockmap'}),bytes:map.length,sha256:createHash('sha256').update(map).digest('hex')}};
    decodeBlockmap(map,{...artifact,url:url??'https://build.invalid/'+name,differential:{...differential,blockmap:{...differential.blockmap,url:(url??'https://build.invalid/'+name)+'.blockmap'}}});
    artifact.differential=differential;
  }
  return {version:match[1],artifact};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const value=await describeInstaller(process.argv[2],{url:process.argv[3]});
  await writeFile(process.argv[2]+'.artifact.json',JSON.stringify(value,null,2)+'\n');console.log(JSON.stringify(value));
}

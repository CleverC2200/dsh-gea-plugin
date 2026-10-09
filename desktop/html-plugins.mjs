/** Install the published GEA HTML plugins into the desktop runtime and report their roots. */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {gunzipSync} from 'node:zlib';

// 兼容版频道来源：按顺序尝试，OSS 读不到时回退到公司 GitLab。
export const HTML_PLUGIN_CHANNELS=[
  'https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/channels/gea-html-preview.json',
  'http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/main/channels/gea-html-preview.json',
];
const CHANNEL_KIND='gea-html-v1';
const REQUEST_TIMEOUT_MS=15000;

function sha256(buffer){return createHash('sha256').update(buffer).digest('hex');}

async function download(url,fetchImpl,timeoutMs=REQUEST_TIMEOUT_MS){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{signal:controller.signal,cache:'no-store'});
    if(!response.ok)throw new Error(`HTML_PLUGIN_DOWNLOAD_${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }finally{clearTimeout(timer);}
}

function readString(buffer,offset,length){
  let end=offset;
  while(end<offset+length&&buffer[end]!==0)end++;
  return buffer.toString('utf8',offset,end);
}

function parsePax(buffer){
  const fields={};
  let offset=0;
  while(offset<buffer.length){
    const space=buffer.indexOf(0x20,offset);
    if(space<0)break;
    const length=Number(buffer.toString('utf8',offset,space));
    if(!Number.isInteger(length)||length<=0||offset+length>buffer.length)break;
    const record=buffer.toString('utf8',space+1,offset+length).replace(/\n$/,'');
    const split=record.indexOf('=');
    if(split>0)fields[record.slice(0,split)]=record.slice(split+1);
    offset+=length;
  }
  return fields;
}

/** Minimal ustar reader: plain files and directories, with pax path overrides. */
export function readTarGz(archive){
  const buffer=gunzipSync(archive);
  const entries=[];
  let offset=0;
  let pax={};
  while(offset+512<=buffer.length){
    const header=buffer.subarray(offset,offset+512);
    if(header.every(byte=>byte===0))break;
    const size=parseInt(readString(header,124,12).trim()||'0',8);
    if(!Number.isFinite(size)||size<0)throw new Error('HTML_PLUGIN_ARCHIVE_INVALID');
    const type=String.fromCharCode(header[156])||'0';
    const name=readString(header,0,100);
    const prefix=readString(header,345,155);
    offset+=512;
    const data=buffer.subarray(offset,offset+size);
    offset+=Math.ceil(size/512)*512;
    if(type==='x'||type==='g'){pax=parsePax(data);continue;}
    const path=pax.path??(prefix?`${prefix}/${name}`:name);
    pax={};
    if(type==='0'||type==='\0'||type==='')entries.push({path,data});
    else if(type==='5')entries.push({path,directory:true});
  }
  return entries;
}

async function extractArchive(archive,target){
  const root=resolve(target);
  for(const entry of readTarGz(archive)){
    const relative=entry.path.replace(/^package\//,'').replace(/\/$/,'');
    if(!relative)continue;
    const destination=resolve(root,relative);
    if(destination!==root&&!destination.startsWith(root+sep))throw new Error('HTML_PLUGIN_UNSAFE_PATH');
    if(entry.directory){await mkdir(destination,{recursive:true});continue;}
    await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,entry.data);
  }
}

export async function prepareHtmlPlugins({runtime,channelUrl=HTML_PLUGIN_CHANNELS,fetchImpl=globalThis.fetch,log=console.error}={}){
  const base=join(runtime,'html-plugins');
  const result={roots:{},installed:[],reused:[],failed:[]};
  const candidates=(Array.isArray(channelUrl)?channelUrl:[channelUrl]).filter(item=>typeof item==='string'&&item.length>0);
  let channel,failure;
  for(const candidate of candidates){
    try{
      const raw=await download(candidate,fetchImpl);
      const value=JSON.parse(raw.toString('utf8'));
      if(value?.kind!==CHANNEL_KIND||!Array.isArray(value.plugins))throw new Error('HTML_PLUGIN_CHANNEL_INVALID');
      channel=value;failure=undefined;break;
    }catch(error){failure=error;}
  }
  if(!channel){
    log(`[html-plugins] channel unavailable: ${failure?.message??failure}`);
    return result;
  }
  await mkdir(base,{recursive:true,mode:0o700});
  for(const plugin of channel.plugins){
    const id=plugin?.id;
    if(typeof id!=='string'||!/^[a-z0-9-]+$/.test(id)){result.failed.push({id:String(id),reason:'INVALID_ID'});continue;}
    const target=join(base,id);
    const marker=join(target,'.source.json');
    try{
      const installed=existsSync(marker)?JSON.parse(await readFile(marker,'utf8')):null;
      if(installed?.version===plugin.version&&installed?.sha256===plugin.sha256&&existsSync(join(target,'plugin.json'))){
        result.reused.push(id);
        result.roots[id]=target;
        continue;
      }
      const archive=await download(plugin.url,fetchImpl);
      const digest=sha256(archive);
      if(plugin.sha256&&digest!==plugin.sha256)throw new Error('HTML_PLUGIN_DIGEST_MISMATCH');
      const staging=join(base,`.staging-${id}`);
      await rm(staging,{recursive:true,force:true});
      await mkdir(staging,{recursive:true,mode:0o700});
      await extractArchive(archive,staging);
      if(!existsSync(join(staging,'plugin.json')))throw new Error('HTML_PLUGIN_MANIFEST_MISSING');
      await writeFile(join(staging,'.source.json'),JSON.stringify({id,version:plugin.version??null,sha256:digest,url:plugin.url??null},null,2)+'\n',{mode:0o600});
      await rm(target,{recursive:true,force:true});
      await rename(staging,target);
      result.installed.push(id);
      result.roots[id]=target;
    }catch(error){
      result.failed.push({id,reason:error?.message??String(error)});
      log(`[html-plugins] ${id} unavailable: ${error?.message??error}`);
    }
  }
  return result;
}

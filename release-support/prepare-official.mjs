import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
const root=import.meta.dirname;
const gea='/home/runner/work/dsh-gea-plugin/dsh-gea-plugin/candidate/dsh-gea-plugin';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const save=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const original=await read(join(root,'official-delivery','manifest.json'));
const baseline=await read(join(root,'deployed-baseline','baseline.json'));
const refs=[...baseline.channels.stable.releases,...baseline.channels.stable.companionReleases];
const origin='https://synear-gea.oss-cn-hangzhou.aliyuncs.com/plugin-release/packages/';
const current=new Map(await Promise.all(refs.map(async ref=>{
  assert(ref.url.startsWith(origin));
  const response=await fetch(ref.url,{redirect:'error',signal:AbortSignal.timeout(20000)});
  assert(response.ok);
  const data=Buffer.from(await response.arrayBuffer());
  assert.equal(sha(data),ref.sha256);
  const full=JSON.parse(data);
  assert.equal(full.name,ref.name);
  return [ref.name,{ref,full}];
})));
const suite=join(root,'release-suite');
const output=join(root,'official-release');
await mkdir(join(suite,'packages'),{recursive:true,mode:0o700});
await mkdir(output,{mode:0o700});
const supplies=[];
const paths=[];
for(const entry of original.packages){
  const summary=current.get(entry.name);
  assert(summary);
  const bytes=await readFile(join(root,'official-delivery','packages',entry.filename));
  assert.equal(sha(bytes),entry.sha256);
  const isWorkbench=entry.repo==='dsh-agent-workbench';
  const isGea=entry.repo==='dsh-gea-plugin';
  const isNew=entry.repo!=='dsh-agent-manage';
  const fixed=structuredClone(entry);
  const archive=join(suite,'packages',entry.filename);
  if(isNew){
    assert.equal(entry.version,({'dsh-agent-workbench':'0.1.183','dsh-agent-manage':'0.6.3-company.92','dsh-gea-plugin':'0.0.375'})[entry.repo]);
    await writeFile(archive,bytes,{mode:0o600});
  }else{
    const released=summary.full.artifact;
    assert.equal(summary.full.version,entry.version);
    assert.equal(new URL(released.url).pathname.split('/').at(-1),entry.filename);
    const deployed=join(root,'deployed-archives',released.sha256+'.tgz');
    const artifact=await readFile(deployed);
    assert.equal(sha(artifact),released.sha256);
    assert.equal(artifact.length,released.size);
    fixed.sha256=released.sha256;
    if(entry.repo==='dsh-agent-manage' && entry.sha256!==released.sha256){
      fixed.source={kind:'immutable-published-archive',path:entry.source.path,head:entry.source.head};
      delete fixed.sourceArchiveSha256;
      delete fixed.excludedProvenanceFiles;
    }
    await copyFile(deployed,archive);
  }
  supplies.push(fixed);
  const metadata=join(output,entry.repo+'.metadata.json');
  const previous=summary.full;
  const artifactUrl=isNew?origin+fixed.sha256+'/'+fixed.filename:previous.artifact.url;
  await save(metadata,{
    artifactUrl,
    supportedCores:previous.supportedCores,
    dataCompatibility:previous.dataCompatibility,
    notes:isWorkbench?'优化 MPS 工作台，自动恢复本地评估版本和第 6、7 步已有结果。':isGea?'兼容 Workbench 0.1.183 与 Manage 0.6.3-company.92。':previous.notes,
  });
  paths.push({
    source:{name:fixed.name,path:fixed.source.path,head:fixed.source.head,requiredCommits:isWorkbench?['3265d7703f13a671d8bea5aa794971e5bf3544d6',fixed.source.head]:entry.repo==='dsh-agent-manage'?['d0a270d21ab89d18e0a87a9fedcb86afa3934e33',fixed.source.head]:[fixed.source.head]},
    target:{archive,metadata}, artifactUrl, reuse:!isNew,
  });
}
const manifest=join(suite,'manifest.json');
await save(manifest,{...original,packages:supplies});
const environment=await read(join(root,'deployed-baseline','environment.json'));
const file=join(output,'preflight.json');
await save(file,{schemaVersion:1,deliveryManifest:manifest,sources:paths.map(p=>p.source),targets:paths.map(p=>p.target),deployed:baseline.deployed,environment});
const {runPluginReleasePreflight}=await import(gea+'/scripts/plugin-release-preflight.mjs');
const preflight=await runPluginReleasePreflight(file);
await save(join(output,'preflight-result.json'),preflight);
const releases=[];
for(const [index,item] of paths.entries()){
 const result=JSON.parse(execFileSync(process.execPath,[join(gea,'scripts/create-plugin-release.mjs'),'--archive',item.target.archive,'--metadata',item.target.metadata,'--preflight',file,'--destination',join(output,'projected-'+index)],{cwd:gea,encoding:'utf8'}));
 const release=preflight.targets[index].release;
 assert.equal(release.name,item.source.name);
 const url=origin+result.sha256+'/'+basename(result.path);
 if(item.reuse)assert.deepEqual({url,sha256:result.sha256},(({url,sha256})=>({url,sha256}))(current.get(release.name).ref),release.name);
 releases.push({name:release.name,version:release.version,path:result.path,sha256:result.sha256,url,archive:item.target.archive,artifactUrl:item.artifactUrl,artifactSha256:release.artifact.sha256,size:release.artifact.size,reused:item.reuse});
}
await save(join(output,'releases.json'),releases);
console.log(JSON.stringify(releases.map(({name,version,sha256,reused})=>({name,version,sha256,reused}))));

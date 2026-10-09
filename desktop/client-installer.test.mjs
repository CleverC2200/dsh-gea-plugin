import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createClientInstaller,validateInstallerManifest} from './client-installer.mjs';
const source='http://company.test/team/releases/raw/main/channels/desktop-stable.json';
const bytes=Buffer.from('installer fixture');
const digest=createHash('sha256').update(bytes).digest('hex');
const manifest=()=>({schema:1,channel:'stable',release:{version:'0.0.9',notes:{zh:'新版',en:'New'},artifacts:[{platform:'darwin',arch:'arm64',bytes:bytes.length,sha256:digest,url:`http://company.test/team/releases/raw/${'a'.repeat(40)}/desktop/GEA-Desktop-0.0.9-mac-arm64.dmg`}]}});
async function fixture(t,{fetchImpl,platform='darwin',arch='arm64',sources={stable:source},...options}={}){
 const data=await mkdtemp(join(tmpdir(),'gea-installer-test-'));let opened=[];
 const manager=createClientInstaller({data,currentVersion:'0.0.8',platform,arch,sources,openPath:async path=>{opened.push(path);return '';},fetchImpl:fetchImpl??(async url=>url===source?Response.json(manifest()):new Response(bytes)),...options});
 t.after(async()=>{await manager.close();await rm(data,{recursive:true,force:true});});
 return {manager,data,opened};
}
const wait=async(manager,phase)=>{for(let i=0;i<200;i++){if(manager.status().phase===phase)return;await new Promise(r=>setTimeout(r,5));}assert.equal(manager.status().phase,phase);};
test('verified download is streamed to disk and opens only on explicit request',async t=>{
 const {manager,opened}=await fixture(t);await manager.check();assert.equal(manager.status().updateAvailable,true);
 await assert.rejects(manager.open(),/NOT_READY/);await manager.download();await wait(manager,'ready');assert.equal(opened.length,0);
 assert.equal(manager.status().downloadedBytes,bytes.length);assert.equal('path' in manager.status(),false);
 await manager.open();assert.equal(opened.length,1);assert.deepEqual(await readFile(opened[0]),bytes);
 await writeFile(opened[0],'tampered');await assert.rejects(manager.open(),/CHECKSUM/);assert.equal(opened.length,1);
});
test('bad checksum and oversized response cannot become installers',async t=>{
 for(const bad of [Buffer.from('corrupt'),Buffer.alloc(bytes.length+1)]){
 const {manager,data,opened}=await fixture(t,{fetchImpl:async url=>url===source?Response.json(manifest()):new Response(bad)});
 await manager.check();await manager.download();await wait(manager,'failed');assert.deepEqual(await readdir(join(data,'desktop-downloads')),[]);assert.equal(opened.length,0);
 await assert.rejects(manager.open(),/NOT_READY/);
 }
});
test('cancel aborts download, deletes partial files and allows retry',async t=>{
 let slow=true;
 const {manager,data}=await fixture(t,{fetchImpl:async(url,{signal})=>{
  if(url===source)return Response.json(manifest());if(!slow)return new Response(bytes);
  return new Response(new ReadableStream({start(controller){signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}}));
 }});
 await manager.check();await manager.download();await assert.rejects(manager.download(),/BUSY/);
 await new Promise(r=>setTimeout(r,10));manager.cancel();await wait(manager,'cancelled');assert.deepEqual(await readdir(join(data,'desktop-downloads')),[]);
 slow=false;await manager.download();await wait(manager,'ready');
});
test('an HTTP error cancels its streaming body',async t=>{
 let cancelled=false;
 const {manager}=await fixture(t,{fetchImpl:async url=>url===source?Response.json(manifest()):new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:503})});
 await manager.check();await manager.download();await wait(manager,'failed');assert.equal(cancelled,true);
});
test('idle timeout stops a stalled transfer and removes partial bytes',async t=>{
 const {manager,data}=await fixture(t,{idleTimeoutMs:30,fetchImpl:async(url,{signal})=>{
  if(url===source)return Response.json(manifest());
  return new Response(new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,3));signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});}}));
 }});
 await manager.check();await manager.download();await wait(manager,'failed');
 assert.equal(manager.status().error,'DESKTOP_DOWNLOAD_IDLE_TIMEOUT');assert.deepEqual(await readdir(join(data,'desktop-downloads')),[]);
});
test('cancelling during publisher verification cannot become ready',async t=>{
 let release;
 const {manager,opened}=await fixture(t,{verifySignature:()=>new Promise(r=>{release=r;})});
 await manager.check();await manager.download();await wait(manager,'verifying');
 for(let i=0;i<200&&!release;i++)await new Promise(r=>setTimeout(r,5));assert.ok(release);
 manager.cancel();release({verified:true});await wait(manager,'cancelled');
 await assert.rejects(manager.open(),/NOT_READY/);assert.deepEqual(opened,[]);
});
test('manifest rejects wrong origin, mutable paths, traversal, platform, channel and size',()=>{
 for(const change of [m=>m.channel='test',m=>m.release.artifacts[0].url='https://evil.test/a.dmg',m=>m.release.artifacts[0].url=m.release.artifacts[0].url.replace('a'.repeat(40),'main'),m=>m.release.artifacts[0].url+='?token=x',m=>m.release.artifacts[0].bytes=2**40,m=>m.release.artifacts.push(m.release.artifacts[0]),m=>m.release.artifacts[0].url=m.release.artifacts[0].url.replace('desktop/','desktop/../')]){
  const m=manifest();change(m);assert.throws(()=>validateInstallerManifest(m,source,'stable','darwin','arm64'));
 }
 assert.equal(validateInstallerManifest(manifest(),source,'stable','linux','x64').artifact,null);
});
test('unsupported platform and unavailable manifest produce actionable state without downloads',async t=>{
 const {manager}=await fixture(t,{platform:'linux',arch:'x64'});await manager.check();assert.equal(manager.status().release.platformSupported,false);await assert.rejects(manager.download(),/UNAVAILABLE/);
 const f=await fixture(t,{fetchImpl:async()=>new Response('',{status:404})});await f.manager.check();assert.equal(f.manager.status().phase,'failed');assert.equal(f.manager.status().checking,false);
});

// 兼容版频道来源：一个频道可以有多个地址，按顺序尝试，前一个读不到才用下一个。
test('installer channel prefers the first source and falls back to the next one only when it fails',async t=>{
 const candidates=['https://oss.test/client-release/raw/channels/desktop-stable.json',source];
 const seen=[];
 const fetchImpl=async url=>{seen.push(url);if(url===candidates[0])return new Response('',{status:404});return url===source?Response.json(manifest()):new Response(bytes);};
 const {manager}=await fixture(t,{fetchImpl,sources:{stable:candidates}});
 await manager.check();
 assert.deepEqual(seen,candidates);
 assert.equal(manager.status().checkSource,source);
 assert.equal(manager.status().updateAvailable,true);
});

test('a broken installer channel reports the last error and offers nothing',async t=>{
 const candidates=['https://oss.test/a.json','https://oss.test/b.json'];
 const {manager}=await fixture(t,{fetchImpl:async()=>new Response('',{status:503}),sources:{stable:candidates}});
 await manager.check();
 assert.equal(manager.status().phase,'failed');
 assert.equal(manager.status().checkSource,null);
 assert.equal(manager.status().release,null);
 assert.equal(manager.status().updateAvailable,false);
});

test('a single installer channel address still works without a fallback list',async t=>{
 const seen=[];const {manager}=await fixture(t,{fetchImpl:async url=>{seen.push(url);return url===source?Response.json(manifest()):new Response(bytes);}});
 await manager.check();
 assert.deepEqual(seen,[source]);
 assert.equal(manager.status().checkSource,source);
});

// OSS 上的安装包沿用“不可变 raw 路径”，客户端校验规则不用放宽。
test('an oss installer channel keeps the immutable raw layout that binds artifacts to its own origin',()=>{
 const ossSource='https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/channels/desktop-stable.json';
 const ossManifest={schema:1,channel:'stable',release:{version:'0.0.18',notes:{zh:'新版',en:'New'},artifacts:[{platform:'darwin',arch:'arm64',bytes:bytes.length,sha256:digest,url:`https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/raw/${'b'.repeat(40)}/desktop/GEA-Desktop-0.0.18-mac-arm64.dmg`}]}};
 assert.equal(validateInstallerManifest(ossManifest,ossSource,'stable','darwin','arm64').artifact.url,ossManifest.release.artifacts[0].url);
 assert.throws(()=>validateInstallerManifest(ossManifest,source,'stable','darwin','arm64'),/INVALID_DESKTOP_URL/);
});

test('the shipped installer channel configuration keeps a public source ahead of the company GitLab fallback',async()=>{
 const sources=JSON.parse(await readFile(new URL('./desktop-release-sources.json',import.meta.url),'utf8'));
 for(const channel of ['stable','test']){
  const candidates=sources[channel];
  assert.ok(Array.isArray(candidates)&&candidates.length>=2,channel+' must carry a fallback list');
  assert.match(candidates[0],/^https:\/\//,channel+' must try the public https source first');
  assert.ok(candidates[0].includes('/raw/'),channel+' must keep the immutable raw channel path');
  assert.ok(!candidates[0].includes('100.100.6.191'),channel+' must not try the internal GitLab host first');
  assert.match(candidates[candidates.length-1],/^http:\/\/100\.100\.6\.191:20656\/chenyonghao\/dsh-plugin-releases\//,channel+' must keep the company GitLab channel last');
 }
});

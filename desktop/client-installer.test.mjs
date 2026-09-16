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
async function fixture(t,{fetchImpl,platform='darwin',arch='arm64'}={}){
 const data=await mkdtemp(join(tmpdir(),'gea-installer-test-'));let opened=[];
 const manager=createClientInstaller({data,currentVersion:'0.0.8',platform,arch,sources:{stable:source},openPath:async path=>{opened.push(path);return '';},fetchImpl:fetchImpl??(async url=>url===source?Response.json(manifest()):new Response(bytes))});
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
test('the current desktop package cannot be re-downloaded as an update',async t=>{
 const data=await mkdtemp(join(tmpdir(),'gea-installer-current-'));
 const currentManifest={...manifest(),release:{...manifest().release,version:'0.0.8',artifacts:manifest().release.artifacts.map(artifact=>({...artifact,url:artifact.url.replace('0.0.9','0.0.8')}))}};
 const manager=createClientInstaller({data,currentVersion:'0.0.8',platform:'darwin',arch:'arm64',sources:{stable:source},openPath:async()=>'',fetchImpl:async url=>url===source?Response.json(currentManifest):new Response(bytes)});
 t.after(async()=>{await manager.close();await rm(data,{recursive:true,force:true});});
 await manager.check();assert.equal(manager.status().updateAvailable,false);
 await assert.rejects(manager.download(),/DESKTOP_INSTALLER_ALREADY_CURRENT/);
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

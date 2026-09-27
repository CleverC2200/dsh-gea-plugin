import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {createClientInstaller} from './client-installer.mjs';
import {differentialDescriptor,decodeBlockmap} from './installer-blockmap.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const builder=process.env.GEA_BUILDER_LIB;
async function wait(manager,phase){for(let i=0;i<600;i++){if(manager.status().phase===phase)return;await new Promise(r=>setTimeout(r,5));}assert.equal(manager.status().phase,phase,JSON.stringify(manager.status()));}
async function fixture(t,{rangeMode='valid',signature}={}){
  const root=await mkdtemp(join(tmpdir(),'gea-delta-'));const requests=[];const old=randomBytes(384*1024),next=Buffer.from(old);randomBytes(24*1024).copy(next,128*1024);
  const require=createRequire(import.meta.url);const {buildBlockMap}=require(join(builder,'out/targets/blockmap/blockmap.js'));
  const assets=new Map();let release;
  const server=createServer((req,res)=>{
    requests.push({url:req.url,range:req.headers.range});
    if(req.url.endsWith('.json')){res.setHeader('content-type','application/json');res.end(JSON.stringify(release));return;}
    const body=assets.get(req.url);if(!body){res.writeHead(404);res.end();return;}
    if(req.headers.range){
      if(rangeMode==='stall')return;
      if(rangeMode==='redirect'){res.writeHead(302,{Location:'http://untrusted.invalid/installer.exe'});res.end();return;}
      if(rangeMode==='full'){res.writeHead(200,{'Content-Length':body.length});res.end(body);return;}
      const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range);const a=+m[1],b=+m[2];
      res.writeHead(206,{'Content-Range':`bytes ${rangeMode==='wrong'?a+1:a}-${b}/${body.length}`,'Content-Length':b-a+1});res.end(body.subarray(a,b+1));return;
    }
    res.writeHead(200,{'Content-Length':body.length});res.end(body);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  const source=origin+'/releases/raw/main/channels/desktop-stable.json';
  const make=async(version,bytes)=>{
    const file=join(root,version+'.exe');await writeFile(file,bytes);const info=await buildBlockMap(file,'gzip',file+'.blockmap');const map=await readFile(file+'.blockmap');
    const path=`/releases/raw/${'a'.repeat(40)}/desktop/GEA-Desktop-${version}-win-x64.exe`;assets.set(path,bytes);assets.set(path+'.blockmap',map);
    return {platform:'win32',arch:'x64',url:origin+path,bytes:bytes.length,sha256:sha(bytes),differential:{algorithm:'electron-blockmap-v2',sha512:info.sha512,blockmap:{url:origin+path+'.blockmap',bytes:map.length,sha256:sha(map)}}};
  };
  const oldArtifact=await make('1.0.0',old),newArtifact=await make('1.1.0',next);
  const set=a=>{release={schema:1,channel:'stable',release:{version:a===oldArtifact?'1.0.0':'1.1.0',notes:{zh:'版本',en:'Release'},artifacts:[a]}};};
  const managers=[];
  const create=(extra={})=>{const m=createClientInstaller({data:join(root,'user'),currentVersion:'0.0.1',platform:'win32',arch:'x64',sources:{stable:source},openPath:async()=>'',cacheOptions:{isInUse:async()=>false},...extra});managers.push(m);return m;};
  t.after(async()=>{for(const m of managers)await m.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  set(oldArtifact);const first=create();await first.check();await first.download();await wait(first,'ready');await first.close();
  requests.length=0;set(newArtifact);
  return {root,requests,next,oldArtifact,newArtifact,manager:create(signature?{verifySignature:signature}:{}),create};
}
test('real blockmap HTTP reconstruction transfers less than a full file and preserves exact bytes',{skip:!builder},async t=>{
  const {root,requests,next,manager}=await fixture(t);await manager.check();await manager.download();await wait(manager,'ready');
  assert.equal(manager.status().downloadMode,'differential');assert.ok(manager.status().networkBytes<next.length);
  const payload=requests.filter(r=>r.url.endsWith('1.1.0-win-x64.exe'));assert.ok(payload.length);assert.ok(payload.every(r=>r.range));
  const files=await readdir(join(root,'user/desktop-downloads'));const installed=files.find(f=>f.endsWith('1.1.0-win-x64.exe'));
  assert.deepEqual(await readFile(join(root,'user/desktop-downloads',installed)),next);await manager.open();
});
for(const rangeMode of ['full','wrong','redirect'])test('invalid Range '+rangeMode+' safely falls back exactly once',{skip:!builder},async t=>{
  const {requests,manager}=await fixture(t,{rangeMode});await manager.check();await manager.download();await wait(manager,'ready');
  assert.equal(manager.status().downloadMode,'full');const payload=requests.filter(r=>r.url.endsWith('1.1.0-win-x64.exe'));assert.ok(payload.some(r=>r.range));assert.equal(payload.filter(r=>!r.range).length,1);
});
test('cancelling a differential request before headers never starts a full fallback',{skip:!builder},async t=>{
  const {manager,requests,root}=await fixture(t,{rangeMode:'stall'});await manager.check();await manager.download();
  for(let i=0;i<200&&!requests.some(r=>r.range);i++)await new Promise(r=>setTimeout(r,5));assert.ok(requests.some(r=>r.range));manager.cancel();await wait(manager,'cancelled');
  assert.equal(requests.filter(r=>r.url.endsWith('1.1.0-win-x64.exe')&&!r.range).length,0);assert.equal((await readdir(join(root,'user/desktop-downloads'))).some(f=>f.endsWith('.part')),false);
});
test('publisher rejection cannot become ready or bypass verification through a full retry',{skip:!builder},async t=>{
  const {manager,requests}=await fixture(t,{signature:async()=>{throw Error('WINDOWS_PUBLISHER_MISMATCH');}});await manager.check();await manager.download();await wait(manager,'failed');
  assert.equal(manager.status().error,'WINDOWS_PUBLISHER_MISMATCH');assert.equal(requests.filter(r=>r.url.endsWith('1.1.0-win-x64.exe')&&!r.range).length,0);await assert.rejects(manager.open(),/NOT_READY/);
});
test('optional differential URLs cannot escape the validated installer origin/path',()=>{
  const a={platform:'win32',url:'https://company.test/new.exe',differential:{algorithm:'electron-blockmap-v2',sha512:Buffer.alloc(64).toString('base64'),blockmap:{url:'https://evil.test/map',bytes:10,sha256:'a'.repeat(64)}}};
  assert.equal(differentialDescriptor(a),null);assert.throws(()=>decodeBlockmap(Buffer.alloc(10),a),/CHECKSUM/);
});

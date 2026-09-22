import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {HTML_PLUGIN_CHANNELS,prepareHtmlPlugins} from './html-plugins.mjs';

function tarEntry(name,content,type='0'){
 const header=Buffer.alloc(512);
 header.write(name,0,100,'utf8');
 header.write('0000644\0',100,8);
 header.write('0000000\0',108,8);
 header.write('0000000\0',116,8);
 header.write(content.length.toString(8).padStart(11,'0')+'\0',124,12);
 header.write('00000000000\0',136,12);
 header.write('        ',148,8);
 header.write(type,156,1);
 header.write('ustar\0',257,6);
 header.write('00',263,2);
 let sum=0;for(const byte of header)sum+=byte;
 header.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8);
 const body=Buffer.alloc(Math.ceil(content.length/512)*512);
 content.copy(body);
 return Buffer.concat([header,body]);
}
function packageArchive(existing){
 const manifest=existing?existing:Buffer.from(JSON.stringify({schemaVersion:1,id:'inventory-dealer',name:'经销商库存',version:'0.2.6-preview.2'}),'utf8');
 return gzipSync(Buffer.concat([tarEntry('package/',Buffer.alloc(0),'5'),tarEntry('package/plugin.json',manifest),tarEntry('package/index.html',Buffer.from('<html>ok</html>','utf8')),Buffer.alloc(1024)]));
}
async function serve(t,handler){
 const server=createServer(handler);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 return `http://127.0.0.1:${server.address().port}`;
}
function channel(origin,archive,id='inventory-dealer'){
 return JSON.stringify({schema:1,channel:'preview',kind:'gea-html-v1',plugins:[{id,name:'经销商库存',version:'0.2.6-preview.2',url:`${origin}/plugin.tgz`,sha256:createHash('sha256').update(archive).digest('hex'),bytes:archive.length,contract:'gea-html-v1'}]});
}
const quiet=()=>{};

test('installs the published html plugin, then reuses the cached copy without downloading again',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-html-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const archive=packageArchive();
 let downloads=0;
 const origin=await serve(t,(request,response)=>{
  if(request.url==='/channel.json'){response.end(channel(origin,archive));return;}
  if(request.url==='/plugin.tgz'){downloads++;response.end(archive);return;}
  response.statusCode=404;response.end();
 });
 const first=await prepareHtmlPlugins({runtime:root,channelUrl:`${origin}/channel.json`,log:quiet});
 assert.deepEqual(first.installed,['inventory-dealer']);
 assert.deepEqual(first.reused,[]);
 assert.deepEqual(first.failed,[]);
 const target=first.roots['inventory-dealer'];
 assert.equal(await readFile(join(target,'index.html'),'utf8'),'<html>ok</html>');
 assert.equal(JSON.parse(await readFile(join(target,'.source.json'),'utf8')).version,'0.2.6-preview.2');
 const second=await prepareHtmlPlugins({runtime:root,channelUrl:`${origin}/channel.json`,log:quiet});
 assert.deepEqual(second.reused,['inventory-dealer']);
 assert.deepEqual(second.installed,[]);
 assert.equal(downloads,1);
 assert.equal(second.roots['inventory-dealer'],target);
});

test('a digest mismatch is reported and never becomes a navigation root',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-html-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const archive=packageArchive();
 const origin=await serve(t,(request,response)=>{
  if(request.url==='/channel.json'){
   const body=JSON.parse(channel(origin,archive));
   body.plugins[0].sha256='0'.repeat(64);
   response.end(JSON.stringify(body));
   return;
  }
  response.end(archive);
 });
 const result=await prepareHtmlPlugins({runtime:root,channelUrl:`${origin}/channel.json`,log:quiet});
 assert.deepEqual(result.roots,{});
 assert.deepEqual(result.failed.map(entry=>entry.reason),['HTML_PLUGIN_DIGEST_MISMATCH']);
 assert.equal(existsSync(join(root,'html-plugins/inventory-dealer')),false);
});

test('an unreachable channel leaves startup with no html roots instead of failing',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-html-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await prepareHtmlPlugins({runtime:root,channelUrl:'http://127.0.0.1:1/channel.json',log:quiet});
 assert.deepEqual(result,{roots:{},installed:[],reused:[],failed:[]});
});

test('an unreachable first channel falls back to the next published source',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-html-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const archive=packageArchive();
 const origin=await serve(t,(request,response)=>{
  if(request.url==='/channel.json'){response.end(channel(origin,archive));return;}
  response.end(archive);
 });
 const result=await prepareHtmlPlugins({runtime:root,channelUrl:['http://127.0.0.1:1/channel.json',`${origin}/channel.json`],log:quiet});
 assert.deepEqual(result.installed,['inventory-dealer']);
 assert.deepEqual(result.reused,[]);
 assert.deepEqual(result.failed,[]);
 assert.equal(await readFile(join(result.roots['inventory-dealer'],'index.html'),'utf8'),'<html>ok</html>');
});

test('every unreachable channel source still leaves startup with no html roots',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-html-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await prepareHtmlPlugins({runtime:root,channelUrl:['http://127.0.0.1:1/channel.json','http://127.0.0.1:2/channel.json'],log:quiet});
 assert.deepEqual(result,{roots:{},installed:[],reused:[],failed:[]});
});

// 随包发出去的频道配置必须真的做到“公网来源优先、公司 GitLab 兜底”。
test('the shipped html plugin channel keeps a public source ahead of the company GitLab fallback',()=>{
 assert.ok(HTML_PLUGIN_CHANNELS.length>=2,'html plugins must carry a fallback list');
 assert.ok(HTML_PLUGIN_CHANNELS.every(url=>/^https?:\/\//.test(url)),'entries must be absolute URLs');
 assert.match(HTML_PLUGIN_CHANNELS[0],/^https:\/\//);
 assert.ok(!HTML_PLUGIN_CHANNELS[0].includes('100.100.6.191'),'must not try the internal GitLab host first');
 assert.match(HTML_PLUGIN_CHANNELS[HTML_PLUGIN_CHANNELS.length-1],/^http:\/\/100\.100\.6\.191:20656\/chenyonghao\/dsh-plugin-releases\//);
});

test('an archive that escapes the plugin directory is rejected',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gea-html-plugins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const escaping=gzipSync(Buffer.concat([tarEntry('package/../escaped.txt',Buffer.from('nope','utf8')),Buffer.alloc(1024)]));
 const origin=await serve(t,(request,response)=>{
  if(request.url==='/channel.json'){response.end(channel(origin,escaping));return;}
  response.end(escaping);
 });
 const result=await prepareHtmlPlugins({runtime:root,channelUrl:`${origin}/channel.json`,log:quiet});
 assert.deepEqual(result.failed.map(entry=>entry.reason),['HTML_PLUGIN_UNSAFE_PATH']);
 assert.equal(existsSync(join(root,'escaped.txt')),false);
});

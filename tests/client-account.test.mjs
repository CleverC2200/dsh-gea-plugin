import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(import.meta.url);
const {outputFiles}=await build({entryPoints:['src/client.tsx'],bundle:true,write:false,format:'cjs',platform:'node',external:['react','react/jsx-runtime'],loader:{'.css':'text'}});
test('public account actions consume the same GEA Host identity and reject expired login without inventing client authentication',async()=>{
 const module={exports:{}};const endpoints=[];let authenticated=false;let pollStatus='pending';
 const fetch=async(url,options)=>{endpoints.push([url,options]);if(url==='/api/gea-html/identity')return Response.json({scope:authenticated?'host-owned':null,status:{authenticated,user:authenticated?{name:'真实Host投影'}:null}});
   const endpoint=url.split('/').pop();let value;
   if(endpoint==='start')value={loginId:'host-qr',image:'data:image/png;base64,host',expiresIn:120};
   if(endpoint==='poll'){authenticated=pollStatus==='authenticated';value={status:pollStatus};}
   if(endpoint==='logout'){authenticated=false;value={authenticated:false};}
   return Response.json({ok:true,value});
 };
 runInNewContext(outputFiles[0].text,{module,exports:module.exports,require,fetch,Response,AbortController,AbortSignal,CustomEvent,window:new EventTarget(),crypto:globalThis.crypto,console,setTimeout,clearTimeout});
 const provided=new Map();const ctx={effect:()=>{},provide:(name,value)=>provided.set(name,value),locale:{bind:()=>key=>key},slots:{inject:()=>{}},agentWorkbench:{},remote:{}};
 module.exports.apply(ctx);const account=provided.get('businessAccount'),identity=provided.get('geaIdentity');
 assert.equal(account.getSnapshot,identity.getSnapshot);assert.equal(account.subscribe,identity.subscribe);
 const signal=new AbortController().signal;assert.equal((await account.startLogin(signal)).loginId,'host-qr');
 assert.equal(await account.pollLogin('host-qr',signal),false);assert.equal(account.getSnapshot().state,'unknown');
 pollStatus='expired';await assert.rejects(account.pollLogin('host-qr',signal),/过期/);assert.equal(account.getSnapshot().status,null);
 pollStatus='authenticated';assert.equal(await account.pollLogin('host-qr',signal),true);assert.equal(account.getSnapshot().status.authenticated,true);
 await account.logout(signal);assert.equal(account.getSnapshot().status.authenticated,false);assert.equal(account.getSnapshot().scope,null);
 assert.deepEqual(endpoints.filter(([url])=>url.includes('/login/poll')).map(([,options])=>JSON.parse(options.body)),[{loginId:'host-qr'},{loginId:'host-qr'},{loginId:'host-qr'}]);
});

import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {mkdir,writeFile} from 'node:fs/promises';
import {profile,readSession,until} from '../../../tests/profile.mjs';
await mkdir('.runtime/inventory-qa-20260926',{recursive:true});
test('unbound warehouse preset uses its own model agent identity',async t=>{
 const root='/Users/synear/Library/Application Support/dsh-gea-desktop/data/html-plugins/inventory-fc';
 const app=await profile(t,{config:{analysis:{mode:'model',source:'gea',agentCode:'sales_forecast',model:'fixture-model',contextWindow:32768,maxTokens:2048}},env:{GEA_HTML_PLUGIN_ROOTS:JSON.stringify({'inventory-fc':root})}});
 const requests=[];
 app.route((req,res,reply)=>{
  const p=req.url.pathname;
  if(p.endsWith('/user-agent-credential/my/list')){reply({success:true,result:{records:[{id:'fixture-credential',status:'ACTIVE'}],total:1}});return true;}
  if(p.endsWith('/user-agent-credential/my/claim')){reply({success:true,result:{credentialId:'fixture-credential',status:'ACTIVE',baseUrl:app.base+'/personal',secret:'fixture-secret'}});return true;}
  if(p.endsWith('/airagModel/queryById')){reply({success:true,result:{id:'fixture-model',name:'fixture'}});return true;}
  if(p==='/personal/models'){reply({data:[{id:'fixture-model'}]});return true;}
  if(p==='/personal/chat/completions'){
   const body=JSON.parse(req.body);requests.push({agentCode:req.headers['x-gea-agent-code'],warehousePersona:JSON.stringify(body.messages).includes('你负责分仓库存')});
   res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'fixture complete'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return true;
  }
  return false;
 });
 await app.login();const discover=await app.rpc('model/discover');assert.equal(discover.ok,true,JSON.stringify(discover));
 const made=await app.remote('session/create',{cwd:app.runtime+'/workspace',agentPreset:'gea-html-inventory-fc'});const id=made.value.sessionId;
 await app.remote('session/selectModel',{sessionId:id,provider:'gea-analysis',model:'fixture-model'});
 await app.remote('session/prompt',{requestId:randomUUID(),sessionId:id,mode:'queue',content:[{type:'text',text:'分仓库存如何查看？'}]});
 await until(()=>readSession(app.runtime,id),r=>r.some(e=>e.type==='turn/end'));
 await writeFile('.runtime/inventory-qa-20260926/model-attribution.json',JSON.stringify({expected:'branch-inventory',requests},null,2));console.log(JSON.stringify(requests));
 assert.equal(requests[0].agentCode,'branch-inventory');
});

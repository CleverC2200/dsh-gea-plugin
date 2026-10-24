import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
const bundle=await build({stdin:{contents:"export {Business} from './src/host/business.ts';export {createCapabilityRegistry} from './src/capability/registry.ts'",resolveDir:process.cwd()},bundle:true,packages:'external',write:false,platform:'node',format:'cjs'});
const module={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const {Business,createCapabilityRegistry}=module.exports;
const period={type:'WEEK',start:'2026-10-19',end:'2026-10-26'};
const scope={key:'order:base:郑州',base:'郑州'};
const report={schemaVersion:1,facts:{complete:true,value:0},edits:{summary:{positive:'结论'},unmet:[{base:'郑州'}],improvements:[[{text:'改善措施'}]],references:[{name:'参考',href:'https://example.com'}]}};
function business(t){
 const value=new Business({geaBaseUrl:'https://gea.example.test/gea-boot',analysisAgentCode:'sales_forecast',requestTimeoutMs:1000});
 value.auth={id:'editor',tenantId:'0',token:'synthetic-login',name:'业务人员'};
 value.setCapabilities(createCapabilityRegistry([{id:'inventory-orderworkbench',label:'订单工作台',maxEffect:'submit',data:{consumerCode:'order',tables:['agents_order_workbench_report'],mock:false,rules:[]},routing:{keywords:[],summary:''}}]));
 t.after(()=>value.dispose());return value;
}
function gateway(t,{deny=false,scopeChanged=false,expireFirstSave=false}={}){
 let row,loads=0,sessions=0;const writes=[],saveAttempts=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body),headers=new Headers(init.headers);
  if(path.endsWith('/ai/gateway/agent/session')){
   sessions++;assert.equal(body.agentCode,'order');return Response.json({success:true,result:{accessDecision:{allowed:true},delegationToken:'synthetic-order'}});
  }
  assert.equal(headers.get('X-Delegation-Token'),'synthetic-order');
  assert.equal('sql' in body,false);assert.equal('tenant' in body,false);assert.equal('actor' in body,false);
  if(path.endsWith('/ai/gateway/order-report/load')){
   loads++;assert.deepEqual(body,{periodType:period.type,periodStart:period.start,periodEndExclusive:period.end});
   return Response.json({success:true,result:{scope:scopeChanged&&writes.length?{key:'order:base:上海',base:'上海'}:scope,rows:row?[row]:[]}});
  }
  if(path.endsWith('/ai/gateway/order-report/save')){
   saveAttempts.push(body.requestId);
   if(expireFirstSave&&saveAttempts.length===1)return Response.json({success:false,errorCode:'AI_GATEWAY_SESSION_EXPIRED',message:'session expired'});
   if(deny)return Response.json({success:false,message:'ORDER_REPORT_PERMISSION_DENIED'});
   assert.equal(body.scopeKey,scope.key);assert.equal(body.expectedVersion,0);
   const envelope=JSON.parse(body.reportData);
   assert.deepEqual(JSON.parse(gunzipSync(Buffer.from(envelope.data,'base64'))),report);
   writes.push(body);row={report_data:body.reportData,version:1,last_request_id:body.requestId,schema_version:1,period_end_exclusive:period.end};
   return Response.json({success:true,result:{saved:true,version:1,requestId:body.requestId}});
  }
  throw Error('Unexpected endpoint: '+path);
 });
 return {writes,saveAttempts,get loads(){return loads},get sessions(){return sessions}};
}
test('ordinary editor saves and reopens through order endpoints without management APIs or raw SQL',async t=>{
 const remote=gateway(t),editor=business(t),signal=new AbortController().signal;
 const saved=await editor.orderReport({operation:'save',period,expectedVersion:0,requestId:'host-request-00000001',report},signal);
 assert.equal(saved.saved,true);assert.equal(remote.writes.length,1);assert.equal(remote.loads,2);
 const reopened=await business(t).orderReport({operation:'load',period},signal);
 assert.deepEqual(reopened.report,report);assert.deepEqual(reopened.scope,scope);assert.equal(reopened.version,1);
});
test('backend write denial never falls back or reports saved',async t=>{
 const remote=gateway(t,{deny:true}),editor=business(t);
 await assert.rejects(editor.orderReport({operation:'save',period,expectedVersion:0,requestId:'host-request-00000001',report},new AbortController().signal),/ORDER_REPORT_PERMISSION_DENIED/);
 assert.equal(remote.writes.length,0);assert.equal(remote.loads,1);
});
test('changed backend scope cannot confirm a save under the previous base',async t=>{
 gateway(t,{scopeChanged:true});
 await assert.rejects(business(t).orderReport({operation:'save',period,expectedVersion:0,requestId:'host-request-00000001',report},new AbortController().signal),/ORDER_REPORT_SCOPE_CHANGED/);
});
test('expired order delegation renews once and keeps the same save request',async t=>{
 const remote=gateway(t,{expireFirstSave:true});
 const saved=await business(t).orderReport({operation:'save',period,expectedVersion:0,requestId:'host-request-00000001',report},new AbortController().signal);
 assert.equal(saved.saved,true);assert.equal(remote.sessions,2);assert.equal(remote.writes.length,1);
 assert.deepEqual(remote.saveAttempts,['host-request-00000001','host-request-00000001']);
});

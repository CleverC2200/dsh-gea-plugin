import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {profile,readSession,readToolResults,until} from './profile.mjs';
import {prefersBusinessCards} from '../src/host/business-presentation.ts';

test('business presentation respects plain text requests and leaves one-off facts alone',()=>{
 assert.equal(prefersBusinessCards('看下9月份需求预测情况'),true);
 assert.equal(prefersBusinessCards('10月份销售预测结果是多少，供应是否存在缺口'),true);
 assert.equal(prefersBusinessCards('只用一句文字说明预测情况，不要卡片'),false);
 assert.equal(prefersBusinessCards('这条记录的日期是什么'),false);
});

test('reading genui enables rendering atomically and survives restart without exposing UI initially',{timeout:90000},async t=>{
 const app=await profile(t,{config:base=>({analysis:{mode:'model',baseUrl:base+'/v1',model:'fixture',apiKeyEnv:'GEA_CARD_TEST_KEY',agentCode:'sales_forecast',contextWindow:32768,maxTokens:2048}}),env:{GEA_CARD_TEST_KEY:'fixture'}});
 const requests=[];let phase='load',step=0;
 app.route((req,res)=>{
  if(req.url.pathname!=='/v1/chat/completions')return false;
  const body=JSON.parse(req.body);requests.push({phase,body});
  const call=step++===0 ? phase==='load'?['gea_skill',{name:'genui',limit:10}]:phase==='capability'?['gea_capabilities',{skill:'genui'}]:phase==='invalid'?['gea_skill',{name:'genui',path:'not-linked.md'}]:undefined : undefined;
  const delta=call?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:call[0],arguments:JSON.stringify(call[1])}}]}:{content:'本轮完成。'};
  res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:call?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');return true;
 });
 await app.login();const made=await app.remote('session/create',{cwd:app.runtime+'/workspace',agentPreset:'gea-readonly'});let id=made.value.sessionId;await app.remote('session/selectModel',{sessionId:id,provider:'gea-analysis',model:'fixture'});
 const ask=async(text,count)=>{await app.remote('session/prompt',{requestId:randomUUID(),sessionId:id,mode:'queue',content:[{type:'text',text}]});return until(()=>readSession(app.runtime,id),rows=>rows.filter(e=>e.type==='turn/end').length===count,30000);};
 const rows=await ask('用轻量卡片展示样例：已完成3，待处理2。不查询数据。',1);
 assert.equal(requests[0].body.tools.some(t=>t.function.name==='render_ui'),false,'UI tools are not injected into every initial request');
 const receipts=readToolResults(rows);
 assert.ok(receipts.length>0);
 assert.ok(receipts.every(receipt=>!receipt.isError));
 assert.ok(requests[1].body.tools.some(t=>t.function.name==='render_ui'),'genui body read must enable its render tool');
 assert.ok(requests[1].body.tools.some(t=>t.function.name==='validate_dsh_ui'));
 phase='restored';await app.stop();await app.start();await app.login();await ask('继续按刚才的形式展示，不重新查数。',2);
 assert.ok(requests.at(-1).body.tools.some(t=>t.function.name==='render_ui'),'successful UI skill selection restores on the same session');
 for(const scenario of ['invalid','capability']){
  phase=scenario;step=0;const made=await app.remote('session/create',{cwd:app.runtime+'/workspace',agentPreset:'gea-readonly'});id=made.value.sessionId;await app.remote('session/selectModel',{sessionId:id,provider:'gea-analysis',model:'fixture'});
  const events=await ask('读取可视化规则，只使用样例。',1);
  if(scenario==='invalid'){
   assert.ok(readToolResults(events).some(receipt=>receipt.isError));
   assert.equal(requests.at(-1).body.tools.some(t=>t.function.name==='render_ui'),false,'failed Skill read must not grant UI tools');
  }else{
   assert.ok(requests.at(-1).body.tools.some(t=>t.function.name==='render_ui'));
   phase='capability-restored';await app.stop();await app.start();await app.login();await ask('继续展示。',2);
   assert.ok(requests.at(-1).body.tools.some(t=>t.function.name==='render_ui'),'capabilities skill selection also persists its UI pack');
  }
 }
});

test('overview reads offer UI after data; explicit plain text does not',{timeout:60000},async t=>{
 const app=await profile(t,{config:base=>({analysis:{mode:'model',baseUrl:base+'/v1',model:'fixture',apiKeyEnv:'GEA_CARD_TEST_KEY',agentCode:'sales_forecast',contextWindow:32768,maxTokens:2048}}),env:{GEA_CARD_TEST_KEY:'fixture'}});
 let requests=[];
 app.route((req,res,reply)=>{
  const path=req.url.pathname;
  if(path.endsWith('/ai/gateway/session')){reply({success:true,result:{accessDecision:{allowed:true},gatewayContext:{consumerType:'AGENT',consumerCode:'sales_forecast',sessionId:'fixture',conversationId:'fixture'},delegationToken:'fixture'}});return true;}
  if(path.endsWith('/ai/gateway/mcp/proxy/resources')){reply({success:true,resources:[{capabilityCode:'MCP_TOOL:cube:query_business_data',resourceCode:'inv',resourceName:'inv',resourceType:'EXTERNAL_MCP',queryTarget:'inv',version:'1',maxRows:100,maxBytes:null}]});return true;}
  if(path.endsWith('/ai/gateway/mcp/proxy/mcp')){
   const b=JSON.parse(req.body);let result={};
   if(b.method==='initialize')result={protocolVersion:b.params.protocolVersion};
   else if(b.method==='notifications/initialized'){res.statusCode=202;res.end();return true;}
   else if(b.method==='tools/list')result={tools:[{name:'query_business_data',_meta:{sourceType:'MCP',sourceCode:'cube'},inputSchema:{type:'object',properties:{action:{type:'string'},queries:{type:'array'}},required:['action','queries']}}]};
   else if(b.method==='tools/call')result={content:[{type:'text',text:JSON.stringify(b.params.arguments.action==='inspect'?{semanticModel:[{name:'inv',measures:[{name:'inv.row_count',type:'number'}]}]}:{datasets:[{name:'inv',rows:[{'inv.row_count':3}],complete:true}]})}]};
   reply({jsonrpc:'2.0',id:b.id,result});return true;
  }
  if(path!=='/v1/chat/completions')return false;
  const body=JSON.parse(req.body);requests.push(body);const first=requests.length===1;
  const delta=first?{tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:'gea_cube_query',arguments:JSON.stringify({queries:[{name:'inv',query:{measures:['inv.row_count']}}]})}}]}:{content:'样例记录数为3。'};
  res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:first?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');return true;
 });
 await app.login();
 for(const [question,expected] of [['看下需求预测情况',true],['只用一句文字说明预测情况，不要卡片',false],['记录数是多少',false]]){
  requests=[];const created=await app.remote('session/create',{cwd:app.runtime+'/workspace',agentPreset:'gea-readonly'});const sessionId=created.value.sessionId;await app.remote('session/selectModel',{sessionId,provider:'gea-analysis',model:'fixture'});
  await app.remote('session/prompt',{requestId:randomUUID(),sessionId,mode:'queue',content:[{type:'text',text:question}]});const rows=await until(()=>readSession(app.runtime,sessionId),r=>r.some(x=>x.type==='turn/end'),20000);
  assert.equal(rows.find(x=>x.type==='turn/end').data.reason.kind,'completed');
  assert.equal(requests[0].tools.some(t=>t.function.name==='render_ui'),false);
  assert.equal(requests[1].tools.some(t=>t.function.name==='render_ui'),expected,question);
  const system=requests[1].messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  if(expected)assert.match(system,/已加载工具包：ui/,'host must report auto-enabled presentation rather than instruct reloading it');
  else assert.doesNotMatch(system,/已加载工具包：[^。\n]*ui/,'plain fact must not advertise a pack it did not load');
 }
});

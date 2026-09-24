import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const out=await build({stdin:{contents:"export {Business} from './src/host/business.ts'; export {registerGeaTools} from './src/host/agent-tools.ts'; export {rowsFromText,noteMemberSamples,appendMemberSamples} from './src/host/gateway-catalog.ts'",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const m={exports:{}};new Function('require','module','exports',out.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);
const {Business,registerGeaTools,rowsFromText,noteMemberSamples,appendMemberSamples}=m.exports;
function fixture(t) {
  const business=new Business({geaBaseUrl:'https://gea.example.test',analysisAgentCode:'sales_forecast',requestTimeoutMs:1000});
  const tools=new Map();const ctx={effect:f=>f(),tools:{register:tool=>{tools.set(tool.name,tool);return ()=>{};}}};
  registerGeaTools(ctx,business);t.after(()=>business.dispose());
  const execute=(name,args,scope='one')=>tools.get(name).execute(args,{agent:{id:scope},signal:new AbortController().signal});
  return {business,tools,execute};
}
test('actual tool stops distinct detail reads at 20 but leaves aggregation and other sessions usable',async t=>{
  const f=fixture(t);let reads=0;t.mock.method(f.business,'agentQuery',async()=>{reads++;return '{}';});
  for(let n=0;n<20;n++)await f.execute('gea_sales_plan_read',{kind:'detail',query:{planId:String(n)}});
  const limited=JSON.parse(await f.execute('gea_sales_plan_read',{kind:'detail',query:{planId:'21'}}));
  assert.equal(limited.code,'GEA_PLAN_READ_LIMIT');assert.equal(reads,20);
  await f.execute('gea_sales_plan_read',{kind:'aggregate',query:{periodId:'p'}});assert.equal(reads,21);
  await f.execute('gea_sales_plan_read',{kind:'detail',query:{planId:'21'}},'two');assert.equal(reads,22);
  f.business.clearTurnReplays('one');f.business.repeatReads().clear('one');
  await f.execute('gea_sales_plan_read',{kind:'detail',query:{planId:'21'}});assert.equal(reads,23);
});
test('catalog replay converges without disabling data queries',async t=>{
  const f=fixture(t);
  t.mock.method(f.business,'moduleMcp',async()=>({authorizedResources:async()=>({fetchedAt:'fixture',resources:[{queryTarget:'inv',resourceCode:'inv',resourceType:'EXTERNAL_MCP',version:'1',maxRows:200,maxBytes:null}]}),call:async()=>JSON.stringify({semanticModel:[{name:'inv',measures:[{name:'inv.row_count'}]}]})}));
  for(let n=0;n<9;n++)await f.execute('gea_gateway_catalog',{});
  assert.match(await f.execute('gea_gateway_catalog',{}),/GEA_METADATA_REPEAT_STOPPED/);
  assert.equal(f.business.turnStopped('one'),undefined);
});
test('aggregate argument order does not trigger a new scan and a replay keeps the summary table intact',async t=>{
  const f=fixture(t);let reads=0;
  const result=JSON.stringify({query:{kind:'aggregate'},coverage:'complete',value:{basis:'x'.repeat(9000),groups:[{amt:'EXACT_TABLE_AT_END'}]}});
  t.mock.method(f.business,'agentQuery',async()=>{reads++;return result;});
  await f.execute('gea_sales_plan_read',{kind:'aggregate',query:{periodId:'p',orderType:'M'}});
  for(let i=0;i<5;i++)assert.match(await f.execute('gea_sales_plan_read',{query:{orderType:'M',periodId:'p'},kind:'aggregate'}),/EXACT_TABLE_AT_END/);
  assert.equal(reads,1);
});
test('artifact pages feed latest sample observations even when the member is already in a cached directory',()=>{
  const rows=rowsFromText(JSON.stringify({queryArtifact:{resources:[{contents:[{text:JSON.stringify({rows:[{'plan.region':''}]})},{text:JSON.stringify({rows:[{'plan.region':null}]})}]}]}}));
  assert.equal(rows.length,2);const notes=new Map();noteMemberSamples(notes,rows,['plan.region']);
  const result=appendMemberSamples('model plan members: plan.region',notes,'plan');
  assert.match(result,/本次 2 行样本均为空/);assert.match(result,/不能据此断定全量为空/);
  assert.doesNotMatch(appendMemberSamples('other',notes,'other'),/region/);
  noteMemberSamples(notes,[{'plan.region':'东'},{'plan.region':'西'}],['plan.region']);
  assert.equal(appendMemberSamples('cached',notes,'plan'),'cached','new varied sample removes old empty observation');
});
test('resetting one conversation preserves another conversation guard and replay',t=>{
  const f=fixture(t);for(let n=0;n<20;n++)f.business.allowPlanRead('two',false);
  f.business.rememberTurnReplay('two','key','two-private');f.business.stopTurn('two','reason');
  f.business.clearTurnReplays('one');f.business.clearTurnStops('one');
  assert.equal(f.business.allowPlanRead('two',false),false);
  assert.equal(f.business.turnReplay('two','key'),'two-private');assert.equal(f.business.turnStopped('two'),'reason');
  f.business.clearTurnReplays();assert.equal(f.business.turnReplay('two','key'),undefined);
});

const aggregateReceipt = () => JSON.stringify({source:'GEA_LIVE_READONLY',environment:'production',fetchedAt:'2026-09-24T00:46:28Z',coverage:'complete',query:{kind:'aggregate',query:{periodId:'20261001'}},value:{planCount:28,skuRowCount:1143,distinctSkuCount:331,basis:{geography:'baseName 是基地，不等同组织大区'},totals:[{orderType:'M',planTypeCode:'Y',amt:'21453004.9',qty:'283546'}],bases:[{baseName:'华东',amt:'2494990.05'}],groups:[{baseName:'华东',productCategName:'饺子',amt:'920666.41'}]}});

test('MCP failures block that channel only and return the successful aggregate as evidence',async t=>{
  const f=fixture(t);let queries=0;let planReads=0;
  t.mock.method(f.business,'agentQuery',async()=>{planReads++;return aggregateReceipt();});
  t.mock.method(f.business,'moduleMcp',async()=>({authorizedResources:async()=>({fetchedAt:'fixture',resources:['inv','ship','plans','agents_aps_plans_source'].map(queryTarget=>({capabilityCode:'MCP_TOOL:cube:query_business_data',resourceCode:queryTarget,resourceName:queryTarget,queryTarget,resourceType:'EXTERNAL_MCP',version:'1',maxRows:200,maxBytes:262144}))}),tools:()=>[{name:'query_business_data',required:['action','queries']}],call:async(_name,args)=>{
    if(args.action==='inspect')return '{}';queries++;
    throw Error('GEA_MCP_RESOURCE_MAPPING_FAILED: 成员未唯一匹配数据目录资源');
  }}));
  const plan={kind:'aggregate',query:{periodId:'20261001'}};
  const query={consumerCode:'sales_forecast',tool:'query_business_data',arguments:{action:'query',queries:[{name:'region',query:{dimensions:['agents_aps_plans_source.region'],measures:['agents_aps_plans_source.row_count'],limit:3}}]}};
  await f.execute('gea_sales_plan_read',plan);
  for(let n=0;n<2;n++)await assert.rejects(f.execute('gea_module_mcp',query),/GEA_MCP_RESOURCE_MAPPING_FAILED/);
  const stopped=JSON.parse(await f.execute('gea_module_mcp',query));
  assert.equal(stopped.availability,'channel-stopped');
  assert.equal(queries,2,'third attempt must not reach the upstream');
  assert.equal(f.business.turnStopped('one'),undefined,'a channel failure must not stop the whole turn');
  assert.match(JSON.stringify(stopped.availableEvidence),/21453004\.9/);
  assert.match(JSON.stringify(stopped.availableEvidence),/baseName/);
  assert.match(await f.execute('gea_sales_plan_read',plan),/21453004\.9/);
  assert.equal(planReads,1,'successful snapshot remains usable without a new read');
  await assert.rejects(f.execute('gea_module_mcp',query,'two'),/GEA_MCP_RESOURCE_MAPPING_FAILED/);
  assert.equal(queries,3,'another conversation has an independent channel failure budget');
});

test('success evidence survives a whole-turn stop but is cleared on a new question or identity change',async t=>{
  const f=fixture(t);t.mock.method(f.business,'agentQuery',async()=>aggregateReceipt());
  await f.execute('gea_sales_plan_read',{kind:'aggregate',query:{periodId:'20261001'}});
  f.business.stopTurn('one','预算耗尽');
  const stopped=JSON.parse(await f.execute('gea_sales_plan_read',{kind:'list',query:{periodId:'20261001'}}));
  assert.match(JSON.stringify(stopped.availableEvidence),/21453004\.9/);
  assert.equal(f.business.successfulPlanEvidence('two').length,0);
  f.business.clearTurnReplays('one');assert.equal(f.business.successfulPlanEvidence('one').length,0);
  f.business.rememberTurnReplay('one','plan|test',aggregateReceipt());
  f.business.logout({});assert.equal(f.business.successfulPlanEvidence('one').length,0);
});

test('model-style single-field order objects are adapted before governed query preflight',async t=>{
 const f=fixture(t);let sent=[];
 t.mock.method(f.business,'moduleMcp',async()=>({authorizedResources:async()=>({fetchedAt:'fixture',resources:['inv','ship','plans','agents_aps_plans_source'].map(queryTarget=>({capabilityCode:'MCP_TOOL:cube:query_business_data',resourceCode:queryTarget,resourceName:queryTarget,queryTarget,resourceType:'EXTERNAL_MCP',version:'1',maxRows:200,maxBytes:262144}))}),tools:()=>[{name:'query_business_data',required:['action','queries']}],call:async(_tool,args)=>{
  if(args.action==='inspect')return '{}';sent.push(args);
  return JSON.stringify({deliveryMode:'inline_complete',datasets:args.queries.map(q=>({name:q.name,rows:[{'inv.row_count':1}]}))});
 }}));
 const ordered={name:'batches',query:{dimensions:['inv.stat_date'],measures:['inv.row_count'],order:[{'inv.stat_date':'desc'}],limit:10}};
 const sample={name:'sample',query:{dimensions:['inv.cust_code'],measures:['inv.row_count'],limit:3}};
 const call=queries=>f.execute('gea_module_mcp',{consumerCode:'sales_forecast',tool:'query_business_data',arguments:{action:'query',queries}});
 await call([ordered,sample]);
 assert.equal(sent.length,1,'the two valid queries go upstream together');
 assert.deepEqual(sent[0].queries[0].query.order,[['inv.stat_date','desc']]);
 assert.deepEqual(ordered.query.order,[{'inv.stat_date':'desc'}],'caller arguments stay unchanged');
 assert.equal(f.business.pendingMcpQueries('one').length,0);
 await assert.rejects(call([{...ordered,name:'ambiguous',query:{...ordered.query,order:[{'inv.stat_date':'desc','inv.cust_code':'asc'}]}}]),/GEA_CUBE_PREFLIGHT_BLOCKED/);
 await assert.rejects(call([{...ordered,name:'wrong-direction',query:{...ordered.query,order:[{'inv.stat_date':'DESC'}]}}]),/GEA_CUBE_PREFLIGHT_BLOCKED/);
 assert.equal(sent.length,1,'ambiguous or unsupported orders must stay local');
});

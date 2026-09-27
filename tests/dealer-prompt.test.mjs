import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {profile,readSession,until} from './profile.mjs';

test('dealer inventory uses the maintained skill in the real assembled prompt, without altering the sales-plan context', {timeout:45000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'gea-stock-prompt-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'skills','aqkc'),{recursive:true});
  const oldSkill='---\nname: inventory-dealer\ndescription: 经销商库存\n---\n先调用 inventory_dealer_page，name=context；必须保持页面打开。\n';
  await writeFile(join(root,'skills','aqkc','SKILL.md'),oldSkill);
  await writeFile(join(root,'index.html'),'<!doctype html><body>经销商库存</body>');
  await writeFile(join(root,'plugin.json'),JSON.stringify({schemaVersion:1,id:'inventory-dealer',name:'经销商库存',version:'0.0.0',html:'index.html',skills:['skills/aqkc/SKILL.md'],mcp:'mcp.json',gea:{consumerCode:'dealer-inventory-replenishment',readonly:true,contract:'gea-html-v1'}}));
  await writeFile(join(root,'mcp.json'),JSON.stringify({provider:'gea',transport:'host-provided',contract:'gea-html-v1',consumer:{consumerType:'AGENT',consumerCode:'dealer-inventory-replenishment'},capabilities:['governed-sql-read']}));
  const app=await profile(t,{config:base=>({analysis:{mode:'model',baseUrl:base+'/v1',model:'fixture-model',apiKeyEnv:'GEA_TEST_MODEL_KEY',contextWindow:32768,maxTokens:2048}}),env:{GEA_TEST_MODEL_KEY:'fixture-only',GEA_HTML_PLUGIN_ROOTS:JSON.stringify({'inventory-dealer':root})}});
  const requests=[];
  const catalogConsumers=[];
  let loadSkill=false;
  app.route((req,res,reply)=>{
    if(req.url.pathname.endsWith('/ai/gateway/mcp/proxy/resources')) {
      const request=JSON.parse(req.body);
      reply({success:true,resources:[{capabilityCode:`MCP_TOOL:${request.mcpCode}:query_business_data`,resourceCode:'stock_cube-cube',resourceName:'stock_cube',resourceType:'EXTERNAL_MCP',queryTarget:'stock_cube',version:'1',maxRows:200,maxBytes:262144}]});return true;
    }

    if(req.url.pathname.endsWith('/ai/gateway/session')) {
      const body=JSON.parse(req.body);catalogConsumers.push(body.consumerCode);
      reply({success:true,result:{accessDecision:{allowed:true},gatewayContext:{consumerType:'AGENT',consumerCode:body.consumerCode,sessionId:'fixture-session',conversationId:'fixture-conversation'},delegationToken:'fixture-delegation'}});return true;
    }
    if(req.url.pathname.endsWith('/ai/gateway/mcp/proxy/mcp')) {
      const b=JSON.parse(req.body);let result;
      if(b.method==='initialize')result={protocolVersion:b.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'fixture',version:'1'}};
      else if(b.method==='notifications/initialized'){res.statusCode=202;res.end();return true;}
      else if(b.method==='tools/list')result={tools:[{name:'query_business_data',_meta:{sourceType:'MCP',sourceCode:'cube'},inputSchema:{type:'object',properties:{action:{type:'string'},queries:{type:'array',items:{type:'object'}}},required:['action','queries']}}]};
      else if(b.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({semanticModel:[{name:'stock_cube',dimensions:[{name:'stock_cube.base',type:'string'}],measures:[{name:'stock_cube.row_count',type:'number'}]}]})}]};
      else result={};
      reply({jsonrpc:'2.0',id:b.id,result});return true;
    }
    if(req.url.pathname!=='/v1/chat/completions')return false;
    const body=JSON.parse(req.body);res.setHeader('Content-Type','text/event-stream');
    if(loadSkill&&!body.messages.some(message=>message.tool_call_id==='load-extra-skill')) {
      res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'load-extra-skill',type:'function',function:{name:'gea_capabilities',arguments:JSON.stringify({skill:'inventory-dealer'})}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');return true;
    }
    body.messages=body.messages.filter(message=>message.tool_call_id!=='load-extra-skill'&&!message.tool_calls?.some(call=>call.id==='load-extra-skill'));requests.push(body);
    const callTool=!body.messages.some(x=>x.role==='tool');
    const delta=callTool?{tool_calls:[{index:0,id:'load-stock-context',type:'function',function:{name:loadSkill?'gea_skill':'gea_gateway_catalog',arguments:JSON.stringify(loadSkill?{name:'inventory-dealer'}:{model:'stock_cube'})}}]}:{content:'收到。'};
    res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:callTool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');return true;
  });
  await app.login();
  async function ask(preset){
    const created=await app.remote('session/create',{cwd:app.runtime+'/workspace',agentPreset:preset});assert.equal(created.ok,true,JSON.stringify(created));
    const id=created.value.sessionId;
    assert.equal((await app.remote('session/selectModel',{sessionId:id,provider:'gea-analysis',model:'fixture-model'})).ok,true);
    assert.equal((await app.remote('session/prompt',{requestId:randomUUID(),sessionId:id,mode:'queue',content:[{type:'text',text:'按基地看库存合计，并列出前十个缺货 SKU。'}]})).ok,true);
    const records=await until(()=>readSession(app.runtime,id),r=>r.some(x=>x.type==='turn/end'));
    assert.equal(records.find(x=>x.type==='turn/end').data.reason.kind,'completed',JSON.stringify(records.find(x=>x.type==='turn/end').data.reason));
    return requests.at(-1);
  }
  const stock=await ask('gea-html-inventory-dealer');
  const system=stock.messages.filter(x=>x.role==='system').map(x=>x.content).join('\n');
  assert.match(system,/dealer-inventory-replenishment/);assert.match(system,/不空读页面/);
  assert.match(system,/明细被截断时说明实际覆盖范围/);assert.match(system,/业务键/);
  assert.doesNotMatch(system,/inventory_dealer_page|name=context|明细既不做交付物|没有任何模型同时具备|HMR receiver|pnpm run dev:web|销售计划汇总例外/);
  assert.ok(stock.tools.some(x=>x.function.name==='gea_cube_query'));
  assert.ok(!stock.tools.some(x=>x.function.name==='gea_page'));
  const stockCatalog=JSON.stringify(stock.messages.filter(x=>x.role==='tool'));
  assert.match(stockCatalog,/consumerCode=dealer-inventory-replenishment/);assert.doesNotMatch(stockCatalog,/consumerCode=sales_forecast/);
  const managed=await readFile(join(app.runtime,'home','gea-business-skills','inventory-dealer','SKILL.md'),'utf8');
  assert.match(managed,/action=context/);assert.doesNotMatch(managed,/inventory_dealer_page/);
  assert.equal(await readFile(join(root,'skills','aqkc','SKILL.md'),'utf8'),oldSkill,'the installed page artifact is unchanged');
  const sales=await ask('gea-readonly');const salesSystem=sales.messages.filter(x=>x.role==='system').map(x=>x.content).join('\n');
  assert.match(salesSystem,/agents_sales_plan_detail_mi/);assert.match(salesSystem,/实时审批状态/);assert.match(salesSystem,/gea_cube_query/);
  assert.doesNotMatch(salesSystem,/HMR receiver/,'business presets share the scoped non-development policy');
  assert.match(JSON.stringify(sales.messages.filter(x=>x.role==='tool')),/consumerCode=sales_forecast/);
  assert.deepEqual(catalogConsumers,['dealer-inventory-replenishment','sales_forecast'],'catalog transport and cache must stay in the owning Agent context');
  loadSkill=true;
  const loaded=await ask('gea-readonly');
  const skillReply=JSON.stringify(loaded.messages.filter(x=>x.role==='tool'));
  assert.match(skillReply,/dealer-inventory-replenishment/);assert.match(skillReply,/action=context/);
  assert.doesNotMatch(skillReply,/inventory_dealer_page/,'explicit skill loading must use the same maintained content as the stock persona');
});

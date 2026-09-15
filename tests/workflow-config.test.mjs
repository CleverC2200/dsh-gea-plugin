import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({stdin:{contents: "export * from './src/workflow-config.ts'; export * from './src/workflow-loader.ts'; export * from './src/workbench-original/salesPlanWorkflow.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const { readSalesPlanWorkflowConfig, salesPlanWorkflow, createWorkflowLoader } = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
const rows = ['0','4','Y'].map((node,i)=>({id:i+1,type_code:'JD',examine_level:String([0,2,3][i]),node_num:node}));
function mock(change = x=>x) {
 return async (url, init) => {
  assert.equal(init.method,'POST'); assert.equal(init.redirect,'error');
  if (url.endsWith('/agent/session')) return Response.json({success:true,code:200,result:{accessDecision:{allowed:true},delegationToken:'private-delegation'}});
  assert.equal(init.headers['X-Delegation-Token'],'private-delegation');
  const request=JSON.parse(init.body);
  assert.match(request.sql,/^SELECT id, type_code, examine_level, node_num FROM agents_scm_plan_workflow_config WHERE/);
  assert.deepEqual(request.parameters,{active:1,notDeleted:1});
  return Response.json({success:true,code:200,result:change({requestId:init.headers['X-Request-Id'],operation:'SELECT',tables:['agents_scm_plan_workflow_config'],total:3,pageNo:request.pageNo,pageSize:request.pageSize,rows})});
 };
}
test('live configuration preserves level gaps and projects no credentials',async()=>{
 const value=await readSalesPlanWorkflowConfig('https://example.test','private-access',mock(),new AbortController().signal);
 assert.deepEqual(value.map(x=>x.examineLevel),[0,2,3]);
 assert.ok(!JSON.stringify(value).includes('private'));
 const flow=salesPlanWorkflow('JD',value);
 assert.equal(flow.rolesKnown,true); assert.deepEqual(flow.pendingStatuses('category'),[4]);
 assert.equal(flow.resubmit(6),4); assert.equal(flow.transition(4,'REJECT'),6);
});
test('configuration rejects incomplete, mismatched, duplicate and malformed responses',async()=>{
 for(const change of [x=>({...x,requestId:'wrong'}),x=>({...x,operation:'UPDATE'}),x=>({...x,tables:['other']}),x=>({...x,total:4}),x=>({...x,rows:[rows[0],rows[0],rows[2]]}),x=>({...x,rows:[rows[0],{...rows[1],examine_level:'bad'},rows[2]]})])
  await assert.rejects(readSalesPlanWorkflowConfig('https://example.test','token',mock(change),new AbortController().signal),/GEA_WORKFLOW_RESPONSE_INVALID/);
});
test('cancelled and superseded loads cannot reinstall old configuration; failure clears it',async()=>{
 const configured=[{typeCode:'XN',examineLevel:0,nodeNum:'0'},{typeCode:'XN',examineLevel:1,nodeNum:'2'},{typeCode:'XN',examineLevel:2,nodeNum:'3'},{typeCode:'XN',examineLevel:3,nodeNum:'4'},{typeCode:'XN',examineLevel:4,nodeNum:'Y'}];
 let release; let count=0;
 const load=createWorkflowLoader(()=>++count===1?new Promise(r=>release=r):Promise.resolve(configured));
 const old=load(); await load(); release([]); await assert.rejects(old,/STALE_SELECTION/);
 assert.equal(salesPlanWorkflow('XN').resubmit(6),2);
 assert.equal(salesPlanWorkflow('XN').transition(2,'REJECT'),6);
 const controller=new AbortController(); const cancelled=createWorkflowLoader(async()=>{controller.abort();return configured;});
 await assert.rejects(cancelled(controller.signal)); assert.equal(salesPlanWorkflow('XN').valid,false);
 const failed=createWorkflowLoader(async()=>{throw Error('offline');});
 await assert.rejects(failed(),/offline/);assert.equal(salesPlanWorkflow('Y').valid,false);
});

test('DSH Host authenticates fixed config reads and rejects caller SQL', {timeout:60000}, async t=>{
 const {profile}=await import('./profile.mjs');
 const app=await profile(t);
 assert.equal((await app.rpc('workflow/config')).ok,false);
 await app.login();
 assert.equal((await app.rpc('workflow/config',{sql:'SELECT * FROM secret'})).ok,false);
 const result=await app.rpc('workflow/config');
 assert.equal(result.ok,true); assert.equal(result.value.length,6);
 assert.deepEqual(result.value.map(x=>x.nodeNum),['0','1','2','3','4','Y']);
 assert.ok(!JSON.stringify(result).includes('fixture-delegation'));
});

test('workflow failures identify the upstream stage and redact both credentials', async () => {
 for (const stage of ['session', 'sql']) {
  let calls = 0;
  await assert.rejects(readSalesPlanWorkflowConfig('https://example.test', 'private-access', async (url, init) => {
   calls++;
   if (stage === 'sql' && url.endsWith('/agent/session')) return mock()(url, init);
   return Response.json({success:false,code:403,errorCode:'ACCESS_DENIED',message:'denied private-access private-delegation',requestId:'req-123',traceId:'trace-123'}, {status:403});
  }, new AbortController().signal), error => {
   assert.equal(error.details.stage, stage);
   assert.equal(error.details.httpStatus, 403);
   assert.equal(error.details.upstreamCode, 'ACCESS_DENIED');
   assert.equal(error.details.traceId, 'trace-123');
   assert.ok(!JSON.stringify(error).includes('private-access'));
   if(stage === 'sql') assert.ok(!JSON.stringify(error).includes('private-delegation'));
   return true;
  });
  assert.equal(calls, stage === 'sql' ? 2 : 1);
 }
});

test('workflow diagnostics distinguish invalid envelopes, HTML and transport failures', async () => {
 for (const [respond, expected] of [
  [() => Response.json({success:false,code:403,message:'denied'}), {httpStatus:200,reason:'envelope'}],
  [() => new Response('<html>private upstream body</html>',{status:502}), {httpStatus:502,reason:'invalid-json'}],
  [() => {throw Error('private-access');}, {httpStatus:0,reason:'transport'}],
 ]) {
  await assert.rejects(readSalesPlanWorkflowConfig('https://example.test','private-access',respond,new AbortController().signal), error => {
   assert.equal(error.details.stage,'session');
   assert.equal(error.details.path,'/ai/gateway/agent/session');
   assert.equal(error.details.httpStatus,expected.httpStatus);
   assert.equal(error.details.reason,expected.reason);
   assert.ok(error.details.requestId);
   assert.ok(!JSON.stringify(error).includes('private'));
   return true;
  });
 }
});

test('Host returns SQL failure diagnostics without exposing credentials or arbitrary payload', {timeout:60000}, async t => {
 const {profile}=await import('./profile.mjs');
 const app=await profile(t); await app.login();
 app.route((request,res,reply)=>{
  if(!request.url.pathname.endsWith('/sql/execute')) return false;
  reply({success:false,code:403,errorCode:'TABLE_DENIED',message:'fixture-gea-token fixture-delegation',traceId:'trace-denied',result:{private:'never-return'}},403);
  return true;
 });
 const result=await app.rpc('workflow/config');
 assert.equal(result.ok,false);
 assert.equal(result.error.details.stage,'sql');
 assert.equal(result.error.details.upstreamCode,'TABLE_DENIED');
 assert.equal(result.error.details.httpStatus,403);
 assert.equal(result.error.details.traceId,'trace-denied');
 assert.doesNotMatch(JSON.stringify(result),/fixture-gea-token|fixture-delegation|never-return/);
});

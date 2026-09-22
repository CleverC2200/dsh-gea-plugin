import test from 'node:test';import assert from 'node:assert/strict';import {profile} from './profile.mjs';
test('APS aps uses authenticated Agent delegation and denies obsolete consumer', {timeout:60000}, async t=>{
 const app=await profile(t);await app.login();let delegated,queries=0;
 app.route((req,res,reply)=>{if(req.url.pathname.endsWith('/ai/gateway/agent/session')){delegated=JSON.parse(req.body);reply({success:true,result:{accessDecision:{allowed:true},delegationToken:'fixture-aps-delegation'}});return true}if(req.url.pathname.endsWith('/ai/gateway/sql/execute')){queries++;reply({success:true,result:{rows:[{records:0}],total:1,pageNo:1,pageSize:200}});return true}});
 const result=await app.rpc('plugin/sql',{consumerCode:'aps',sql:'SELECT COUNT(*) AS records FROM agents_scm_safety_stock',parameters:{},resultShape:'rows'});
 assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(delegated.agentCode,'aps');assert.equal(queries,1);assert.deepEqual(result.value.rows,[{records:0}]);
 const obsolete=await app.rpc('plugin/sql',{consumerCode:'aps-plan-collaboration',sql:'SELECT COUNT(*) AS records FROM agents_scm_safety_stock'});assert.ok(obsolete.error);assert.equal(queries,1);
});

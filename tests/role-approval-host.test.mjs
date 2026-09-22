import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from './profile.mjs';

test('Host binds role writes to fresh permission and capability evidence while refusing stale, invisible and terminal requests', {timeout:60000}, async t=>{
 const app=await profile(t);
 let mode='supported',writes=0,status=2;
 const snapshot='a'.repeat(64);
 app.route((req,res,reply)=>{
   const path=req.url.pathname;
   const send=result=>{reply({success:true,result});return true;};
   if(path.endsWith('/getPermCode')) return send({codeList:['sales-plan:plan:region-approve']});
   if(path.endsWith('/plans/p')) return send({currentVersion:{id:'v',planId:'p',status,effective:mode!=='ineffective',planTypeCode:'Y'},skus:[],versions:[],logs:[],
     actionContext:{versionId:'v',status,nodeOrder:3,snapshotHash:mode==='stale'?'b'.repeat(64):snapshot,allowedActions:['APPROVE'],
       ...(mode==='legacy'?{}:{policy:'role-visible-v1',roleActions:[{role:'region',allowedActions:mode==='current-node-only'?[]:['APPROVE','REJECT']}]})}});
   if(path.endsWith('/versions/v/actions')) {writes++;const body=JSON.parse(req.body);assert.equal(body.action,'APPROVE');assert.equal(body.approvalRole,undefined,'上游报文只发接口文档声明的字段');assert.equal(body.approvalPolicy,undefined);assert.equal(body.expectedSnapshot,undefined);return send({planId:'p',versionId:'v',fromStatus:status,toStatus:status,approvalRole:'region',requestId:req.headers['x-request-id'],traceId:'t',auditId:'a',replayed:false});}
   if(path.endsWith('/notifications')) return send({items:[],total:0});
 });
 await app.login();
 let attempt=0;
 const action=(patch={})=>app.rpc('sales-plan/action',{planId:'p',versionId:'v',requestId:`r${++attempt}`,idempotencyKey:`role:${attempt}`,request:{action:'APPROVE',approvalRole:'region',approvalPolicy:'role-visible-v1',expectedStatus:status,expectedSnapshot:snapshot,...patch}});
 for(const scenario of ['legacy','stale','ineffective']) {mode=scenario; assert.equal((await action()).ok,false,scenario);}
 mode='supported';
 for(status of [0,5,6,7,8,9,10]) assert.equal((await action()).ok,false,`status ${status}`);
 status=6;
 const returnedSave=await app.rpc('sales-plan/action',{planId:'p',versionId:'v',requestId:`r${++attempt}`,idempotencyKey:`role:${attempt}`,request:{action:'SAVE',expectedStatus:6,expectedSnapshot:snapshot}});
 assert.equal(returnedSave.ok,false,'returned SAVE');
 status=2;
 assert.equal((await action({approvalRole:'category'})).ok,false);
 assert.equal((await action({approvalRole:undefined,approvalPolicy:undefined})).ok,false);
 assert.equal(writes,0);
 mode='current-node-only';
 assert.equal((await action()).ok,true);
 assert.equal(writes,1);
 mode='supported';
 assert.equal((await action()).ok,true);
 assert.equal(writes,2);
 const deniedDowngrade=await action({approvalPolicy:undefined});assert.equal(deniedDowngrade.ok,false);
 assert.equal(writes,2);
});

test('Host accepts approval backed by an assigned task, matching the upstream camelCase bizKey', {timeout:60000}, async t=>{
 const app=await profile(t);
 let writes=0;
 let keyShape='camel';
 app.route((req,res,reply)=>{
   const path=req.url.pathname;
   const send=result=>{reply({success:true,result});return true;};
   if(path.endsWith('/getPermCode')) return send({codeList:[]});
   if(path.endsWith('/plans/p')) return send({currentVersion:{id:'v',planId:'p',status:1,effective:true,planTypeCode:'Y'},skus:[],versions:[],logs:[]});
   const approval = keyShape==='camel'
     ? {bizKey:'sales-plan:version:v',instanceId:'i',actionable:true}
     : {biz_key:'sales-plan:version:v',instance_id:'i',actionable:true};
   if(path.endsWith('/notifications/n')) return send({id:'n',approval});
   if(path.endsWith('/notifications')) return send({items:[{id:'n',approval}],total:1});
   if(path.endsWith('/versions/v/actions')) {
     writes++;
     const body=JSON.parse(req.body);
     assert.equal(body.action,'APPROVE');
     assert.equal(body.approvalRole,undefined,'上游报文只发接口文档声明的字段');
     assert.equal(body.approvalPolicy,undefined);
     assert.equal(body.expectedSnapshot,undefined);
     return send({planId:'p',versionId:'v',fromStatus:1,toStatus:1,approvalRole:'region',requestId:req.headers['x-request-id'],traceId:'t',auditId:'a',replayed:false});
   }
 });
 await app.login();
 const approve=(key)=>app.rpc('sales-plan/action',{planId:'p',versionId:'v',requestId:key,idempotencyKey:key,request:{action:'APPROVE',approvalRole:'region',expectedStatus:1}});
 const camel=await approve('workflow-task-camel');
 assert.equal(camel.ok,true,JSON.stringify(camel));
 assert.equal(writes,1);
 // 上游换成蛇形字段时同样要认得出来，避免再次静默失效。
 keyShape='snake';
 const snake=await approve('workflow-task-snake');
 assert.equal(snake.ok,true,JSON.stringify(snake));
 assert.equal(writes,2);
});

test('a version that moved on reports a refreshable conflict instead of a permission error', {timeout:60000}, async t=>{
 const app=await profile(t);
 let writes=0;
 app.route((req,res,reply)=>{
   const path=req.url.pathname;
   const send=result=>{reply({success:true,result});return true;};
   if(path.endsWith('/getPermCode')) return send({codeList:['sales-plan:plan:region-approve']});
   // 提交时重新读到的版本已经被别人推到下一节点（状态 1 → 2）。
   if(path.endsWith('/plans/p')) return send({
     currentVersion:{id:'v',planId:'p',status:2,effective:true,planTypeCode:'Y'},skus:[],versions:[],logs:[],
     actionContext:{versionId:'v',status:2,snapshotHash:'a'.repeat(64),policy:'role-visible-v1',allowedActions:[],roleActions:[{role:'province',allowedActions:['APPROVE','REJECT']}]},
   });
   if(path.endsWith('/versions/v/actions')) { writes++; return send({}); }
 });
 await app.login();
 const result=await app.rpc('sales-plan/action',{planId:'p',versionId:'v',requestId:'stale-version',idempotencyKey:'stale-version',request:{action:'REJECT',approvalRole:'region',expectedStatus:1,remark:'退回原因'}});
 assert.equal(result.ok,false);
 assert.equal(result.error.code,'GEA_HTTP_409');
 assert.match(result.error.message,/请刷新权威队列/);
 assert.equal(writes,0);
});

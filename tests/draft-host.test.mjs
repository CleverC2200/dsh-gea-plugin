import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from './profile.mjs';

/** Host 侧草稿能力闸门：既不能把界面能编辑的对象判成不可写，也不能凭登录权限放行。 */
test('Host saves a private draft for every shape the workbench can edit', {timeout:60000}, async t=>{
 const app=await profile(t);
 const snapshot='a'.repeat(64);
 const sku={id:'s',skuCode:'1001',versionId:'v',qty:'22',regionConfirmedQty:null,provinceConfirmedQty:'8',amt:'1132.72',price:'141.59'};
 let mode='multi-role';
 app.route((req,_res,reply)=>{
  const path=req.url.pathname;
  const send=result=>{reply({success:true,result});return true;};
  if(path.endsWith('/getPermCode')) return send({codeList:[]});
  if(path.endsWith('/notifications/n')) return send({id:'n',approval:{biz_key:'sales-plan:version:v',instance_id:'i',actionable:true}});
  if(path.endsWith('/notifications')) return send(mode==='workflow-task'
   ? {items:[{id:'n',approval:{biz_key:'sales-plan:version:v',instance_id:'i',actionable:true}}],total:1}
   : {items:[],total:0});
  if(path.endsWith('/plans/p')) {
   const actionContext=mode==='workflow-task' ? undefined : {
     versionId:'v',status:2,snapshotHash:snapshot,policy:'role-visible-v1',allowedActions:[],
     roleActions:(mode==='multi-role'?['region','province']:['region']).map(role=>({role,allowedActions:['SAVE','APPROVE','REJECT']})),
   };
   return send({currentVersion:{id:'v',planId:'p',status:2,effective:true,planTypeCode:'Y'},skus:[sku],versions:[],logs:[],...(actionContext?{actionContext}:{})});
  }
  return false;
 });
 await app.login();
 const draftOf=async()=> (await app.rpc('sales-plan/draft',{planId:'p',versionId:'v'})).value;
 const source=await draftOf();
 assert.equal(typeof source.sourceSnapshot,'string');
 const write=(approvalRole,adjustQty,extra={})=>app.rpc('sales-plan/draft',{planId:'p',versionId:'v',...(approvalRole?{approvalRole}:{}),
  draft:{planId:'p',versionId:'v',status:2,sourceSnapshot:source.sourceSnapshot,remark:'',adjustments:[{skuCode:'1001',adjustQty}],...(approvalRole?{role:approvalRole}:{})},...extra});

 // 多角色账号：界面能编辑，Host 也必须能落草稿（曾经的必失败场景）。
 const multiRole=await write('province','2');
 assert.equal(multiRole.ok,true,JSON.stringify(multiRole));
 assert.deepEqual((await draftOf()).draft.adjustments,[{skuCode:'1001',adjustQty:'2'}]);

 // 不带角色回退时仍按节点顺序解析，不再因为“角色不唯一”直接判死。
 assert.equal((await write(undefined,'2')).ok,true);

 // 取值基线按界面使用的角色计算：region 视图看到的是 qty=22，改到 10 必须被接受。
 const regionView=await write('region','-12');
 assert.equal(regionView.ok,true,JSON.stringify(regionView));
 assert.deepEqual((await draftOf()).draft.adjustments,[{skuCode:'1001',adjustQty:'-12'}]);

 // 同一基线下的非法结果（负数量）仍要被拒绝，且不能覆盖已验证草稿。
 const negative=await write('province','-20');
 assert.equal(negative.ok,false,'负数结果仍必须被拒绝');
 assert.deepEqual((await draftOf()).draft.adjustments,[{skuCode:'1001',adjustQty:'-12'}]);

 // 伪造来源快照必须被拒绝，不能覆盖已验证草稿。
 const forged=await write('province','2',{draft:{planId:'p',versionId:'v',status:2,sourceSnapshot:'forged',remark:'',adjustments:[{skuCode:'1001',adjustQty:'2'}],role:'province'}});
 assert.equal(forged.ok,false);
 assert.deepEqual((await draftOf()).draft.adjustments,[{skuCode:'1001',adjustQty:'-12'}]);

 // 角色必须是真实审批节点。
 assert.equal((await write('admin','2')).ok,false);

 // 没有角色契约时，服务端同版本可处理任务也构成依据。
 mode='workflow-task';
 const workflowTask=await write('province','2');
 assert.equal(workflowTask.ok,true,JSON.stringify(workflowTask));
});

test('Host stores a private draft for a readable returned plan without approval capability', {timeout:60000}, async t=>{
 const app=await profile(t);
 // 真实生产形态：status 8（被省区退回）、无 actionContext、无可处理通知、账号也没有 sales-plan 权限。
 // 界面自 0.0.59 起按“详情可读”开放编辑入口，所以本地草稿只校验身份、新鲜度和形状，不校验审批能力。
 app.route((req,_res,reply)=>{
  const path=req.url.pathname;
  const send=result=>{reply({success:true,result});return true;};
  if(path.endsWith('/getPermCode')) return send({codeList:['sales-plan:plan:province-approve']});
  if(path.endsWith('/notifications')) return send({items:[],total:0});
  if(path.endsWith('/plans/p')) return send({currentVersion:{id:'v',planId:'p',status:8,effective:true,planTypeCode:'Y'},
   skus:[{id:'s',skuCode:'1001',versionId:'v',qty:'22',regionConfirmedQty:'8',amt:'1132.72',price:'141.59'}],versions:[],logs:[]});
  return false;
 });
 await app.login();
 const source=(await app.rpc('sales-plan/draft',{planId:'p',versionId:'v'})).value;
 const result=await app.rpc('sales-plan/draft',{planId:'p',versionId:'v',approvalRole:'province',
  draft:{planId:'p',versionId:'v',status:8,sourceSnapshot:source.sourceSnapshot,remark:'',adjustments:[{skuCode:'1001',adjustQty:'2'}],role:'province'}});
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual((await app.rpc('sales-plan/draft',{planId:'p',versionId:'v'})).value.draft.adjustments,[{skuCode:'1001',adjustQty:'2'}]);

 // 格式与新鲜度仍然是硬门槛：逻辑不成立的草稿不能落盘覆盖已验证内容。
 const negative=await app.rpc('sales-plan/draft',{planId:'p',versionId:'v',approvalRole:'province',
  draft:{planId:'p',versionId:'v',status:8,sourceSnapshot:source.sourceSnapshot,remark:'',adjustments:[{skuCode:'1001',adjustQty:'-20'}],role:'province'}});
 assert.equal(negative.ok,false,'负数结果仍必须被拒绝');
 const forged=await app.rpc('sales-plan/draft',{planId:'p',versionId:'v',approvalRole:'province',
  draft:{planId:'p',versionId:'v',status:8,sourceSnapshot:'forged',remark:'',adjustments:[{skuCode:'1001',adjustQty:'2'}],role:'province'}});
 assert.equal(forged.ok,false,'伪造快照仍必须被拒绝');
 assert.deepEqual((await app.rpc('sales-plan/draft',{planId:'p',versionId:'v'})).value.draft.adjustments,[{skuCode:'1001',adjustQty:'2'}]);
});

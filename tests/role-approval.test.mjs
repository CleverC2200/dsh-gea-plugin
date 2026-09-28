import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles} = await build({stdin:{contents:[
  "export * from './src/workbench/original/workbenches/regionalApproval/models/salesPlanAccessModel.ts';",
  "export * from './src/workbench/original/workbenches/regionalApproval/models/salesPlanActionModel.ts';",
  "export * from './src/workbench/original/workbenches/regionalApproval/models/salesPlanCorrectionModel.ts';",
].join('\n'),resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const m = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
const hash='a'.repeat(64);
const row=(status=2,type='Y')=>({planId:'p',versionId:'v',status,planTypeCode:type});
const detail=(status=2,type='Y')=>({currentVersion:{id:'v',planId:'p',effective:true,status,planTypeCode:type},skus:[],versions:[],logs:[]});
const policy=(roles=['region'],status=2)=>({versionId:'v',status,snapshotHash:hash,policy:'role-visible-v1',allowedActions:[],roleActions:roles.map(role=>({role,allowedActions:['SAVE','APPROVE','REJECT']}))});
test('visible role can act on pending and returned plans without a resubmit service account',()=>{
  for(const status of [1,2,3,4,6,7,8,9]) {
    const access=m.salesPlanAccessForRow(row(status),detail(status),['region']);
    assert.equal(access.approvalRole,'region');
    assert.deepEqual(access.allowedActions,['APPROVE','REJECT']);
  }
  for(const status of [0,5,10]) assert.equal(m.salesPlanAccessForRow(row(status),detail(status),['region']),undefined);
  for(const status of [2,3,4,6,8,9]) assert.equal(m.salesPlanAccessForRow(row(status,'XN'),detail(status,'XN'),['province']).approvalRole,'province');
});

test('returned plans use the explicitly granted role, never the return target as authority',()=>{
  for (const [status,role] of [[6,'region'],[7,'province'],[8,'area'],[9,'category']]) {
    const d={...detail(status),actionContext:policy([],status)};
    assert.deepEqual(m.salesPlanAccessForRow(row(status),d,[role],role).allowedActions,['APPROVE','REJECT']);
    assert.equal(m.salesPlanAccessForRow(row(status),d,[],role),undefined);
    assert.equal(m.salesPlanAccessForRow(row(status),{...d,currentVersion:{...d.currentVersion,effective:false}},[role],role),undefined);
    assert.equal(m.salesPlanAccessForRow(row(status),{...d,actionContext:{...d.actionContext,status:1}},[role],role),undefined);
  }
});
test('a notification is only a reminder: it never grants approval identity',()=>{
  const d={...detail(),workflowApproval:{versionId:'v',notificationId:'n',instanceId:'i',actionable:true}};
  // 有没有待办任务都不影响身份：身份只看账号角色。
  assert.equal(m.salesPlanAccessForRow(row(),d),undefined);
  assert.equal(m.salesPlanAccessForRow(row(),d,['province']).approvalRole,'province');
  assert.equal(m.salesPlanAccessForRow(row(),{...d,workflowApproval:{...d.workflowApproval,versionId:'old'}},['province']).approvalRole,'province');
  assert.equal(m.salesPlanAccessForRow(row(),{...d,workflowApproval:undefined},['region']).approvalRole,'region');
});
test('object capability adds actions but never grants identity, and stays freshness-checked',()=>{
  const d={...detail(),actionContext:policy(['region','province'])};
  assert.equal(m.salesPlanAccessForRow(row(),d,[],'region'),undefined);
  const granted=m.salesPlanAccessForRow(row(),d,['region'],'region');
  assert.equal(granted.roleContractSupported,true);
  assert.deepEqual(granted.allowedActions,['APPROVE','REJECT','SAVE']);
  assert.deepEqual(m.salesPlanAccessForRow(row(),d,['province'],'province').allowedActions,['APPROVE','REJECT','SAVE']);
  for(const bad of [{...d,currentVersion:{...d.currentVersion,effective:false}},{...d,actionContext:{...d.actionContext,snapshotHash:'bad'}},{...d,actionContext:{...d.actionContext,roleActions:[{role:'region',allowedActions:['DELETE']}]} }])
    assert.equal(m.salesPlanAccessForRow(row(),bad,['region'],'region'),undefined);
  for(const status of [0,5,10]) assert.equal(m.salesPlanAccessForRow(row(status),{...detail(status),actionContext:policy(['region'],status)},['region'],'region'),undefined);
});
test('granted visible role remains actionable when object capabilities only track the notified node',()=>{
  const d={...detail(),actionContext:{...policy([],2),roleActions:[]}};
  const access=m.salesPlanAccessForRow(row(2),d,['region'],'region');
  assert.equal(access.roleContractSupported,true);
  assert.deepEqual(access.allowedActions,['APPROVE','REJECT']);
  assert.equal(m.salesPlanAccessForRow(row(2),d,[],'region'),undefined);
});
test('quantity inheritance follows selected role rather than notification status',()=>{
  const sku={qty:'10',regionConfirmedQty:'12',provinceConfirmedQty:'20',areaConfirmedQty:'30'};
  assert.equal(m.salesPlanEditableQuantity(sku,3,'Y','region'),'12');
  assert.equal(m.salesPlanEditableQuantity({...sku,regionConfirmedQty:null},3,'Y','region'),'10');
  assert.equal(m.salesPlanEditableQuantity({...sku,provinceConfirmedQty:null},3,'XN','province'),'10');
});
test('role receipt verifies actor, configured return target and all required approvals before 5',()=>{
  const input={planId:'p',versionId:'v',planTypeCode:'Y',serverRoleResult:true,request:{action:'APPROVE',expectedStatus:2,approvalRole:'region'}};
  const receipt={planId:'p',versionId:'v',fromStatus:2,toStatus:2,requestId:'r',traceId:'t',auditId:'a',approvalRole:'region'};
  assert.equal(m.salesPlanActionReceiptMatches(input,'r',receipt),true);
  assert.equal(m.salesPlanActionReceiptMatches(input,'r',{...receipt,approvalRole:'province'}),false);
  assert.equal(m.salesPlanActionReceiptMatches(input,'r',{...receipt,toStatus:5,approvedRoles:['category']}),false);
  assert.equal(m.salesPlanActionReceiptMatches(input,'r',{...receipt,toStatus:5,approvedRoles:['region','province','area','category']}),true);
  const reject={...input,planTypeCode:'XN',request:{...input.request,action:'REJECT',approvalRole:'province'}};
  assert.equal(m.salesPlanActionReceiptMatches(reject,'r',{...receipt,approvalRole:'province',toStatus:6}),true);
  assert.equal(m.salesPlanActionReceiptMatches(reject,'r',{...receipt,approvalRole:'province',toStatus:7}),false);
});
test('correction role authority ignores approval date window and uses selected-role data',()=>{
  const d={...detail(),currentVersion:{...detail().currentVersion,orderType:'Z'},correctionContext:{contract:'absolute-net-v1',monthlyApproved:true,approvalOpen:false},actionContext:policy()};
  const returned={...d,currentVersion:{...d.currentVersion,status:7},actionContext:policy(['region'],7)};
  assert.equal(m.correctionAccess(returned,undefined,'region',['region']).approvalRole,'region');
  assert.equal(m.correctionAccess(returned,undefined,'region'),undefined);
  assert.equal(m.correctionAccess({...d,correctionContext:{...d.correctionContext,monthlyApproved:false}},undefined,'region',['region']),undefined);
  assert.equal(m.correctionDecision({qty:'10',price:'2',adjAddQty:'1',adjCutQty:'0',regionAdjAddQty:'3',regionAdjCutQty:'0',provinceAdjAddQty:'8',provinceAdjCutQty:'0'},3,'Y',true,undefined,'region'),'3');
});

test('visibility is a union across granted roles, with one explicitly chosen acting role',()=>{
 const grantedStages=['region','category'];
 assert.equal(m.salesPlanAccessForRow(row(1),detail(1),grantedStages,'category').approvalRole,'category');
 const xn=m.salesPlanAccessForRow(row(2,'XN'),detail(2,'XN'),['province','region'],'region');
 assert.deepEqual(xn.allowedActions,['APPROVE']);
});

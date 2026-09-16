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
const grant=role=>`sales-plan:plan:${role}-approve`;
const policy=(roles=['region'],status=2)=>({versionId:'v',status,snapshotHash:hash,policy:'role-visible-v1',allowedActions:[],roleActions:roles.map(role=>({role,allowedActions:['SAVE','APPROVE','REJECT']}))});
test('visible role can act while another node is notified, including own rejected plan',()=>{
  for(const status of [1,2,3,4,6,7]) {
    const access=m.salesPlanAccessForRow(row(status),detail(status),[grant('region')]);
    assert.equal(access.approvalRole,'region');
    assert.deepEqual(access.allowedActions,['APPROVE','REJECT']);
  }
  for(const status of [0,5,8,9,10]) assert.equal(m.salesPlanAccessForRow(row(status),detail(status),[grant('region')]),undefined);
  for(const status of [2,3,4,6,8]) assert.equal(m.salesPlanAccessForRow(row(status,'XN'),detail(status,'XN'),[grant('province')]).approvalRole,'province');
});
test('notifications grant nothing and multi-role selection is explicit',()=>{
  const d={...detail(),workflowApproval:{versionId:'v',actionable:true}};
  assert.equal(m.salesPlanAccessForRow(row(),d),undefined);
  const roles=[grant('region'),grant('province')];
  assert.equal(m.salesPlanAccessForRow(row(),d,roles),undefined);
  assert.equal(m.salesPlanAccessForRow(row(),d,roles,'region').approvalRole,'region');
  assert.equal(m.salesPlanAccessForRow(row(),d,roles,'category'),undefined);
});
test('new object capability is role-specific, freshness-checked and terminal-safe',()=>{
  const d={...detail(),actionContext:policy(['region','province'])};
  assert.equal(m.salesPlanAccessForRow(row(),d,[],'region').roleContractSupported,true);
  assert.deepEqual(m.salesPlanAccessForRow(row(),d,[],'province').allowedActions,['SAVE','APPROVE','REJECT']);
  for(const bad of [{...d,currentVersion:{...d.currentVersion,effective:false}},{...d,actionContext:{...d.actionContext,snapshotHash:'bad'}},{...d,actionContext:{...d.actionContext,roleActions:[{role:'region',allowedActions:['DELETE']}]} }])
    assert.equal(m.salesPlanAccessForRow(row(),bad,[],'region'),undefined);
  for(const status of [0,5,10]) assert.equal(m.salesPlanAccessForRow(row(status),{...detail(status),actionContext:policy(['region'],status)},[],'region'),undefined);
});
test('granted visible role remains actionable when object capabilities only track the notified node',()=>{
  const d={...detail(),actionContext:{...policy([],2),roleActions:[]}};
  const access=m.salesPlanAccessForRow(row(2),d,[grant('region')],'region');
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
  assert.equal(m.correctionAccess(d,undefined,'region').approvalRole,'region');
  assert.equal(m.correctionAccess({...d,correctionContext:{...d.correctionContext,monthlyApproved:false}},undefined,'region'),undefined);
  assert.equal(m.correctionDecision({qty:'10',price:'2',adjAddQty:'1',adjCutQty:'0',regionAdjAddQty:'3',regionAdjCutQty:'0',provinceAdjAddQty:'8',provinceAdjCutQty:'0'},3,'Y',true,undefined,'region'),'3');
});

test('visibility is a union across granted roles, with one explicitly chosen acting role',()=>{
 const permissions=[grant('region'),grant('category')];
 assert.equal(m.salesPlanAccessForRow(row(1),detail(1),permissions,'category').approvalRole,'category');
 const xn=m.salesPlanAccessForRow(row(2,'XN'),detail(2,'XN'),[grant('province'),grant('region')],'region');
 assert.deepEqual(xn.allowedActions,['APPROVE']);
});

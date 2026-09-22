import test from 'node:test';
import assert from 'node:assert/strict';
let api;try{api=await import('../src/host/navigation-target.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;api={};}
const resolved=(version=1)=>({navigationIntentId:'intent-1',schemaVersion:version,target:version===1?{type:'AGENT',agentCode:'sales_forecast'}:{type:'INTERACTION_REQUEST',agentCode:'sales_forecast',interactionRequestId:'ir-1'},expiresAt:new Date(Date.now()+60000).toISOString(),traceId:'trace-1'});
test('导航只映射已声明 Agent，拒绝错误版本与过期目标',async()=>{
  assert.equal(typeof api.resolveNavigationTarget,'function');
  const request=async()=>resolved();
  const result=await api.resolveNavigationTarget(request,{navigationReference:'abc',schemaVersion:1},'sales_forecast');
  assert.equal(result.panel,'gea-proof');assert.equal(result.intentId,'intent-1');
  await assert.rejects(api.resolveNavigationTarget(request,{navigationReference:'abc',schemaVersion:1},'different'),/NAVIGATION_TARGET_UNSUPPORTED/);
  await assert.rejects(api.resolveNavigationTarget(async()=>resolved(2),{navigationReference:'abc',schemaVersion:1},'sales_forecast'),/NAVIGATION_INVALID_RESPONSE/);
  await assert.rejects(api.resolveNavigationTarget(async()=>({...resolved(),expiresAt:0}),{navigationReference:'abc',schemaVersion:1},'sales_forecast'),/NAVIGATION_REFERENCE_EXPIRED/);
});
test('待办分页匹配 interaction_request_id 并回读详情，不把 IR ID 当作通知 ID',async()=>{
  assert.equal(typeof api.resolveNavigationTarget,'function');const paths=[];
  const request=async(path)=>{paths.push(path);if(path.endsWith('/resolve'))return resolved(2);
    if(path.includes('pageNo=1'))return {items:[{id:'wrong',interaction_request_id:'ir-other'}],total:101};
    if(path.includes('pageNo=2'))return {items:[{id:'notice-right',interaction_request_id:'ir-1'}],total:101};
    assert.equal(path,'/api/v1/notifications/notice-right');return {id:'notice-right',interaction_request_id:'ir-1'};};
  const result=await api.resolveNavigationTarget(request,{navigationReference:'abc',schemaVersion:2},'sales_forecast');
  assert.equal(result.panel,'gea-inbox');assert.equal(result.notificationId,'notice-right');assert.equal(result.interactionRequestId,'ir-1');assert.equal(paths.length,4);
  await assert.rejects(api.resolveNavigationTarget(async(path)=>path.endsWith('/resolve')?resolved(2):{items:[],total:0},{navigationReference:'abc',schemaVersion:2},'sales_forecast'),/NAVIGATION_TARGET_UNAVAILABLE/);
});
test('通知详情关系发生变化时拒绝导航',async()=>{
  assert.equal(typeof api.resolveNavigationTarget,'function');
  const request=async(path)=>path.endsWith('/resolve')?resolved(2):path.includes('pageNo=')?{items:[{id:'notice',interaction_request_id:'ir-1'}],total:1}:{id:'notice',interaction_request_id:'another'};
  await assert.rejects(api.resolveNavigationTarget(request,{navigationReference:'abc',schemaVersion:2},'sales_forecast'),/NAVIGATION_TARGET_UNAVAILABLE/);
});
test('缺失或非字符串 Reference 在调用上游前拒绝',async()=>{
  for(const reference of [undefined,null,123,{},''])await assert.rejects(api.resolveNavigationTarget(()=>assert.fail('非法输入不应发请求'),{navigationReference:reference,schemaVersion:1},'sales_forecast'),/NAVIGATION_REQUEST_INVALID/);
});

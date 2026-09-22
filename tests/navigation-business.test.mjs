import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const output=await build({stdin:{contents:"export {Business} from './src/host/business.ts'",resolveDir:process.cwd()},bundle:true,packages:'external',write:false,platform:'node',format:'cjs'});
const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const fixture=()=>{const business=new module.exports.Business({geaBaseUrl:'https://gea.example.test',analysisAgentCode:'sales_forecast',requestTimeoutMs:1000});
  business.restoreDesktopLogin({schema:1,environment:'production',base:'https://gea.example.test',auth:{token:'fixture-private-token',tenantId:'1',name:'Test',id:'user-1',username:'test'}});return business;};
const response=()=>Response.json({success:true,result:{navigationIntentId:'intent-1',schemaVersion:1,target:{type:'AGENT',agentCode:'sales_forecast'},expiresAt:Date.now()+60000,traceId:'trace-1'}});
test('实际 Business 导航沿用当前用户，Reference 不进入日志中心，ACK 保持唯一契约',async t=>{
  const business=fixture();t.after(()=>business.dispose());const requests=[];
  t.mock.method(globalThis,'fetch',async(url,init)=>{requests.push([url,init]);assert.equal(init.headers['X-Access-Token'],'fixture-private-token');assert.equal(init.headers['X-Tenant-Id'],'1');return url.endsWith('/ack')?Response.json({success:true,result:null}):response();});
  const target=await business.resolveClientNavigation({navigationReference:'private-reference',schemaVersion:1},new AbortController().signal);
  assert.equal(target.panel,'gea-proof');assert.equal(requests[0][0],'https://gea.example.test/ai/gateway/client-navigation-intents/resolve');
  assert.deepEqual(JSON.parse(requests[0][1].body),{navigationReference:'private-reference',schemaVersion:1});
  await business.acknowledgeClientNavigation('intent-1','key-1',new AbortController().signal);
  assert.deepEqual(JSON.parse(requests[1][1].body),{stage:'TARGET_VISIBLE',result:'SUCCESS',idempotencyKey:'key-1'});
  const log=JSON.stringify(business.apiLogSnapshot({}));assert.ok(!log.includes('private-reference'));assert.ok(!log.includes('fixture-private-token'));
});
test('实际 Business 拒绝退出登录后的迟到响应；业务拒绝只返回稳定码',async t=>{
  const business=fixture();t.after(()=>business.dispose());let release;
  t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>release=resolve));
  const reading=business.resolveClientNavigation({navigationReference:'private-reference',schemaVersion:1},new AbortController().signal);business.logout({});release(response());await assert.rejects(reading);
  const other=fixture();t.after(()=>other.dispose());t.mock.method(globalThis,'fetch',async()=>Response.json({success:false,errorCode:'NAVIGATION_REFERENCE_FORBIDDEN',message:'private-reference'}));
  await assert.rejects(other.resolveClientNavigation({navigationReference:'private-reference',schemaVersion:1},new AbortController().signal),/^Error: NAVIGATION_REFERENCE_FORBIDDEN$/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from './profile.mjs';

test('official Host enforces readonly admission before payload processing and status reads spend no metadata', {timeout:60000}, async t => {
  const app = await profile(t, {config:{workbenchCapability:{enabled:true,readonlyValidation:{maxRequests:0,periods:0,list:0,detail:0,versionSkus:0,workflowSql:0,maxWorkflowRows:200,metadata:0}}}});
  const before = app.requests.length;
  for (const endpoint of ['prepare','submit','workbench/prepare','sales-plan/draft','sales-plan/action','sales-plan/submit','model/advice','model/discover','api-log/replay','api-log/clear','login/start','logout','environment/select']) {
    const response = await fetch(app.origin + '/api/gea-proof/' + endpoint, {method:'POST',headers:{Cookie:app.cookie,Origin:app.origin,'Content-Type':'application/json'},body:'{invalid'});
    assert.equal(response.status,200);
    const result = await response.json();
    assert.equal(result.ok,false,endpoint);
    assert.equal(result.error.code,'GEA_SALES_READONLY_OPERATION',endpoint);
  }
  for (const endpoint of ['status','status']) {
    const result = await app.rpc(endpoint);
    assert.equal(result.ok,true);
    assert.equal(result.value.authenticated,false);
    assert.equal(result.value.readonlyValidation.spent.metadata,0);
  }
  assert.equal((await app.rpc('workflow/config')).error.code,'GEA_SALES_READONLY_LIMIT');
  assert.equal((await app.rpc('workbench/query',{kind:'periods'})).error.code,'GEA_SALES_READONLY_LIMIT');
  assert.equal((await app.rpc('workbench/query',{kind:'versions'})).error.code,'GEA_SALES_READONLY_QUERY');
  assert.equal(app.requests.length,before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { profile } from './profile.mjs';
const planId = 'p-jxs-2026-10-00001';
const version = { id: 'v1', planId, periodId: '123', planTypeCode: 'Y', orderType: 'M', status: 7, effective: true, seq: 1, dealerCode: '456', targetQty: '1.000', targetAmount: '12.34' };
const sku = { id: 's1', versionId: 'v1', skuCode: '789', productCategName: 'Category', baseQty: '1.000', qty: '2.000', price: '12.3400', amt: '24.68', amtBase: '12.34' };
const request = { orderType: 'M', status: 2, periodId: '123', periodMonth: '2026-10', planTypeCode: 'Y', channelCode: 'jxs', dealerCode: '456', targetQty: '1.000', targetAmount: '12.34', submitterCode: '9007199254740993', submitterName: '测试用户', items: [{ skuCode: '789', productCategName: 'Category', baseQty: '1.000', qty: '2.000', price: '12.3400' }] };
test('Host revalidates source, rejects forged values and binds retries to one identity and body', { timeout: 60000 }, async t => {
  const app = await profile(t, { config: { serviceAccounts: { production: { clientIdEnv: 'GEA_SUBMIT_CLIENT', clientSecretEnv: 'GEA_SUBMIT_SECRET', tenantId: '0', allowedUserIds: ['9007199254740993'] } } }, env: { GEA_SUBMIT_CLIENT: 'fixture-client', GEA_SUBMIT_SECRET: 'fixture-secret' } });
  let writes = 0;
  app.route((req, res, reply) => {
    const path = req.url.pathname;
    if (path.endsWith('/plans')) { const status = req.url.searchParams.get('status'); const records = status && status !== '7' ? [] : [{ ...version, versionId: 'v1', orgName: 'Fixture returned region', orgCode: 'org', currentQty: '2.000', currentAmount: '24.68' }]; reply({ success: true, result: { records, total: records.length, pages: 1, current: 1, size: 20 } }); return true; }
    if (path.endsWith('/versions')) { reply({ success: true, result: [version] }); return true; }
    if (path.endsWith('/plans/' + planId)) { reply({ success: true, result: { currentVersion: version, versions: [version], skus: [sku], logs: [] } }); return true; }
    if (path.endsWith('/versions/v1/skus')) { reply({ success: true, result: [sku] }); return true; }
    if (path.endsWith('/periods')) { assert.equal(req.url.searchParams.get('planType'), null, 'planType uses MONTHLY, not business code Y'); reply({ success: true, result: { records: [{ periodId: '123', periodMonth: '2026-10', planTypeCode: 'Y', status: 'CLOSED' }], total: 1, current: 1, size: 100 } }); return true; }
    if (path.endsWith('/api/v1/internal/auth/token')) { assert.equal(req.headers['x-access-token'], undefined); reply({ success: true, result: { access_token: 'fixture-service', token_type: 'Bearer', expires_in: 600, scope: 'sales-plan:write' } }); return true; }
    if (path.endsWith('/api/v1/internal/sales-plans')) { writes++; assert.equal(req.headers.authorization, 'Bearer fixture-service'); assert.deepEqual(JSON.parse(req.body), request); reply({ success: true, result: { planId, versionId: 'v2', seq: 2, status: 2, replayed: false, requestId: req.headers['x-request-id'], traceId: 'trace', auditId: 'audit' } }); return true; }
    return false;
  });
  await app.login();
  assert.equal((await app.rpc('status')).value.resubmitConnected, true);
  // V1.6 removed the monthly toolbar entry; the retained Host contract is tested directly.
  const detail = await app.rpc('workbench/query', {kind:'detail',query:{planId}});
  assert.equal(detail.ok,true);
  assert.equal(detail.value.currentVersion.id,'v1');
  assert.equal(writes, 0);
  const command = { source: { planId, versionId: 'v1' }, request, requestId: 'request', idempotencyKey: 'idem' };
  const forged = await app.rpc('sales-plan/submit', { ...command, idempotencyKey: 'forged', request: { ...request, submitterCode: 'other' } });
  assert.equal(forged.ok, false); assert.equal(writes, 0);
  const forgedPrice = await app.rpc('sales-plan/submit', { ...command, idempotencyKey: 'forged-price', request: { ...request, items: [{...request.items[0],price:'0.01'}] } });
  assert.equal(forgedPrice.ok,false); assert.equal(writes,0);
  const result = await app.rpc('sales-plan/submit', command);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.versionId, 'v2');
  assert.equal((await app.rpc('sales-plan/submit', command)).ok, true);
  assert.equal(writes, 1);
  assert.equal((await app.rpc('sales-plan/submit', { ...command, request: { ...request, status: 3 } })).ok, false);
  await app.rpc('logout');
  assert.equal((await app.rpc('sales-plan/submit', command)).ok, false);
});

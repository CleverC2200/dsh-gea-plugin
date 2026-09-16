import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
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
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split('; ').map(pair => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: app.origin })));
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: '内测声明', exact: true }).getByRole('button', { name: '继续', exact: true }).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await frame.getByRole('button', { name: /2 区域审批/ }).click();
  await frame.getByRole('tab', { name: '按客户', exact: true }).click();
  await expect(frame.getByRole('button', { name: '刷新数据', exact: true })).toBeEnabled();
  await frame.locator('label.arco-checkbox:has(input[value="' + planId + '"])').click();
  await frame.getByRole('button', { name: '重提', exact: true }).click();
  const dialog = frame.getByRole('dialog', { name: '真实销售计划退回重提', exact: true });
  await expect(dialog.getByRole('button', { name: '确认重提', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox').fill('3.000');
  await expect(dialog).toContainText('37.02');
  await dialog.locator('label.arco-checkbox').click();
  await expect(dialog.getByRole('button', { name: '确认重提', exact: true })).toBeEnabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  assert.equal(writes, 0);
  const command = { source: { planId, versionId: 'v1' }, request, requestId: 'request', idempotencyKey: 'idem' };
  const forged = await app.rpc('sales-plan/submit', { ...command, idempotencyKey: 'forged', request: { ...request, submitterCode: 'other' } });
  assert.equal(forged.ok, false); assert.equal(writes, 0);
  const result = await app.rpc('sales-plan/submit', command);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.versionId, 'v2');
  assert.equal((await app.rpc('sales-plan/submit', command)).ok, true);
  assert.equal(writes, 1);
  assert.equal((await app.rpc('sales-plan/submit', { ...command, request: { ...request, status: 3 } })).ok, false);
  await app.rpc('logout');
  assert.equal((await app.rpc('sales-plan/submit', command)).ok, false);
});

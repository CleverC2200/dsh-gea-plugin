import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 上级退回给本节点的单据，要能在这里改完继续提交：
 * 退回态（如 8=退回省区）对该节点的审批人可写，提交后按流程推进到下一节点（8 → 3）。
 * 退回给别的节点的单子仍然不可写。
 */
const plan = {
  planId: 'p8', versionId: 'v8', periodId: '20260901', planTypeCode: 'Y', orderType: 'M', status: 8,
  baseName: '退回省区单', orgCode: 'region-8', orgName: '退回省区单', dealerCode: 'c8',
  currentQty: '100', currentAmount: '1000', targetQty: '100', targetAmount: '1000', skuCount: 1,
};
const sku = {
  id: 's1', skuCode: '1001', versionId: 'v8', productCategName: '汤圆', skuName: '黑芝麻汤圆',
  qty: '100', baseQty: '100', amt: '1000', amtBase: '1000', price: '10',
  regionConfirmedQty: '100', provinceConfirmedQty: null,
};

test('a plan returned to this node can be resubmitted here', { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:province-approve'] });
    if (path.endsWith('/periods')) return send({ records: [{ periodId: '20260901', periodMonth: '2026-09', planTypeCode: 'Y', status: 'OPEN' }], total: 1, current: 1, size: 100 });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const records = status === null || status === '8' ? [plan] : [];
      return send({ records, total: records.length, current: 1, size: Number(req.url.searchParams.get('pageSize') || 20), pages: 1 });
    }
    if (path.endsWith('/plans/p8')) {
      return send({ currentVersion: { ...plan, id: 'v8', effective: true, returnReason: '促销依据待补充' }, versions: [{ ...plan, id: 'v8', effective: true }], skus: [sku], logs: [] });
    }
    if (path.endsWith('/plans/p8/versions')) return send([{ ...plan, id: 'v8', effective: true }]);
    if (path.endsWith('/versions/v8/skus')) return send([sku]);
    if (path.endsWith('/versions/v8/actions')) {
      writes.push(JSON.parse(req.body));
      // 退回态经本节点继续提交：流程推进到下一节点（省区 8 → 大区待审 3）。
      return send({ planId: plan.planId, versionId: plan.versionId, fromStatus: 8, toStatus: 3, requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
    }
    if (path.endsWith('/notifications')) return send({ items: [], total: 0 });
    return false;
  });
  await app.login();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split('; ').map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: app.origin })));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: '内测声明', exact: true }).getByRole('button', { name: '继续', exact: true }).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
  await expect(frame.getByTestId('regional-approval-flow-toggle')).toContainText('当前节点：省区审批');

  const row = frame.locator('tbody tr').filter({ hasText: plan.baseName }).first();
  await expect(row).toBeVisible();
  // 退回给本节点的单据可以勾选（旧行为是 6–9 一律禁用）。
  const checkbox = row.locator('label.arco-checkbox');
  await expect(checkbox).not.toHaveClass(/arco-checkbox-disabled/);
  await checkbox.click();

  const approve = frame.getByRole('button', { name: '通过', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes[0].action, 'APPROVE');
  assert.equal(writes[0].expectedStatus, 8, '退回态以本节点状态提交，由流程推进到下一节点');
  assert.equal(writes[0].approvalRole, undefined, '上游报文只发接口文档声明的字段');
  assert.equal(writes[0].approvalPolicy, undefined);
});

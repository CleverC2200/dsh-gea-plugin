import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 退回态（如 8=退回省区）在管理端只有"退回重提"这条路：重提会生成新版本，
 * 状态按 8→3 回到下一节点；而动作接口只接受 1–4 的待审单。
 * 所以月度页对退回单要收掉"通过/退回"，改给"退回重提"，别再把注定失败的请求发给上游。
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

test('a returned plan offers resubmit instead of approve/reject', { timeout: 90000 }, async (t) => {
  const app = await profile(t, { roles: [{ code: 'sales_plan_province_approver', name: '省区审批' }] });
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
  // 退回单仍然可以勾选——它的出路是退回重提，不是通过/退回。
  const checkbox = row.locator('label.arco-checkbox');
  await expect(checkbox).not.toHaveClass(/arco-checkbox-disabled/);
  await checkbox.click();

  const approve = frame.getByRole('button', { name: '通过', exact: true });
  const reject = frame.getByRole('button', { name: '退回', exact: true });
  // 通过/退回对退回单置灰，并直接说明该走哪条路。
  await expect(approve).toBeDisabled();
  await expect(reject).toBeDisabled();
  await expect(approve).toHaveAttribute('title', /退回的单子不能直接通过或退回/);

  // 退回重提按钮可用，点开的是重提对话框（走生成新版本的提交通道）。
  const resubmit = frame.getByRole('button', { name: '退回重提', exact: true });
  await expect(resubmit).toBeEnabled();
  await resubmit.click();
  await expect(frame.getByRole('dialog', { name: '真实销售计划退回重提', exact: true })).toBeVisible();
  // 退回单不会再往动作接口发写请求。
  assert.equal(writes.length, 0, '退回态不发上游动作请求');
});

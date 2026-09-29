import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 勾选口径必须和「勾上以后按钮能不能用」一致：分组行只要组里还有一条能提交或退回就允许勾选，
 * 整行都不能操作才置灰。否则会出现「点两个不行、点三个才行」这种能勾上却按不动的状态。
 */
test('grouped queue rows stay selectable exactly when the batch buttons can run', { timeout: 90000 }, async (t) => {
  const app = await profile(t, { roles: [{ code: 'sales_plan_province_approver', name: '省区审批' }] });
  const plan = (key, province, status) => ({
    planId: `p-${key}`,
    versionId: `v-${key}`,
    seq: 1,
    orderType: 'M',
    periodId: '20260901',
    planTypeCode: 'Y',
    status,
    baseName: `org-${key}`,
    orgCode: `region-${key}`,
    orgName: `org-${key}`,
    provinceCode: province,
    provinceName: province,
    dealerCode: `c-${key}`,
    currentQty: '1',
    currentAmount: '10',
    targetAmount: '10',
    targetQty: '1',
    skuCount: 0,
  });
  const plans = [
    // P1：代表行是「品类已审批（待回写）」这种不可操作的状态，但组里还有一条待省区审批的计划。
    plan('a1', 'P1', 5), plan('a2', 'P1', 2),
    // P2：两条都能审。
    plan('b1', 'P2', 2), plan('b2', 'P2', 2),
    // P3：整组都不可操作（待回写 + 回写完成）。
    plan('c1', 'P3', 5), plan('c2', 'P3', 10),
    // P4：单条计划，用来验证被服务端拒绝后灰按钮会说明原因。
    plan('d1', 'P4', 2),
  ];
  let denyWrites = false;
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:province-approve'] });
    if (path.endsWith('/periods')) return send({ records: [{ periodId: '20260901', periodMonth: '2026-09', planTypeCode: 'Y', status: 'OPEN' }], total: 1, current: 1, size: 100 });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const rows = plans.filter((row) => status === null || row.status === Number(status));
      const size = Number(req.url.searchParams.get('pageSize') || 20);
      return send({ records: rows.slice(0, size), total: rows.length, current: 1, size, pages: 1 });
    }
    const detail = /\/plans\/(p-[a-z0-9]+)$/.exec(path);
    if (detail) {
      const row = plans.find((item) => item.planId === detail[1]);
      return send(row
        ? { currentVersion: { ...row, id: row.versionId, effective: true }, versions: [], skus: [], logs: [], actionContext: {versionId:row.versionId,status:row.status,nodeOrder:3,allowedActions:row.status===2?["APPROVE","REJECT"]:[],snapshotHash:"a".repeat(64)} }
        : {});
    }
    if (path.endsWith('/skus')) return send([]);
    if (path.endsWith('/actions')) {
      if (denyWrites) { reply({ code: '403', message: '没有权限' }, 403); return true; }
      const versionId = /\/versions\/([^/]+)\/actions$/.exec(path)?.[1];
      return send({ planId: 'p', versionId, fromStatus: 2, toStatus: 2, requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
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
  await page.getByRole('dialog', { name: /内测声明|预览版说明/, exact: true }).getByRole('button', { name: '继续', exact: true }).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await frame.getByRole('heading', { name: '销售计划审批', exact: true }).waitFor();
  if (!(await frame.getByTestId('regional-approval-flow-lane').isVisible()))
    await frame.getByTestId('regional-approval-flow-toggle').click();
  await frame.getByTestId('regional-approval-stage-province').click();
  await page.waitForTimeout(600);
  await frame.getByRole('tab', { name: '按省区', exact: true }).click();
  await page.waitForTimeout(2500);

  const rows = await frame.locator('tbody tr').evaluateAll((nodes) => nodes.map((node) => ({
    text: (node.textContent ?? '').replace(/\s+/g, ' '),
    selectable: !(node.querySelector('label.arco-checkbox')?.className ?? '').includes('disabled'),
  })));
  const rowOf = (province) => rows.find((row) => row.text.includes(province) && row.text.includes('份计划'));
  assert.equal(rows.length, 4, JSON.stringify(rows));
  // P1 的代表行不可操作，但组里还有待审计划：仍然可以勾选。
  assert.equal(rowOf('P1')?.selectable, true, JSON.stringify(rows));
  assert.equal(rowOf('P2')?.selectable, true, JSON.stringify(rows));
  // P3 整组都不可操作：置灰，从源头挡掉「勾上却按不动」。
  assert.equal(rowOf('P3')?.selectable, false, JSON.stringify(rows));

  const checkboxOf = (province) => frame.locator('tbody tr').filter({ hasText: province }).filter({ hasText: '份计划' }).first().locator('label.arco-checkbox').first();
  const approve = frame.getByRole('button', { name: '通过', exact: true });
  const reject = frame.getByRole('button', { name: '退回', exact: true });
  await checkboxOf('P1').click();
  await expect(approve).toBeEnabled();
  await expect(reject).toBeEnabled();
  await checkboxOf('P2').click();
  await expect(approve).toBeEnabled();
  await expect(reject).toBeEnabled();
  await checkboxOf('P1').click();
  await checkboxOf('P2').click();
  await expect(approve).toBeDisabled();
  await expect(reject).toBeDisabled();

  // 被服务端拒绝过的版本，灰按钮要直接说人话解释原因，别让用户猜。
  await frame.locator('tbody tr').filter({ hasText: 'P4' }).first().locator('label.arco-checkbox').first().click();
  await expect(approve).toBeEnabled();
  denyWrites = true;
  await approve.click();
  // 服务端拒绝后该版本在本轮被禁用，灰按钮上直接带上原因，不用用户去猜。
  await expect(approve).toBeDisabled({ timeout: 15000 });
  await expect(approve).toHaveAttribute('title', /服务端已拒绝当前用户权限/, { timeout: 15000 });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

const fixture = async (t) => {
  const app = await profile(t);
  const plan = { planId: 'p', versionId: 'v', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M', dealerCode: 'd', dealerName: '客户A', orgCode: 'org', orgName: '宝阳销售组', provinceCode: 'province', provinceName: '华南省区', areaCode: 'area', areaName: '华南大区', status: 1, currentQty: '20', currentAmount: '200', targetQty: '40', targetAmount: '400', skuCount: 1 };
  const sku = { id: 's', skuCode: '1001', versionId: 'v', productCategName: '汤圆', materialDescription: '黑芝麻汤圆 500g', qty: '20', baseQty: '10', amt: '200', amtBase: '100', price: '10' };
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/plans')) { const status = req.url.searchParams.get('status'); const records = status === null || status === '1' ? [plan] : []; return send({ records, total: records.length, pages: 1, current: 1, size: 20 }); }
    if (path.endsWith('/plans/p')) return send({ currentVersion: { ...plan, id: 'v', effective: true }, skus: [sku], versions: [], logs: [], actionContext: { versionId: 'v', status: 1, nodeOrder: 2, allowedActions: ['APPROVE', 'REJECT'], snapshotHash: 'a'.repeat(64) } });
    if (path.endsWith('/versions')) return send([{ ...plan, id: 'v', effective: true }]);
    if (path.endsWith('/versions/v/skus')) return send([sku]);
    return false;
  });
  await app.login();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split('; ').map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: app.origin })));
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: '内测声明', exact: true }).getByRole('button', { name: '继续', exact: true }).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
  return { frame, page };
};

/** V1.8 #05：流程默认收起，标题行右侧给「当前节点」入口，点开在标题行下方展开，会话内记住状态。 */
test('approval flow lane is collapsed by default and toggles from the title row', { timeout: 90000 }, async (t) => {
  const { frame, page } = await fixture(t);
  const lane = frame.getByTestId('regional-approval-flow-lane');
  const toggle = frame.getByTestId('regional-approval-flow-toggle');
  await expect(toggle).toBeVisible();
  // 默认收起：流程条不可见，入口显示用户所属节点。
  await expect(lane).toBeHidden();
  await expect(toggle).toContainText('当前节点：城市经理审批');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  // 收起态仍然能看到队列。
  await expect(frame.getByTestId('regional-approval-queue-footer')).toBeVisible();

  // 点开在标题行下方展开，五个节点可见。
  await toggle.click();
  await expect(lane).toBeVisible();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await expect(frame.locator('[data-testid^="regional-approval-stage-"]')).toHaveCount(5);

  // 同一次会话内记住展开状态：刷新后仍是展开。
  await page.reload();
  await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
  await expect(frame.getByTestId('regional-approval-flow-lane')).toBeVisible();

  // 再点收起，刷新后保持收起。
  await frame.getByTestId('regional-approval-flow-toggle').click();
  await expect(frame.getByTestId('regional-approval-flow-lane')).toBeHidden();
  await page.reload();
  await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
  await expect(frame.getByTestId('regional-approval-flow-lane')).toBeHidden();
});

/** 收起/展开只是显示切换，不能丢掉筛选和已改的内容。 */
test('collapsing the flow lane keeps filters and inline edits', { timeout: 90000 }, async (t) => {
  const { frame } = await fixture(t);
  await frame.getByRole('button', { name: /宝阳销售组/ }).first().click();
  const input = frame.getByRole('spinbutton', { name: '确认计划量 1001', exact: true });
  await expect(input).toBeVisible();
  await input.fill('22.125');
  await expect(frame.getByRole('status')).toHaveCount(0, { timeout: 10000 });

  const toggle = frame.getByTestId('regional-approval-flow-toggle');
  await toggle.click(); // 展开
  await expect(frame.getByTestId('regional-approval-flow-lane')).toBeVisible();
  await toggle.click(); // 收起
  await expect(frame.getByTestId('regional-approval-flow-lane')).toBeHidden();

  // 展开回来时，之前改的数字和展开行都还在。
  await toggle.click();
  await expect(frame.getByRole('spinbutton', { name: '确认计划量 1001', exact: true })).toHaveValue('22.125');
});

/**
 * 没有 sales-plan 权限码的账号，即使被服务端派了同版本可处理任务，
 * 也不再折算成审批节点：默认停在「全部节点」，且没有审批入口。
 */
test('a task notification without an account grant no longer selects an approval node', { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const plan = { planId: 'p', versionId: 'v', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M', dealerCode: 'd', dealerName: '客户A', orgCode: 'org', orgName: '宝阳销售组', provinceCode: 'province', provinceName: '华南省区', areaCode: 'area', areaName: '华南大区', status: 1, currentQty: '20', currentAmount: '200', targetQty: '40', targetAmount: '400', skuCount: 1 };
  const sku = { id: 's', skuCode: '1001', versionId: 'v', productCategName: '汤圆', materialDescription: '黑芝麻汤圆 500g', qty: '20', baseQty: '10', amt: '200', amtBase: '100', price: '10' };
  const requestedStatuses = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    // 没有任何 sales-plan 权限码。
    if (path.endsWith('/getPermCode')) return send({ codeList: [] });
    if (path.endsWith('/notifications/n')) return send({ id: 'n', approval: { biz_key: 'sales-plan:version:v', instance_id: 'i', actionable: true } });
    if (path.endsWith('/notifications')) return send({ items: [{ id: 'n', approval: { biz_key: 'sales-plan:version:v', instance_id: 'i', actionable: true } }], total: 1 });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      requestedStatuses.push(status);
      // 首屏（不带 status）也要能看到这条计划，才能从它的可处理任务里认出用户所在节点。
      const records = status === null || status === '1' ? [plan] : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    // 只有同版本可处理任务，没有 actionContext。
    if (path.endsWith('/plans/p')) return send({ currentVersion: { ...plan, id: 'v', effective: true }, skus: [sku], versions: [], logs: [], workflowApproval: { versionId: 'v', notificationId: 'n', instanceId: 'i', actionable: true } });
    if (path.endsWith('/versions')) return send([{ ...plan, id: 'v', effective: true }]);
    if (path.endsWith('/versions/v/skus')) return send([sku]);
    return false;
  });
  await app.login();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split('; ').map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: app.origin })));
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: '内测声明', exact: true }).getByRole('button', { name: '继续', exact: true }).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();

  // 待办通知不再被当作审批身份，默认停在「全部节点」。
  await expect(frame.getByTestId('regional-approval-flow-toggle')).toContainText('当前节点：全部节点', { timeout: 20000 });
  await frame.getByTestId('regional-approval-flow-toggle').click();
  await expect(frame.getByTestId('regional-approval-stage-region')).toHaveAttribute('aria-pressed', 'false');
});

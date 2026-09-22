import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 审批工作台按节点收口：节点条只列当前账号有权审批的节点（本用例只有 region），
 * 不再提供「全部节点」，队列也只取该节点的状态（待审 1 与退回 7），
 * 不会把已经流转到下游节点的单子当追踪行展示出来。
 */
test('region sees only its own node rows and can act on them', { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const plans = Array.from({ length: 11 }, (_, status) => ({
    planId: `p${status}`, versionId: `v${status}`, periodId: '20260901', planTypeCode: 'Y', status,
    baseName: `scope-${status}-row`, orgCode: `region-${status}`, orgName: `scope-${status}-row`, dealerCode: `c${status}`,
    currentQty: '1', currentAmount: '10', targetAmount: '10', targetQty: '1', skuCount: 0,
  }));
  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/periods')) return send({ records: [{ periodId: '20260901', periodMonth: '2026-09', planTypeCode: 'Y', status: 'OPEN' }], total: 1, current: 1, size: 100 });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const rows = status === null ? plans : plans.filter((plan) => plan.status === Number(status));
      return send({ records: rows, total: rows.length, current: 1, size: Number(req.url.searchParams.get('pageSize') || 20), pages: 1 });
    }
    const match = /\/plans\/(p\d+)(\/versions)?$/.exec(path);
    if (match) {
      const plan = plans.find((item) => item.planId === match[1]);
      const version = { ...plan, id: plan.versionId, effective: true };
      return send(match[2] ? [version] : { currentVersion: version, versions: [version], skus: [], logs: [] });
    }
    if (/\/plans\/versions\/v\d+\/skus$/.test(path)) return send([]);
    const action = /\/versions\/(v\d+)\/actions$/.exec(path);
    if (action) {
      const plan = plans.find((item) => item.versionId === action[1]);
      writes.push(JSON.parse(req.body));
      return send({ planId: plan.planId, versionId: plan.versionId, fromStatus: plan.status, toStatus: plan.status === 1 ? 2 : plan.status, requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
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
  await frame.getByRole('heading', { name: '销售计划审批', exact: true }).waitFor();
  const table = frame.locator('tbody').first();

  // 节点条只有本账号有权限的节点，且没有「全部节点」。
  const toggle = frame.getByTestId('regional-approval-flow-toggle');
  await expect(toggle).toContainText('当前节点：城市经理审批');
  await expect(toggle).not.toContainText('全部节点');
  await toggle.click();
  await expect(frame.locator('[data-testid^="regional-approval-stage-"]')).toHaveCount(1);
  await expect(frame.getByTestId('regional-approval-stage-customer')).toHaveCount(0);

  // 队列只含本节点的待审（1）与退回（7），下游追踪单不再出现。
  await expect(table.getByText('scope-1-row', { exact: true })).toBeVisible();
  await expect(table.getByText('scope-7-row', { exact: true })).toBeVisible();
  for (const status of [0, 2, 3, 4, 5, 6, 8, 9, 10]) {
    await expect(table.getByText(`scope-${status}-row`, { exact: true })).toHaveCount(0);
  }
  // 节点进度条会按状态各拉一次计数（pageSize=1），那不是队列取数；队列取数只带本节点状态。
  const queueQueries = app.requests.filter((request) => request.url.pathname.endsWith('/plans') && request.url.searchParams.has('status') && request.url.searchParams.get('pageSize') !== '1');
  assert.ok(queueQueries.length);
  assert.ok(queueQueries.every((request) => [1, 7].includes(Number(request.url.searchParams.get('status')))));

  // 本节点待审在没有服务端对象能力时也能直接审批。
  const pending = table.locator('tr').filter({ hasText: 'scope-1-row' });
  await pending.locator('label.arco-checkbox').click();
  await expect(frame.getByRole('button', { name: '通过', exact: true })).toBeEnabled();
  await frame.getByRole('button', { name: '通过', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  assert.equal(writes[0].action, 'APPROVE');
  assert.equal(writes[0].expectedStatus, 1);
  assert.equal(writes[0].approvalRole, undefined, '上游报文只发接口文档声明的字段');
  assert.equal(writes[0].approvalPolicy, undefined);
  assert.equal(writes[0].expectedSnapshot, undefined);
});

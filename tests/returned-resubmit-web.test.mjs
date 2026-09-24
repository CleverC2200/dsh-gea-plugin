import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 退回态走"通过"时仍是重提新版本；状态 7–9 也能由当前责任节点继续逐级退回。
 * 前台共用「通过」按钮，后台按状态分别审批或重提。
 * 退回到区域的单子仍可由区域角色继续退回客户；客户起点不可再退。
 */
const PLAN_A = 'p-jxs-2026-10-00001';
const PLAN_B = 'p-jxs-2026-10-00002';
const PLAN_C = 'p-jxs-2026-10-00003';

const fixture = async (t) => {
  const app = await profile(t, {
    config: { serviceAccounts: { production: { clientIdEnv: 'GEA_SUBMIT_CLIENT', clientSecretEnv: 'GEA_SUBMIT_SECRET', tenantId: '0', allowedUserIds: ['9007199254740993'] } } },
    env: { GEA_SUBMIT_CLIENT: 'fixture-client', GEA_SUBMIT_SECRET: 'fixture-secret' },
  });
  const state = new Map([
    [PLAN_A, { versionId: 'v1', seq: 1, status: 7, dealerCode: '456', name: '乌鲁木齐退回区域' }],
    [PLAN_B, { versionId: 'v2', seq: 1, status: 7, dealerCode: '457', name: '济南退回区域' }],
    [PLAN_C, { versionId: 'v3', seq: 1, status: 1, dealerCode: '458', name: '沈阳待审批' }],
  ]);
  const submitted = [];
  const approved = [];
  const rejected = [];
  const version = (planId, effective = true) => {
    const row = state.get(planId);
    return { id: row.versionId, planId, periodId: '20261001', planTypeCode: 'Y', orderType: 'M', status: row.status, effective, seq: row.seq, dealerCode: row.dealerCode, targetQty: '1.000', targetAmount: '12.34' };
  };
  const sku = (planId) => ({ id: 's-' + planId, versionId: state.get(planId).versionId, skuCode: '789', productCategName: 'Category', baseQty: '1.000', qty: '2.000', price: '12.3400', amt: '24.68', amtBase: '12.34' });
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/periods')) return send({ records: [{ periodId: '20261001', periodMonth: '2026-10', planTypeCode: 'Y', status: 'OPEN' }], total: 1, current: 1, size: 100 });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const records = [...state.keys()]
        .filter((planId) => status === null || status === String(state.get(planId).status))
        .map((planId) => {
          const row = state.get(planId);
          return { planId, versionId: row.versionId, seq: row.seq, periodId: '20261001', planTypeCode: 'Y', orderType: 'M', status: row.status, dealerCode: row.dealerCode, dealerName: row.name, orgName: row.name, orgCode: 'org-' + planId, currentQty: '2.000', currentAmount: '24.68', targetQty: '1.000', targetAmount: '12.34', skuCount: 1 };
        });
      return send({ records, total: records.length, current: 1, size: Number(req.url.searchParams.get('pageSize') || 20), pages: 1 });
    }
    const detail = /\/plans\/(p-jxs-2026-10-\d+)$/.exec(path);
    if (detail) {
      const planId = detail[1];
      const current = version(planId);
      const previous = state.get(planId).previous ? [{ ...version(planId, false), id: state.get(planId).previous }] : [];
      // 重提后必须能读回 RESUBMIT 审计日志，客户端用它确认新版本真的落地。
      const logs = state.get(planId).previous
        ? [{ planId, versionId: current.id, requestId: state.get(planId).logRequestId, actionCode: 'RESUBMIT' }]
        : [];
      return send({ currentVersion: current, versions: [...previous, current], skus: [sku(planId)], logs,
        ...(planId === PLAN_C ? { actionContext: { versionId: current.id, status: current.status, nodeOrder: 2,
          allowedActions: ['APPROVE', 'REJECT'], snapshotHash: 'a'.repeat(64) } } : {}) });
    }
    const versionSkus = /\/versions\/([^/]+)\/skus$/.exec(path);
    if (versionSkus) {
      const planId = [...state.entries()].find(([, row]) => row.versionId === versionSkus[1])?.[0];
      return send(planId ? [sku(planId)] : []);
    }
    if (path.endsWith('/versions/v3/actions')) {
      const body = JSON.parse(req.body);
      if (body.action === 'REJECT') {
        rejected.push({ planId: PLAN_C, body });
        state.get(PLAN_C).status = 6;
        return send({ planId: PLAN_C, versionId: 'v3', fromStatus: 1, toStatus: 6,
          requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
      }
      approved.push(body);
      assert.equal(body.action, 'APPROVE');
      state.get(PLAN_C).status = 2;
      return send({ planId: PLAN_C, versionId: 'v3', fromStatus: 1, toStatus: 2,
        requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
    }
    if (path.endsWith('/versions/v1/actions')) {
      const body = JSON.parse(req.body);
      assert.equal(body.action, 'REJECT');
      rejected.push({ planId: PLAN_A, body });
      state.get(PLAN_A).status = 6;
      return send({ planId: PLAN_A, versionId: 'v1', fromStatus: 7, toStatus: 6,
        requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
    }
    if (path.endsWith('/api/v1/internal/auth/token')) return send({ access_token: 'fixture-service', token_type: 'Bearer', expires_in: 600, scope: 'sales-plan:write' });
    if (path.endsWith('/api/v1/internal/sales-plans')) {
      const body = JSON.parse(req.body);
      const entry = [...state.entries()].find(([, row]) => row.dealerCode === body.dealerCode);
      assert.ok(entry, `重提报文应带 dealerCode：${req.body}`);
      const [planId, row] = entry;
      submitted.push({ planId, body });
      // 重提生成新版本：旧版本置为失效，新版本按调用端 status 落到下一节点。
      row.previous = row.versionId;
      row.versionId = row.versionId + '-r';
      row.seq = 2;
      row.status = body.status;
      row.logRequestId = req.headers['x-request-id'];
      return send({ planId, versionId: row.versionId, seq: 2, status: body.status, replayed: false, requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a' });
    }
    return false;
  });
  await app.login();
  assert.equal((await app.rpc('status')).value.resubmitConnected, true, '重提通道要就绪，否则按钮会按"服务凭据未就绪"置灰');
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
  await expect(frame.getByTestId('regional-approval-flow-toggle')).toBeVisible();
  return { frame, submitted, approved, rejected };
};

test('the shared approve button resubmits a returned plan', { timeout: 90000 }, async (t) => {
  const { frame, submitted } = await fixture(t);
  const rowBox = (name) => frame.locator('tbody tr').filter({ hasText: name }).first().locator('label.arco-checkbox');
  await expect(frame.getByRole('button', { name: '通过', exact: true })).toHaveCount(1);
  await rowBox('乌鲁木齐退回区域').click();

  await expect(frame.getByRole('button', { name: '退回', exact: true })).toBeEnabled();
  await expect(frame.getByRole('button', { name: '通过', exact: true })).toBeEnabled();
  await expect(frame.getByRole('button', { name: '退回重提', exact: true })).toHaveCount(0);
  await frame.getByRole('button', { name: '通过', exact: true }).click();
  await expect(frame.getByRole('dialog', { name: '真实销售计划退回重提', exact: true })).toBeVisible();
  assert.equal(submitted.length, 0, '只是打开对话框，还没有提交');
});

test('batch submit resubmits every returned plan one by one', { timeout: 90000 }, async (t) => {
  const { frame, submitted } = await fixture(t);
  const rowBox = (name) => frame.locator('tbody tr').filter({ hasText: name }).first().locator('label.arco-checkbox');
  await rowBox('乌鲁木齐退回区域').click();
  await rowBox('济南退回区域').click();

  await expect(frame.getByRole('button', { name: '通过', exact: true })).toBeEnabled();
  await frame.getByRole('button', { name: '通过', exact: true }).click();
  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('退回重提（生成新版本）');
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '确认批量重提', exact: true }).click();
  await expect(frame.getByTestId('regional-approval-batch-result')).toBeVisible({ timeout: 30000 });
  assert.equal(submitted.length, 2, '两笔退回单都走了重提通道');
  assert.deepEqual(submitted.map((item) => item.planId).sort(), [PLAN_A, PLAN_B]);
  // 重提报文只带数量与路由字段：提报人是当前用户，订单性质不变。
  for (const item of submitted) {
    assert.equal(item.body.orderType, 'M');
    assert.equal(item.body.status, 2, '退回区域（7）重提后回到待省区处理（2）');
    assert.equal(item.body.submitterCode, '9007199254740993');
    assert.equal(item.body.items.length, 1);
  }
  await expect(frame.getByTestId('regional-approval-batch-result')).toContainText('成功 2 笔');
});

test('mixed selection approves pending plans and resubmits returned plans in one batch', { timeout: 90000 }, async (t) => {
  const { frame, submitted, approved } = await fixture(t);
  const rowBox = (name) => frame.locator('tbody tr').filter({ hasText: name }).first().locator('label.arco-checkbox');
  await rowBox('乌鲁木齐退回区域').click();
  await rowBox('沈阳待审批').click();
  const primary = frame.getByRole('button', { name: '通过', exact: true });
  await expect(primary).toBeEnabled();
  await primary.click();
  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toContainText('退回重提（生成新版本）');
  await expect(dialog).toContainText('审批通过（当前版本）');
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '确认批量提交', exact: true }).click();
  await expect(frame.getByTestId('regional-approval-batch-result')).toContainText('成功 2 笔', { timeout: 30000 });
  assert.deepEqual(submitted.map((item) => item.planId), [PLAN_A]);
  assert.equal(approved.length, 1);
  assert.equal(approved[0].action, 'APPROVE');
});

test('returned and pending plans can be rejected together, each from its own status', { timeout: 90000 }, async (t) => {
  const { frame, rejected } = await fixture(t);
  const rowBox = (name) => frame.locator('tbody tr').filter({ hasText: name }).first().locator('label.arco-checkbox');
  await rowBox('乌鲁木齐退回区域').click();
  await rowBox('沈阳待审批').click();
  await frame.getByRole('button', { name: '退回', exact: true }).click();
  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('退回版本继续逐级退回');
  await expect(dialog).toContainText('正常审批退回');
  await dialog.getByRole('textbox', { name: '批量审批备注' }).fill('继续退回客户核对');
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '确认批量退回', exact: true }).click();
  const result = frame.getByTestId('regional-approval-batch-result');
  await expect(result).toContainText('成功 2 笔', { timeout: 30000 });
  await expect(result.locator('ul')).toHaveCount(0);
  assert.deepEqual(rejected.map(({ planId }) => planId).sort(), [PLAN_A, PLAN_C]);
  assert.deepEqual(rejected.map(({ body }) => body.expectedStatus).sort(), [1, 7]);
  assert.ok(rejected.every(({ body }) => body.action === 'REJECT' && body.remark === '继续退回客户核对'));
});

test('a returned regional plan can be rejected again to the customer', { timeout: 90000 }, async (t) => {
  const { frame, rejected } = await fixture(t);
  await frame.locator('tbody tr').filter({ hasText: '乌鲁木齐退回区域' }).first().locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '退回', exact: true }).click();
  const dialog = frame.getByRole('dialog', { name: '退回', exact: true });
  await dialog.getByRole('textbox', { name: '退回原因（必填）' }).fill('继续退回客户核对');
  await dialog.getByRole('button', { name: '确认退回', exact: true }).click();
  await expect.poll(() => rejected.length, { timeout: 15000 }).toBe(1);
  assert.equal(rejected[0].planId, PLAN_A);
  assert.equal(rejected[0].body.expectedStatus, 7);
});

test('queue column headings stay visible while its rows scroll', { timeout: 90000 }, async (t) => {
  const { frame } = await fixture(t);
  const pane = frame.locator('.arco-table-content-inner').first();
  const measured = await pane.evaluate((element) => {
    element.style.height = '80px';
    element.style.minHeight = '80px';
    element.style.maxHeight = '80px';
    element.scrollTop = 70;
    const heading = [...element.querySelectorAll(':scope > table > thead > tr > th.arco-table-th')]
      .find((cell) => cell.textContent?.trim() === '月计划');
    return {
      scrollTop: element.scrollTop,
      paneTop: element.getBoundingClientRect().top,
      headingTop: heading?.getBoundingClientRect().top,
    };
  });
  assert.ok(measured.scrollTop > 0, '队列必须发生纵向滚动');
  assert.ok(Math.abs(measured.headingTop - measured.paneTop) <= 1, `滚动后标题应贴住队列顶部：${JSON.stringify(measured)}`);
});

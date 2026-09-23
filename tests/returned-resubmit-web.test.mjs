import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 退回态（6–9）在管理端只有"退回重提"这条路：重提生成新版本，状态按 8→3 / 7→2 回到下一节点；
 * 动作接口只接受 1–4 的待审单。所以界面上不单开按钮——退回单的「通过」就是重提，多选时逐笔重提。
 * 退回单的「退回」没有意义，必须置灰。
 */
const PLAN_A = 'p-jxs-2026-10-00001';
const PLAN_B = 'p-jxs-2026-10-00002';

const fixture = async (t) => {
  const app = await profile(t, {
    config: { serviceAccounts: { production: { clientIdEnv: 'GEA_SUBMIT_CLIENT', clientSecretEnv: 'GEA_SUBMIT_SECRET', tenantId: '0', allowedUserIds: ['9007199254740993'] } } },
    env: { GEA_SUBMIT_CLIENT: 'fixture-client', GEA_SUBMIT_SECRET: 'fixture-secret' },
  });
  const state = new Map([
    [PLAN_A, { versionId: 'v1', seq: 1, status: 7, dealerCode: '456', name: '乌鲁木齐退回区域' }],
    [PLAN_B, { versionId: 'v2', seq: 1, status: 7, dealerCode: '457', name: '济南退回区域' }],
  ]);
  const submitted = [];
  const version = (planId, effective = true) => {
    const row = state.get(planId);
    return { id: row.versionId, planId, periodId: '20261001', planTypeCode: 'Y', orderType: 'M', status: row.status, effective, seq: row.seq, dealerCode: row.dealerCode, targetQty: '1.000', targetAmount: '12.34' };
  };
  const sku = (planId) => ({ id: 's-' + planId, versionId: state.get(planId).versionId, skuCode: '789', productCategName: 'Category', baseQty: '1.000', qty: '2.000', price: '12.3400', amt: '24.68', amtBase: '12.34' });
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
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
      return send({ currentVersion: current, versions: [...previous, current], skus: [sku(planId)], logs });
    }
    const versionSkus = /\/versions\/([^/]+)\/skus$/.exec(path);
    if (versionSkus) {
      const planId = [...state.entries()].find(([, row]) => row.versionId === versionSkus[1])?.[0];
      return send(planId ? [sku(planId)] : []);
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
  await expect(frame.getByTestId('regional-approval-flow-toggle')).toContainText('当前节点：城市经理审批');
  return { frame, submitted };
};

test('a returned plan: 通过 means resubmit, 退回 stays disabled', { timeout: 90000 }, async (t) => {
  const { frame, submitted } = await fixture(t);
  const rowBox = (name) => frame.locator('tbody tr').filter({ hasText: name }).first().locator('label.arco-checkbox');
  await rowBox('乌鲁木齐退回区域').click();

  // 退回单不能再被退回。
  await expect(frame.getByRole('button', { name: '退回', exact: true })).toBeDisabled();
  // 通过 = 退回重提：单笔时打开可核对数量的重提对话框。
  const approve = frame.getByRole('button', { name: '通过', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(frame.getByRole('dialog', { name: '真实销售计划退回重提', exact: true })).toBeVisible();
  assert.equal(submitted.length, 0, '只是打开对话框，还没有提交');
});

test('batch submit resubmits every returned plan one by one', { timeout: 90000 }, async (t) => {
  const { frame, submitted } = await fixture(t);
  const rowBox = (name) => frame.locator('tbody tr').filter({ hasText: name }).first().locator('label.arco-checkbox');
  await rowBox('乌鲁木齐退回区域').click();
  await rowBox('济南退回区域').click();

  await frame.getByRole('button', { name: '通过', exact: true }).click();
  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('退回重提（生成新版本）');
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '确认批量通过', exact: true }).click();
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

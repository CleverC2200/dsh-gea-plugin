import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * 审批工作台按节点收口：节点条只列当前账号有权审批的节点，且不再有「全部节点」。
 * 因此有 region 权限的账号只看到本节点的待办，看不到已经流转到下游节点的追踪单；
 * 本节点待办在没有服务端对象能力时也能直接审批。
 */
const planOf = (suffix, status, baseName) => ({
  planId: `p-${suffix}`,
  versionId: `v-${suffix}`,
  periodId: '20260901',
  planTypeCode: 'Y',
  status,
  baseName,
  orgCode: 'region-a',
  orgName: 'region-a',
  dealerCode: `customer-${suffix}`,
  currentQty: '1',
  currentAmount: '10',
  targetAmount: '10',
  targetQty: '1',
  skuCount: 0,
});

test('granted region role sees only its own node queue and approves without server capabilities', { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const pending = planOf('pending', 1, '本节点待办');
  const tracking = planOf('tracking', 2, '下游追踪');
  const plans = [pending, tracking];

  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/periods')) return send({ records: [{ periodId: '20260901', periodMonth: '2026-09', planTypeCode: 'Y', status: 'CLOSED' }], total: 1, current: 1, size: 100 });
    if (path.endsWith('/plans')) {
      const requestedStatus = req.url.searchParams.get('status');
      const records = requestedStatus === null ? plans : plans.filter((plan) => plan.status === Number(requestedStatus));
      return send({ records, total: records.length, current: 1, size: 20, pages: 1 });
    }
    const detail = /\/plans\/(p-[a-z]+)$/.exec(path);
    if (detail) {
      const plan = plans.find((item) => item.planId === detail[1]);
      return send({
        currentVersion: { ...plan, id: plan.versionId, effective: true },
        versions: [],
        skus: [],
        logs: [],
        actionContext: {
          versionId: plan.versionId,
          status: plan.status,
          snapshotHash: 'a'.repeat(64),
          policy: 'role-visible-v1',
          allowedActions: [],
          roleActions: [],
        },
      });
    }
    if (path.endsWith('/versions')) return send([{ ...pending, id: pending.versionId, effective: true }]);
    if (/\/plans\/versions\/v-[a-z]+\/skus$/.test(path)) return send([]);
    if (/\/versions\/v-[a-z]+\/actions$/.test(path)) {
      writes.push(JSON.parse(req.body));
      return send({ planId: pending.planId, versionId: pending.versionId, fromStatus: 1, toStatus: 2, requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
    }
    return false;
  });
  await app.login();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  await context.addCookies(app.cookie.split('; ').map((pair) => ({
    name: pair.slice(0, pair.indexOf('=')),
    value: pair.slice(pair.indexOf('=') + 1),
    url: app.origin,
  })));
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: '内测声明', exact: true }).getByRole('button', { name: '继续', exact: true }).click();

  const frame = page.frameLocator('iframe[data-gea-workbench]');
  // V1.8 #05：流程图默认收起，先展开再核对节点。
  if (!(await frame.getByTestId('regional-approval-flow-lane').isVisible())) await frame.getByTestId('regional-approval-flow-toggle').click();
  const region = frame.getByTestId('regional-approval-stage-region');
  await expect(region).toHaveAttribute('aria-pressed', 'true');
  // 只列有权限的节点，且没有「全部节点」可切。
  await expect(frame.locator('[data-testid^="regional-approval-stage-"]')).toHaveCount(1);
  await expect(frame.getByTestId('regional-approval-flow-toggle')).not.toContainText('全部节点');

  await expect(frame.locator('tbody tr').filter({ hasText: pending.baseName }).first()).toBeVisible();
  await expect(frame.locator('tbody tr').filter({ hasText: tracking.baseName })).toHaveCount(0);

  await frame.locator('tbody tr').filter({ hasText: pending.baseName }).first().locator('label.arco-checkbox').click();
  const approve = frame.getByRole('button', { name: '通过', exact: true });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(frame.getByRole('dialog', { name: '销售计划审批', exact: true })).toHaveCount(0);
  assert.equal(writes[0].action, 'APPROVE');
  assert.equal(writes[0].expectedStatus, 1);
  assert.equal(writes[0].approvalRole, undefined, '上游报文只发接口文档声明的字段');
  assert.equal(writes[0].approvalPolicy, undefined);
  assert.equal(writes[0].expectedSnapshot, undefined);
});

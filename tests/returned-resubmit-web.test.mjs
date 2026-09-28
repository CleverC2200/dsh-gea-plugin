import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/** 审批人员重审当前退回版本：不依赖客户重提凭据，不生成新版本。 */
const PLAN_A = 'p-jxs-2026-10-00001';
const PLAN_B = 'p-jxs-2026-10-00002';
const PLAN_C = 'p-jxs-2026-10-00003';

const fixture = async (t, {role = 'region', returnedStatus = 7, denyApproval = false} = {}) => {
  const app = await profile(t, {roles: [{code: `sales_plan_${role}_approver`, name: role}]});
  const state = new Map([
    [PLAN_A, { versionId: 'v1', seq: 1, status: returnedStatus, dealerCode: '456', name: '乌鲁木齐退回区域' }],
    [PLAN_B, { versionId: 'v2', seq: 1, status: 7, dealerCode: '457', name: '济南退回区域' }],
    [PLAN_C, { versionId: 'v3', seq: 1, status: 1, dealerCode: '458', name: '沈阳待审批' }],
  ]);
  const submitted = [];
  const approved = [];
  const rejected = [];
  const attempts = [];
  const version = (planId, effective = true) => {
    const row = state.get(planId);
    return { id: row.versionId, planId, periodId: '20261001', planTypeCode: 'Y', orderType: 'M', status: row.status, effective, seq: row.seq, dealerCode: row.dealerCode, targetQty: '1.000', targetAmount: '12.34' };
  };
  const sku = (planId) => ({ id: 's-' + planId, versionId: state.get(planId).versionId, skuCode: '789', productCategName: 'Category', baseQty: '1.000', qty: '2.000', price: '12.3400', amt: '24.68', amtBase: '12.34' });
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: [`sales-plan:plan:${role}-approve`] });
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
      return send({ currentVersion: current, versions: [current], skus: [sku(planId)], logs: [],
        actionContext: { versionId: current.id, status: current.status, policy: 'role-visible-v1',
          allowedActions: [], roleActions: [{role, allowedActions: []}], snapshotHash: 'a'.repeat(64) } });
    }

    const versionSkus = /\/versions\/([^/]+)\/skus$/.exec(path);
    if (versionSkus) {
      const planId = [...state.entries()].find(([, row]) => row.versionId === versionSkus[1])?.[0];
      return send(planId ? [sku(planId)] : []);
    }
    const action = /\/versions\/(v[123])\/actions$/.exec(path);
    if (action) {
      const body = JSON.parse(req.body);
      assert.ok(['APPROVE','REJECT'].includes(body.action));
      const [planId, row] = [...state.entries()].find(([, row]) => row.versionId === action[1]);
      assert.equal(body.approvalRole, role);
      assert.equal(body.approvalPolicy, 'role-visible-v1');
      assert.equal(body.expectedSnapshot, 'a'.repeat(64));
      assert.equal(body.expectedStatus, row.status);
      attempts.push(body);
      if (denyApproval && body.action === 'APPROVE') {
        reply({success:false,message:'当前用户不具备审批权限'},403);
        return true;
      }
      const fromStatus = row.status;
      const rejectTarget = {region:6,province:7,area:8,category:9}[role];
      row.status = body.action === 'REJECT' ? rejectTarget : 2;
      (body.action === 'REJECT' ? rejected : approved).push({planId, body});
      return send({planId, versionId: row.versionId, fromStatus, toStatus: row.status, approvalRole: role,
        requestId:req.headers['x-request-id'], traceId:'t', auditId:'a', replayed:false});
    }
    if (path.endsWith('/api/v1/internal/sales-plans') || path.endsWith('/api/v1/internal/auth/token')) {
      submitted.push(path);
      reply({success:false},403);
      return true;
    }
    return false;
  });
  await app.login();
  assert.equal((await app.rpc('status')).value.resubmitConnected, false, '审批重审不应依赖重提服务凭据');
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
  return { frame, submitted, approved, rejected, attempts };
};

test('a returned plan approves its current version without service credentials', {timeout:90000}, async t => {
  const {frame, submitted, approved} = await fixture(t);
  await frame.locator('tbody tr').filter({hasText:'乌鲁木齐退回区域'}).first().locator('label.arco-checkbox').click();
  await expect(frame.getByRole('button',{name:'退回',exact:true})).toBeEnabled();
  await expect(frame.getByRole('button',{name:'通过',exact:true})).toBeEnabled();
  await frame.getByRole('button',{name:'通过',exact:true}).click();
  await expect.poll(() => approved.length).toBe(1);
  await expect(frame.getByRole('dialog',{name:'真实销售计划退回重提',exact:true})).toHaveCount(0);
  assert.equal(approved[0].body.expectedStatus,7);
  assert.deepEqual(submitted,[]);
});

test('upstream refusal of a returned approval never falls back to service-account resubmission', {timeout:90000}, async t => {
  const {frame, submitted, approved, attempts} = await fixture(t,{denyApproval:true});
  await frame.locator('tbody tr').filter({hasText:'乌鲁木齐退回区域'}).first().locator('label.arco-checkbox').click();
  const approve=frame.getByRole('button',{name:'通过',exact:true});
  await approve.click();
  await expect(approve).toBeDisabled();
  await expect(approve).toHaveAttribute('title', /服务端.*拒绝/);
  assert.equal(attempts.length,1);
  assert.deepEqual(approved,[]);
  assert.deepEqual(submitted,[]);
});

for (const mixed of [false,true]) test(`batch approves returned plans on their current versions; mixed=${mixed}`, {timeout:90000}, async t => {
  const {frame, submitted, approved} = await fixture(t);
  for (const name of ['乌鲁木齐退回区域',mixed ? '沈阳待审批' : '济南退回区域'])
    await frame.locator('tbody tr').filter({hasText:name}).first().locator('label.arco-checkbox').click();
  await expect(frame.getByRole('button',{name:'通过',exact:true})).toBeEnabled();
  await frame.getByRole('button',{name:'通过',exact:true}).click();
  const dialog=frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).not.toContainText('生成新版本');
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button',{name:'确认批量通过',exact:true}).click();
  await expect(frame.getByTestId('regional-approval-batch-result')).toContainText('成功 2 笔',{timeout:30000});
  assert.deepEqual(approved.map(x=>x.planId).sort(),[PLAN_A,mixed?PLAN_C:PLAN_B]);
  assert.deepEqual(approved.map(x=>x.body.expectedStatus).sort(),mixed?[1,7]:[7,7]);
  assert.deepEqual(submitted,[]);
});

for (const [role,returnedStatus] of [['region',6],['province',7],['area',8],['category',9]])
  test(`the rejecting role can review a return addressed to the previous node: ${role}/${returnedStatus}`, {timeout:90000}, async t => {
    const {frame,approved,submitted}=await fixture(t,{role,returnedStatus});
    await frame.getByTestId('regional-approval-flow-toggle').click();
    await frame.getByTestId(`regional-approval-stage-${role}`).click();
    await frame.locator('tbody tr').filter({hasText:'乌鲁木齐退回区域'}).first().locator('label.arco-checkbox').click();
    await expect(frame.getByRole('button',{name:'退回',exact:true})).toBeEnabled();
    await frame.getByRole('button',{name:'通过',exact:true}).click();
    await expect.poll(()=>approved.length).toBe(1);
    assert.equal(approved[0].body.approvalRole,role);
    assert.equal(approved[0].body.expectedStatus,returnedStatus);
    assert.deepEqual(submitted,[]);
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

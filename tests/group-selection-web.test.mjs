import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * V1.8 反馈：分组行的勾选是「组内成员全部选中」的派生状态。
 * 之前取消分组只去掉分组 key、没去掉成员计划，界面会立刻把分组重新派生成勾选，表现为「勾上就取消不掉」。
 */
const plans = [
  { planId: 'p1', versionId: 'v1', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M', dealerCode: 'd1', dealerName: '客户1', orgCode: 'org-a', orgName: '宝阳销售组', provinceCode: 'province', provinceName: '华南省区', areaCode: 'area', areaName: '华南大区', status: 1, currentQty: '20', currentAmount: '200', targetQty: '40', targetAmount: '400', skuCount: 1 },
  { planId: 'p2', versionId: 'v2', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M', dealerCode: 'd2', dealerName: '客户2', orgCode: 'org-a', orgName: '宝阳销售组', provinceCode: 'province', provinceName: '华南省区', areaCode: 'area', areaName: '华南大区', status: 1, currentQty: '30', currentAmount: '300', targetQty: '40', targetAmount: '400', skuCount: 1 },
  { planId: 'p3', versionId: 'v3', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M', dealerCode: 'd3', dealerName: '客户3', orgCode: 'org-b', orgName: '烟台经销组', provinceCode: 'province', provinceName: '华南省区', areaCode: 'area', areaName: '华南大区', status: 1, currentQty: '10', currentAmount: '100', targetQty: '40', targetAmount: '400', skuCount: 1 },
];
const skuFor = (versionId) => ({ id: 's-' + versionId, skuCode: '1001', versionId, productCategName: '汤圆', qty: '20', baseQty: '10', amt: '200', amtBase: '100', price: '10' });
/** 回执必须带真实身份：客户端会按 planId/versionId/状态链逐项核对，拼接错就会被判成“结果未知”。 */
const planIdForVersion = (versionId) => 'p' + versionId.slice(1);

const openWorkbench = async (t) => {
  const app = await profile(t);
  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const records = status === null || status === '1' ? plans : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    const detail = /\/plans\/(p\d)$/.exec(path);
    if (detail) {
      const plan = plans.find((row) => row.planId === detail[1]);
      return send({ currentVersion: { ...plan, id: plan.versionId, effective: true }, skus: [skuFor(plan.versionId)], versions: [], logs: [], actionContext: { versionId: plan.versionId, status: 1, nodeOrder: 2, allowedActions: ['APPROVE', 'REJECT'], snapshotHash: 'a'.repeat(64) } });
    }
    const versions = /\/plans\/(p\d)\/versions$/.exec(path);
    if (versions) {
      const plan = plans.find((row) => row.planId === versions[1]);
      return send([{ ...plan, id: plan.versionId, effective: true }]);
    }
    const skus = /\/plans\/versions\/(v\d)\/skus$/.exec(path);
    if (skus) return send([skuFor(skus[1])]);
    const action = /\/versions\/(v\d)\/actions$/.exec(path);
    if (action) {
      const body = JSON.parse(req.body);
      writes.push(body);
      // 通过走到下一节点（1→2）；退回回到上一个节点对应的退回码（1→6）。
      const toStatus = body.action === 'REJECT' ? 6 : 2;
      return send({ planId: planIdForVersion(action[1]), versionId: action[1], fromStatus: 1, toStatus, approvalRole: 'region', requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
    }
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
  const groupBox = frame.locator('tbody label.arco-checkbox:has(input[value*="group:"])').first();
  await expect(groupBox).toBeVisible();
  return { frame, groupBox, writes };
};

test('组织分组行的勾选可以取消，不会勾上就取消不掉', { timeout: 90000 }, async (t) => {
  const { groupBox } = await openWorkbench(t);
  const box = groupBox.locator('input');
  await expect(box).not.toBeChecked();
  await groupBox.click();
  await expect(box).toBeChecked();
  await groupBox.click();
  await expect(box).not.toBeChecked();
  await groupBox.click();
  await expect(box).toBeChecked();
});

test('多选批量通过：勾选 3 笔一次性逐笔提交', { timeout: 90000 }, async (t) => {
  const { frame, groupBox, writes } = await openWorkbench(t);
  const single = frame.locator('tbody label.arco-checkbox:has(input[value="p3"])').first();
  await expect(single).toBeVisible();
  await single.click();
  await groupBox.click();
  await expect(frame.getByRole('button', { name: '通过', exact: true })).toBeEnabled();

  await frame.getByRole('button', { name: '通过', exact: true }).click();
  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toBeVisible();
  await expect(frame.getByTestId('regional-approval-batch-summary')).toContainText('3 笔');
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '确认批量通过', exact: true }).click();

  await expect(frame.getByTestId('regional-approval-batch-result')).toContainText('成功 3 笔');
  assert.equal(writes.length, 3);
  assert.deepEqual(
    writes.map((body) => body.action).sort(),
    ['APPROVE', 'APPROVE', 'APPROVE'],
  );
});

test('批量里一笔冲突不影响其它笔，结果逐笔说明原因', { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const writes = [];
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/plans')) {
      const status = req.url.searchParams.get('status');
      const records = status === null || status === '1' ? plans : [];
      return send({ records, total: records.length, pages: 1, current: 1, size: 20 });
    }
    const detail = /\/plans\/(p\d)$/.exec(path);
    if (detail) {
      const plan = plans.find((row) => row.planId === detail[1]);
      return send({ currentVersion: { ...plan, id: plan.versionId, effective: true }, skus: [skuFor(plan.versionId)], versions: [], logs: [], actionContext: { versionId: plan.versionId, status: 1, nodeOrder: 2, allowedActions: ['APPROVE', 'REJECT'], snapshotHash: 'a'.repeat(64) } });
    }
    const versions = /\/plans\/(p\d)\/versions$/.exec(path);
    if (versions) {
      const plan = plans.find((row) => row.planId === versions[1]);
      return send([{ ...plan, id: plan.versionId, effective: true }]);
    }
    const skus = /\/plans\/versions\/(v\d)\/skus$/.exec(path);
    if (skus) return send([skuFor(skus[1])]);
    const action = /\/versions\/(v\d)\/actions$/.exec(path);
    if (action) {
      writes.push({ versionId: action[1], body: JSON.parse(req.body) });
      // 第二笔已经被别人推到下一节点：并发冲突。
      if (action[1] === 'v2') { reply({ message: '状态已变化', errorCode: 'SALES_PLAN_CONFLICT', requestId: 'r' }, 409); return true; }
      return send({ planId: planIdForVersion(action[1]), versionId: action[1], fromStatus: 1, toStatus: 2, approvalRole: 'region', requestId: req.headers['x-request-id'], traceId: 't', auditId: 'a', replayed: false });
    }
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
  const groupBox = frame.locator('tbody label.arco-checkbox:has(input[value*="group:"])').first();
  await expect(groupBox).toBeVisible();
  await groupBox.click();
  await frame.getByRole('button', { name: '通过', exact: true }).click();

  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('label.arco-checkbox').click();
  await frame.getByRole('button', { name: '确认批量通过', exact: true }).click();

  const result = frame.getByTestId('regional-approval-batch-result');
  await expect(result).toContainText('成功 1 笔');
  await expect(result).toContainText('失败 1 笔');
  // 失败的那笔要能看出是哪一个，并且不能只给技术错误码。
  await expect(result).toContainText('宝阳销售组');
  const text = await result.innerText();
  for (const leak of ['GEA_HTTP', 'payload', 'SALES_PLAN_CONFLICT']) assert.equal(text.includes(leak), false, leak);
  assert.equal(writes.length, 2);
});

test('多选批量退回：共用一个退回原因，逐笔带上', { timeout: 90000 }, async (t) => {
  const { frame, groupBox, writes } = await openWorkbench(t);
  await groupBox.click();
  const reject = frame.getByRole('button', { name: '退回', exact: true });
  await expect(reject).toBeEnabled();
  await reject.click();

  const dialog = frame.getByTestId('regional-approval-batch-action-dialog');
  await expect(dialog).toBeVisible();
  const confirm = frame.getByRole('button', { name: '确认批量退回', exact: true });
  // 退回原因必填：没填、没确认之前不能提交。
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('批量审批备注').fill('促销依据待补充');
  await dialog.locator('label.arco-checkbox').click();
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(frame.getByTestId('regional-approval-batch-result')).toContainText('成功 2 笔');
  assert.equal(writes.length, 2);
  for (const body of writes) {
    assert.equal(body.action, 'REJECT');
    assert.equal(body.remark, '促销依据待补充');
  }
});

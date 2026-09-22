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

const openWorkbench = async (t) => {
  const app = await profile(t);
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
  return { frame, groupBox };
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

test('审批按钮只认单笔：选中一笔可用，选中分组多笔即置灰', { timeout: 90000 }, async (t) => {
  const { frame, groupBox } = await openWorkbench(t);
  const approve = frame.getByRole('button', { name: '通过', exact: true });
  const single = frame.locator('tbody label.arco-checkbox:has(input[value="p3"])').first();
  await expect(single).toBeVisible();

  // 单笔客户行：可以审批。
  await single.click();
  await expect(approve).toBeEnabled();

  // 再勾一个含 2 笔计划的分组：变成 3 笔，按钮必须置灰。
  await groupBox.click();
  await expect(approve).toBeDisabled();
});

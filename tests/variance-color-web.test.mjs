import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * V1.8 #14：顶部指标卡「差额（计划 − 目标）」正数红、负数绿；
 * 颜色只作用于差额数值本身，其他指标卡保持原字色。
 */
const both = async (t, planAmount, targetAmount) => {
  const app = await profile(t);
  const plan = {
    planId: 'p1', versionId: 'v1', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M',
    dealerCode: 'd1', dealerName: '客户一', orgCode: 'org1', orgName: '销售组一',
    provinceCode: 'province1', provinceName: '华东省区', areaCode: 'area1', areaName: '华东大区',
    regionCode: 'region1', regionName: '华东', baseName: '基地一', status: 1, skuCount: 1,
    currentQty: '10', currentAmount: planAmount, targetQty: '10', targetAmount,
  };
  const sku = { id: 's1', skuCode: '9001', versionId: 'v1', productCategName: '汤圆', materialDescription: '黑芝麻汤圆 500g', qty: '10', baseQty: '10', amt: planAmount, amtBase: planAmount, price: '1' };
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/plans')) { const status = req.url.searchParams.get('status'); const records = status === null || status === '1' ? [plan] : []; return send({ records, total: records.length, pages: 1, current: 1, size: 20 }); }
    if (path.endsWith('/plans/' + plan.planId)) return send({ currentVersion: { ...plan, id: plan.versionId, effective: true }, skus: [sku], versions: [], logs: [] });
    if (path.endsWith('/versions')) return send([{ ...plan, id: plan.versionId, effective: true }]);
    if (path.endsWith('/versions/' + plan.versionId + '/skus')) return send([sku]);
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
  const metrics = frame.getByRole('region', { name: '当前页明细汇总' });
  await expect.poll(async () => (await metrics.locator('strong').allTextContents()).filter((text) => text.includes('¥') && text !== '—').length, { timeout: 30000 }).toBeGreaterThan(1);
  return metrics;
};

const colorOf = (metrics, label) => metrics.locator('span').filter({ hasText: label }).locator('strong').first()
  .evaluate((element) => getComputedStyle(element).color);

test('positive variance is red and negative variance is green', { timeout: 90000 }, async (t) => {
  const positive = await both(t, '1200', '1000');
  await expect.poll(() => colorOf(positive, '差额'), { timeout: 15000 }).toBe('rgb(245, 63, 63)');
  await expect(positive.locator('span').filter({ hasText: '差额' }).locator('strong').first()).toHaveText('¥200');
  // 颜色只作用于差额：另外两张指标卡保持默认字色。
  const neutral = await colorOf(positive, '计划金额');
  assert.notEqual(neutral, 'rgb(245, 63, 63)', '计划金额不能跟着变红');
  assert.notEqual(neutral, 'rgb(0, 180, 42)', '计划金额不能跟着变绿');
});

test('loss (plan below target) is green, not red', { timeout: 90000 }, async (t) => {
  const negative = await both(t, '800', '1000');
  await expect.poll(() => colorOf(negative, '差额'), { timeout: 15000 }).toBe('rgb(0, 180, 42)');
  await expect(negative.locator('span').filter({ hasText: '差额' }).locator('strong').first()).toHaveText('−¥200');
});

test('approval overview shows readable amounts and keeps exact figures available', { timeout: 90000 }, async (t) => {
  const metrics = await both(t, '6296877.25', '6416787.34');
  const target = metrics.locator('span').filter({hasText:'目标金额'}).locator('strong').first();
  const plan = metrics.locator('span').filter({hasText:'计划金额'}).locator('strong').first();
  await expect(target).toHaveText('¥641.68万');
  await expect(target).toHaveAttribute('title','¥6,416,787.34');
  await expect(plan).toHaveText('¥629.69万');
  await expect(plan).toHaveAttribute('title','¥6,296,877.25');
});

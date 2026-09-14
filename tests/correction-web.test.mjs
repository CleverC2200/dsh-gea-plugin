import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

test(
  'correction tab uses an explicit Z query and blocks customers without an approved monthly baseline',
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith('/plans')) {
        reply({
          success: true,
          result: {
            records: [
              {
                planId: 'z',
                versionId: 'v',
                seq: 1,
                periodId: 'period-1',
                planTypeCode: 'Y',
                orderType: req.url.searchParams.get('orderType') ?? 'M',
                dealerCode: '123',
                dealerName: '纠偏客户',
                status: 1,
                targetAmount: '1000',
                targetQty: '100',
                currentQty: '100',
                currentAmount: '1000',
                skuCount: 1,
                monthlyApproved: false,
                mPlanQty: '100',
                mPlanAmount: '800',
                shipQty: '25',
                shipAmount: '400',
              },
            ],
            total: 1,
            size: 20,
            current: 1,
            pages: 1,
          },
        });
        return true;
      }
    });
    await app.login();
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: 'zh-CN' });
    page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
    await page.context().addCookies(
      app.cookie.split('; ').map((p) => {
        const [name, ...v] = p.split('=');
        return { name, value: v.join('='), url: app.origin };
      }),
    );
    await page.goto(app.origin);
    await page
      .getByRole('dialog', { name: '内测声明', exact: true })
      .getByRole('button', { name: '继续', exact: true })
      .click();
    const frame = page.frameLocator('iframe[data-gea-workbench]');
    await expect(frame.getByRole('columnheader', { name: '月度目标', exact: true })).toBeVisible();
    await frame
      .getByRole('tab', { name: '纠偏', exact: true })
      .click({ timeout: 10000 })
      .catch(async (e) => {
        console.error(await frame.locator('body').innerText());
        throw e;
      });
    await expect(frame.getByText('纠偏客户', { exact: true })).toBeVisible();
    await expect(frame.getByText('不可纠偏：月初未终审', { exact: true })).toBeVisible();
    await expect(frame.getByRole('button', { name: '调整明细', exact: true })).toBeDisabled();
    assert.ok(app.requests.some((r) => r.url.searchParams.get('orderType') === 'Z'));
  },
);

import { correctionService } from './fixtures/correction-service.mjs';
test(
  'correction saves absolute drafts, approves inherited values, returns only its node, then reconciles DMS mock',
  { timeout: 90000 },
  async (t) => {
    const app = await profile(t);
    const service = correctionService();
    app.route(service.route);
    await app.login();
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ locale: 'zh-CN' });
    await page
      .context()
      .addCookies(
        app.cookie
          .split('; ')
          .map((p) => ({ name: p.slice(0, p.indexOf('=')), value: p.slice(p.indexOf('=') + 1), url: app.origin })),
      );
    await page.goto(app.origin);
    await page
      .getByRole('dialog', { name: '内测声明', exact: true })
      .getByRole('button', { name: '继续', exact: true })
      .click();
    const f = page.frameLocator('iframe[data-gea-workbench]');
    await f.getByRole('tab', { name: '纠偏', exact: true }).click();
    await expect(f.getByText('金额 50.00%', { exact: true })).toBeVisible();
    const open = () => f.getByRole('button', { name: '调整明细', exact: true }).click();
    await open();
    let d = f.getByRole('dialog', { name: '纠偏调整明细', exact: true });
    await expect(d.getByRole('textbox', { name: '调整量 123' })).toHaveValue('2');
    await mkdir('.runtime/correction-evidence', { recursive: true });
    await page.screenshot({ path: '.runtime/correction-evidence/detail.png', fullPage: true, animations: 'disabled' });
    await d.getByRole('textbox', { name: '调整量 123' }).fill('8');
    await d.getByRole('button', { name: '保存调整', exact: true }).click();
    await expect(d).toHaveCount(0);
    assert.equal(service.detail().skus[0].regionAdjAddQty, '8');
    assert.equal(service.detail().skus[0].regionConfirmedQty, undefined);
    assert.equal(service.detail().currentVersion.status, 1);
    for (const stage of [1, 2]) {
      await open();
      await expect(d.getByRole('textbox', { name: '调整量 123' })).toHaveValue('8');
      await d.getByRole('button', { name: '通过', exact: true }).click();
      await expect(d).toHaveCount(0);
    }
    assert.equal(service.detail().skus[0].provinceConfirmedQty, '38');
    await open();
    await d.getByRole('textbox', { name: '调整量 123' }).fill('-31');
    await expect(d.getByRole('button', { name: '通过', exact: true })).toBeDisabled();
    await d.getByRole('textbox', { name: '调整量 123' }).fill('-3');
    await d.getByRole('button', { name: '通过', exact: true }).click();
    await expect(d).toHaveCount(0);
    assert.equal(service.detail().skus[0].areaConfirmedQty, '27');
    await open();
    await d.getByRole('textbox', { name: '退回原因' }).fill('重新核对');
    await d.getByRole('button', { name: '退回', exact: true }).click();
    await expect(d).toHaveCount(0);
    assert.equal(service.detail().currentVersion.status, 9);
    assert.equal(service.detail().skus[0].areaAdjCutQty, '3');
    assert.equal(service.detail().skus[0].categoryAdjCutQty, null);
    for (const stage of [9, 4]) {
      await open();
      await d.getByRole('button', { name: '通过', exact: true }).click();
      await expect(d).toHaveCount(0);
    }
    assert.equal(service.detail().currentVersion.status, 5);
    service.deliver('partial');
    await open();
    await expect(d.getByText('DMS mock · UNKNOWN', { exact: true })).toBeVisible();
    await d.getByRole('button', { name: '关闭', exact: true }).click();
    service.reconcile();
    service.deliver('success');
    await f.getByRole('button', { name: '刷新纠偏', exact: true }).click();
    await open();
    await expect(d.getByText('DMS mock · SYNCED', { exact: true })).toBeVisible();
    assert.equal(service.detail().currentVersion.status, 10);
  },
);

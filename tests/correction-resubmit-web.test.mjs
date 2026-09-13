import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

test(
  'returned Z plan resubmits fixed baseline with edited correction and verifies successor node fields are empty',
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      config: {
        serviceAccounts: {
          production: {
            clientIdEnv: 'GEA_CORR_CLIENT',
            clientSecretEnv: 'GEA_CORR_SECRET',
            tenantId: '0',
            allowedUserIds: ['9007199254740993'],
          },
        },
      },
      env: { GEA_CORR_CLIENT: 'fixture', GEA_CORR_SECRET: 'fixture-secret' },
    });
    const planId = 'p-jxs-2026-10-00001';
    const old = {
      id: 'v1',
      planId,
      seq: 1,
      periodId: '123',
      planTypeCode: 'Y',
      orderType: 'Z',
      dealerCode: '456',
      status: 6,
      effective: true,
      targetQty: '30.000',
      targetAmount: '60.00',
      currentQty: '32',
      currentAmount: '64',
      submitter: '9007199254740993',
      orgName: '重提纠偏客户',
      skuCount: 1,
    };
    let current = { ...old };
    let skus = [
      {
        id: '1',
        versionId: 'v1',
        skuCode: '789',
        productCategName: 'SKU',
        baseQty: '30.000',
        qty: '30.000',
        price: '2.0000',
        amt: '60.00',
        amtBase: '60.00',
        adjAddQty: '2',
        adjCutQty: '0',
        regionAdjAddQty: '8',
        regionAdjCutQty: '0',
        regionConfirmedQty: '38',
        regionConfirmedAmount: '76',
      },
    ];
    const logs = [];
    let received;
    app.route((req, res, reply) => {
      const path = req.url.pathname;
      if (path.endsWith('/periods')) {
        reply({
          success: true,
          result: {
            records: [{ periodId: '123', periodMonth: '2026-10', planTypeCode: 'Y', status: 'OPEN' }],
            total: 1,
            size: 100,
            current: 1,
            pages: 1,
          },
        });
        return true;
      }
      if (path.endsWith('/plans')) {
        reply({
          success: true,
          result: {
            records: [
              {
                ...current,
                versionId: current.id,
                monthlyApproved: true,
                hasCorrection: true,
                orderType: req.url.searchParams.get('orderType') ?? 'M',
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
      if (path.endsWith('/plans/' + planId)) {
        reply({
          success: true,
          result: {
            currentVersion: current,
            skus,
            versions: current.id === 'v1' ? [old] : [{ ...old, effective: false }, current],
            logs,
            correctionContext: { contract: 'absolute-net-v1', monthlyApproved: true, approvalOpen: true },
          },
        });
        return true;
      }
      if (path.endsWith('/versions/v1/skus') || path.endsWith('/versions/v2/skus')) {
        reply({ success: true, result: skus });
        return true;
      }
      if (path.endsWith('/api/v1/internal/auth/token')) {
        reply({
          success: true,
          result: { access_token: 'service', token_type: 'Bearer', expires_in: 600, scope: 'sales-plan:write' },
        });
        return true;
      }
      if (path.endsWith('/api/v1/internal/sales-plans')) {
        received = JSON.parse(req.body);
        current = { ...old, id: 'v2', seq: 2, status: 1 };
        skus = received.items.map((i) => ({ ...i, id: '2', versionId: 'v2', amt: '60.00', amtBase: '60.00' }));
        logs.push({
          id: '1',
          planId,
          versionId: 'v2',
          actionCode: 'RESUBMIT',
          requestId: req.headers['x-request-id'],
          fromStatus: 6,
          toStatus: 1,
          operatorCode: 'user',
          actionAt: new Date().toISOString(),
        });
        reply({
          success: true,
          result: {
            planId,
            versionId: 'v2',
            seq: 2,
            status: 1,
            replayed: false,
            requestId: req.headers['x-request-id'],
            traceId: 'trace',
            auditId: 'audit',
          },
        });
        return true;
      }
    });
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
    await f.getByRole('button', { name: '退回重提', exact: true }).click();
    const d = f.getByRole('dialog', { name: '真实销售计划退回重提', exact: true });
    const input = d.getByRole('textbox', { name: '纠偏调整量 789' });
    await expect(input).toHaveValue('2');
    await input.fill('5');
    await d.locator('label.arco-checkbox').click();
    await d.getByRole('button', { name: '确认重提', exact: true }).click();
    await expect(d).toContainText('新版本 v2');
    await d.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(d).toHaveCount(0);
    assert.equal(received.items[0].qty, '30.000');
    assert.equal(received.items[0].adjAddQty, '5');
    assert.equal(received.items[0].regionAdjAddQty, undefined);
    const read = await app.rpc('workbench/query', { kind: 'detail', query: { planId } });
    assert.equal(read.value.currentVersion.id, 'v2');
    assert.equal(read.value.versions[0].effective, false);
    assert.equal(read.value.skus[0].regionConfirmedQty, undefined);
  },
);

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

const { outputFiles } = await build({
  stdin: {
    contents: `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Inbox } from './src/client/inbox.tsx';
      import { zh } from './src/client/locales.ts';
      createRoot(document.getElementById('root')).render(<Inbox t={key => zh[key]} />);`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, write: false, platform: 'browser', format: 'iife',
});
const css = await readFile(new URL('../src/client/native-pages.css', import.meta.url), 'utf8');

/** 上游真实下发的形状：业务类型、来源、通知类型都是内部编码，聚合标识是 UUID。 */
const aggregateId = '31babed6-1b81-4d7b-a2c3-52bfa571bd23';
const item = {
  id: 'notice-1',
  title: '2026 年 9 月 纠偏计划待审核：香纳百川（临沂）食品销售有限公司',
  body: '香纳百川（临沂）食品销售有限公司的 2026 年 9 月纠偏计划已提交，请及时审核。',
  state: 'unread',
  kind: 'approval',
  businessType: 'sales_forecast',
  actionText: '去审批',
  target: { type: 'AGENT', value: 'sales_forecast' },
  aggregateId,
  source: { type: 'workflow', ref: aggregateId, label: 'sales_plan.approval_required' },
};

test('inbox shows business wording instead of upstream codes and identifiers', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.route('http://inbox.test/**', async route => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      return;
    }
    const query = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, value: query.id
      ? { detail: item }
      : { items: [item], total: 1, unreadCount: 1, pageSize: 10, environment: 'test', coverage: 'complete', fetchedAt: '2026-09-21T07:38:06Z' } } });
  });
  await page.goto('http://inbox.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: outputFiles[0].text });

  // 列表：业务类型列只出现业务名称。
  const kindCell = page.locator('.gea-inbox-kind').first();
  await expect(kindCell).toHaveText('销售计划');
  await expect(page.locator('.gea-inbox table')).not.toContainText('sales_forecast');
  await expect(page.locator('.gea-inbox table')).not.toContainText(aggregateId);

  await page.getByRole('button', { name: item.title, exact: true }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: item.title, exact: true })).toBeVisible();

  // 详情：来源与动作提示换成业务说法，技术跳转类型 AGENT 不再出现。
  const info = drawer.locator('article > dl.gea-inbox-info').first();
  await expect(info).toContainText('销售计划审批');
  await expect(info).not.toContainText('sales_plan.approval_required');
  await expect(info).not.toContainText(aggregateId);
  await expect(drawer.locator('.gea-inbox-action')).toContainText('去审批');
  await expect(drawer.locator('.gea-inbox-action')).toContainText('销售计划');
  await expect(drawer.locator('.gea-inbox-action')).not.toContainText('AGENT');
  await expect(drawer.locator('.gea-inbox-action')).not.toContainText('sales_forecast');
  await mkdir('.runtime/web-evidence', { recursive: true });
  await page.screenshot({ path: '.runtime/web-evidence/inbox-business-labels.png' });

  // 详情只保留业务要看的字段，上游标识与通知类型/有效期整块不再展示。
  await expect(drawer).not.toContainText('更多信息');
  await expect(drawer).not.toContainText('审批通知');
  await expect(drawer).not.toContainText('有效期至');
  assert.equal(
    await drawer.getByText(aggregateId, { exact: true }).count(),
    0,
    '待办详情不再展示任何内部标识',
  );
});

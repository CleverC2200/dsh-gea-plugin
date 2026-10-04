import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

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
const item = { id: 'notice-1', title: '消息一', body: '详情正文', state: 'unread', kind: 'approval' };

test('opening and closing inbox details preserves the list without a blank reload', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  let listReads = 0;
  let releaseList;
  let releaseDetail;
  await page.route('http://inbox.test/**', async route => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      return;
    }
    const query = route.request().postDataJSON();
    if (query.id) {
      await new Promise(resolve => { releaseDetail = resolve; });
      await route.fulfill({ json: { ok: true, value: { detail: { ...item, body: '服务端最新正文' } } } });
    } else {
      listReads++;
      await new Promise(resolve => { releaseList = resolve; });
      await route.fulfill({ json: { ok: true, value: {
        items: [item], total: 1, unreadCount: 1, pageSize: 10,
        environment: 'test', coverage: 'complete', fetchedAt: '2026-09-15T00:00:00Z',
      } } });
    }
  });
  await page.goto('http://inbox.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: outputFiles[0].text });
  await expect.poll(() => Boolean(releaseList)).toBe(true);
  await expect(page.locator('.gea-inbox table')).toBeVisible();
  const headerBefore = await page.locator('.gea-inbox thead').boundingBox();
  releaseList();
  await expect(page.getByRole('button', { name: '消息一', exact: true })).toBeVisible();
  assert.deepEqual(await page.locator('.gea-inbox thead').boundingBox(), headerBefore, 'list headers must not jump when data arrives');
  await page.evaluate(() => {
    window.inboxTable = document.querySelector('.gea-inbox table');
    window.tableRemoved = false;
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node === window.inboxTable || node.contains?.(window.inboxTable)) window.tableRemoved = true;
      }
    }).observe(document.querySelector('.gea-inbox'), { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: '消息一', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('status')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '消息一', exact: true })).toBeVisible();
  await mkdir('.runtime/web-evidence', { recursive: true });
  await page.screenshot({ path: '.runtime/web-evidence/inbox-detail-loading.png' });
  const headingBefore = await page.getByRole('dialog').getByRole('heading', { name: '消息一', exact: true }).boundingBox();
  await expect.poll(() => Boolean(releaseDetail)).toBe(true);
  releaseDetail();
  await expect(page.getByRole('dialog').getByText('服务端最新正文', { exact: true })).toBeVisible();
  await expect(page.locator('article')).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({ path: '.runtime/web-evidence/inbox-detail-loaded.png' });
  assert.deepEqual(await page.getByRole('dialog').getByRole('heading', { name: '消息一', exact: true }).boundingBox(), headingBefore, 'detail heading must not jump when response arrives');
  await page.getByRole('button', { name: '返回消息列表', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => window.tableRemoved), false, 'detail navigation must not remove the background list');
  assert.equal(listReads, 1, 'closing read-only details must not reload the list');

  // Closing while a detail request is pending must cancel it without refreshing the list.
  releaseDetail = undefined;
  await page.getByRole('button', { name: '消息一', exact: true }).click();
  await expect.poll(() => Boolean(releaseDetail)).toBe(true);
  await page.getByRole('button', { name: '返回消息列表', exact: true }).click();
  releaseDetail();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '消息一', exact: true })).toBeVisible();
  assert.equal(listReads, 1);
  assert.equal(await page.evaluate(() => window.tableRemoved), false);
});

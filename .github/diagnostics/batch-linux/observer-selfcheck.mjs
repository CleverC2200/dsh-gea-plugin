import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const { chromium, expect } = createRequire(process.env.GEA_BATCH_DIAGNOSTIC_PACKAGE)('@playwright/test');
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<html><body>
<div data-testid="regional-approval-batch-action-dialog"><p data-testid="regional-approval-batch-summary">共2笔，可提交2笔</p><textarea aria-label="批量审批备注"></textarea></div>
<footer><button disabled>确认批量退回</button></footer>
<script>document.querySelector('textarea').addEventListener('input',e=>{e.target.defaultValue=e.target.value;document.querySelector('button').disabled=!e.target.value.trim()})</script>
</body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.getByRole('button')).toBeDisabled();
  await page.getByLabel('批量审批备注').fill('促销依据待补充');
  await expect(page.getByRole('button')).toBeEnabled();
  await expect.poll(() => fs.existsSync(process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT) && fs.readFileSync(process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT, 'utf8').includes('促销依据待补充')).toBe(true);
  const rows = fs.readFileSync(process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.kind === 'dialog' && row.state.remarkValue === '' && row.state.confirmDisabled));
  assert.ok(rows.some((row) => row.kind === 'dialog' && row.state.remarkValue === '促销依据待补充' && !row.state.confirmDisabled));
  console.log(JSON.stringify({ status: 'passed', observerRecords: rows.length, siblingFooterCaptured: true }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

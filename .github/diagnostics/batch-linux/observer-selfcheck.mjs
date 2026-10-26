import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const { chromium, expect } = createRequire(process.env.GEA_BATCH_DIAGNOSTIC_PACKAGE)('@playwright/test');
const frameHtml = `<html><head><meta charset="utf-8"></head><body><button>退回</button>
<div data-testid="regional-approval-batch-action-dialog"><p data-testid="regional-approval-batch-summary">共2笔，可提交2笔</p><textarea aria-label="批量审批备注"></textarea></div>
<footer><button id="confirm" disabled>确认批量退回</button></footer>
<script>document.querySelector('textarea').addEventListener('input',e=>{e.target.defaultValue=e.target.value;document.getElementById('confirm').disabled=!e.target.value.trim()})</script>
</body></html>`;
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<html><body><iframe></iframe><script>const d=document.querySelector('iframe').contentDocument;d.open();d.write(${JSON.stringify(frameHtml).replaceAll('</script', '<\\/script')});d.close();</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const frame = page.frameLocator('iframe');
  await frame.getByRole('button', { name: '退回', exact: true }).click();
  await expect(frame.getByRole('button', { name: '确认批量退回' })).toBeDisabled();
  await frame.getByLabel('批量审批备注').fill('促销依据待补充');
  await expect(frame.getByRole('button', { name: '确认批量退回' })).toBeEnabled();
  await expect.poll(() => fs.existsSync(process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT) && fs.readFileSync(process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT, 'utf8').includes('促销依据待补充')).toBe(true);
  const rows = fs.readFileSync(process.env.GEA_BATCH_DIAGNOSTIC_OUTPUT, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rows.some((row) => row.kind === 'dialog' && row.state.remarkValue === '' && row.state.confirmDisabled));
  assert.ok(rows.some((row) => row.kind === 'dialog' && row.state.remarkValue === '促销依据待补充' && !row.state.confirmDisabled));
  console.log(JSON.stringify({ status: 'passed', observerRecords: rows.length, siblingFooterCaptured: true, rewrittenIframeCaptured: true }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

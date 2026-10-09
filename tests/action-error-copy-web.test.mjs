import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { profile } from './profile.mjs';

/**
 * V1.8 #12：动作失败时弹窗只给业务语言，不出现 GEA_HTTP_409、payload.plan_month 这类
 * 接口/字段/错误码；技术细节与「错误编号」只进控制台，编号可以在界面上口头转述。
 */
test('action failure dialog shows business copy plus a transferable error id', { timeout: 90000 }, async (t) => {
  const app = await profile(t);
  const plan = { planId: 'p', versionId: 'v', seq: 1, periodId: 'period-1', planTypeCode: 'Y', orderType: 'M', dealerCode: 'd', dealerName: '客户A', orgCode: 'org', orgName: '宝阳销售组', provinceCode: 'province', provinceName: '华南省区', areaCode: 'area', areaName: '华南大区', status: 1, currentQty: '20', currentAmount: '200', targetQty: '40', targetAmount: '400', skuCount: 1 };
  const sku = { id: 's', skuCode: '1001', versionId: 'v', productCategName: '汤圆', materialDescription: '黑芝麻汤圆 500g', qty: '20', baseQty: '10', amt: '200', amtBase: '100', price: '10' };
  app.route((req, _res, reply) => {
    const path = req.url.pathname;
    const send = (result) => { reply({ success: true, result }); return true; };
    if (path.endsWith('/getPermCode')) return send({ codeList: ['sales-plan:plan:region-approve'] });
    if (path.endsWith('/plans')) { const status = req.url.searchParams.get('status'); const records = status === null || status === '1' ? [plan] : []; return send({ records, total: records.length, pages: 1, current: 1, size: 20 }); }
    if (path.endsWith('/plans/p')) return send({ currentVersion: { ...plan, id: 'v', effective: true }, skus: [sku], versions: [], logs: [], actionContext: { versionId: 'v', status: 1, nodeOrder: 2, allowedActions: ['APPROVE', 'REJECT'], snapshotHash: 'a'.repeat(64) } });
    if (path.endsWith('/versions')) return send([{ ...plan, id: 'v', effective: true }]);
    if (path.endsWith('/versions/v/skus')) return send([sku]);
    if (path.endsWith('/versions/v/actions')) {
      // 服务端原始报错：带错误码 + 字段名，绝不能出现在界面上。
      reply({ message: 'payload.plan_month 为必填字段', errorCode: 'NOTIFICATION_PAYLOAD_INVALID', code: 409, requestId: 'req' }, 409);
      return true;
    }
    return false;
  });
  await app.login();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1536, height: 920 } });
  await context.addCookies(app.cookie.split('; ').map((pair) => ({ name: pair.slice(0, pair.indexOf('=')), value: pair.slice(pair.indexOf('=') + 1), url: app.origin })));
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const warned = [];
  page.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'warn') warned.push(message.text()); });
  await page.goto(app.origin);
  await page.getByRole('dialog', { name: /内测声明|预览版说明/, exact: true }).getByRole('button', { name: '继续', exact: true }).click();
  const frame = page.frameLocator('iframe[data-gea-workbench]');
  await expect(frame.getByTestId('regional-approval-workbench')).toBeVisible();
  await frame.locator('label.arco-checkbox:has(input[value="p"])').click();
  // 退回弹窗不会在失败时自动关闭，正好用来核对失败提示文案。
  await frame.getByRole('button', { name: '退回', exact: true }).click();
  const dialog = frame.getByRole('dialog');
  await expect(dialog.getByLabel('退回原因（必填）', { exact: true })).toBeVisible();
  await dialog.getByLabel('退回原因（必填）', { exact: true }).fill('测试退回原因');
  await dialog.getByRole('button', { name: '确认退回', exact: true }).click();
  // 上游 409 带着原因码时，不能统一说成"并发冲突、请刷新"——这条是服务端通知载荷被拒，
  // 刷新解决不了，必须直接告诉用户去找后端。
  await expect(dialog.getByText('服务端在生成审批通知时被拒绝，属于服务端问题，刷新无法解决', { exact: false })).toBeVisible({ timeout: 20000 });
  const dialogText = await dialog.innerText();
  assert.ok(!dialogText.includes('并发'), `服务端业务拒绝不应被描述成并发冲突：${dialogText}`);
  for (const leak of ['payload', 'plan_month', 'GEA_HTTP', 'NOTIFICATION_PAYLOAD_INVALID', '必填字段']) {
    assert.ok(!dialogText.includes(leak), `界面上不应出现「${leak}」，实际：${dialogText}`);
  }
  const reference = /错误编号：([A-Z0-9]{6})/.exec(dialogText);
  assert.ok(reference, `失败提示应给出错误编号，实际：${dialogText}`);
  // 技术细节只进控制台，且带着同一个错误编号，便于管理员核对。
  assert.ok(warned.some((line) => line.includes(reference[1]) && line.includes('plan_month')), `控制台应有编号与原始报错：${JSON.stringify(warned)}`);

  // 直接「通过」失败时弹窗会关掉、错误落到队列顶部，这条路径同样不能出现技术文案。
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // 退回请求失败后这一笔没被受理，勾选已经清掉；再点「通过」要重新勾一次。
  await expect(frame.locator('label.arco-checkbox:has(input[value="p"]) input')).not.toBeChecked();
  await frame.locator('label.arco-checkbox:has(input[value="p"])').click();
  await frame.getByRole('button', { name: '通过', exact: true }).click();
  const queueAlert = frame.locator('[class*="exportFeedback"]');
  await expect(queueAlert).toBeVisible({ timeout: 20000 });
  // 失败后勾选要一起清掉：这一批没被受理，留着的勾选会让人以为还能直接再点。
  await expect(frame.locator('label.arco-checkbox:has(input[value="p"]) input')).not.toBeChecked();
  const queueText = await queueAlert.innerText();
  assert.ok(queueText.includes('操作请求失败且未更新本地状态'), `队列提示应是业务文案，实际：${queueText}`);
  for (const leak of ['payload', 'plan_month', 'GEA_HTTP', 'NOTIFICATION_PAYLOAD_INVALID']) {
    assert.ok(!queueText.includes(leak), `队列提示不应出现「${leak}」，实际：${queueText}`);
  }
});

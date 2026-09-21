import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/workbench/original/workbenches/regionalApproval/models/salesPlanActionModel.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

/** V1.8 #12：给业务的文案里不能出现接口、字段名、参数名、错误码。 */
test('technical backend text never reaches business copy', () => {
  const technical = [
    'GEA_HTTP_409：payload.plan_month 为必填字段',
    'payload.plan_month 为必填字段',
    'NOTIFICATION_PAYLOAD_INVALID',
    'SALES_PLAN_CONFLICT',
    '{"code":"X","message":"y"}',
    'https://gea.synear.cn/gea-boot/sales-plan/plans',
    'currentVersion.status is null',
    ['过长报文', 'x'.repeat(120)].join(''),
    '',
    undefined,
  ];
  for (const text of technical) assert.equal(m.businessSafeErrorMessage(text), undefined, String(text));

  const business = [
    '多人节点尚未结束，调整量请由最后一位审批人提交',
    '退回原因不能为空',
    '当前角色不具备该版本的调整权限',
  ];
  for (const text of business) assert.equal(m.businessSafeErrorMessage(text), text);
});

/** 技术细节只进日志，并给出可口头转述的错误编号。 */
test('reported error id is human-transferable and detail stays in the log', () => {
  const logged = [];
  const original = console.warn;
  console.warn = (...args) => logged.push(args);
  try {
    const id = m.reportSalesPlanError('sales-plan-action', { backendMessage: 'payload.plan_month 为必填字段' });
    assert.match(id, /^[A-Z0-9]{6}$/);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /sales-plan-action/);
    assert.match(String(logged[0][0]), new RegExp(id));
    assert.deepEqual(logged[0][1], { backendMessage: 'payload.plan_month 为必填字段' });
  } finally {
    console.warn = original;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const { outputFiles } = await build({stdin: {contents: "export * from './src/workbench/original/workbenches/regionalApproval/regionalApprovalQueryModel.ts'; export * from './src/workbench/original/salesPlanWorkflow.ts';", resolveDir: process.cwd()}, bundle: true, write: false, platform: 'node', format: 'esm'});
const { salesPlanVisibleStatuses, salesPlanWorkflow } = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));
test('Y visibility includes pending, own returns and read-only tracking, excludes other returns and earlier steps', () => {
  const expected = {customer: [0,1,2,3,4,5,6,10], region: [1,2,3,4,5,6,7,10], province: [2,3,4,5,7,8,10], area: [3,4,5,8,9,10], category: [4,5,9,10]};
  for (const [role, statuses] of Object.entries(expected)) assert.deepEqual(salesPlanVisibleStatuses('Y', [role]), statuses);
  assert.deepEqual(salesPlanVisibleStatuses('Y', ['region','province']), [1,2,3,4,5,6,7,8,10]);
  assert.deepEqual(salesPlanVisibleStatuses('unknown', ['region']), []);
});
test('category queue includes approval and DMS completion states without expanding write permissions', () => {
  const flow = salesPlanWorkflow('Y');
  assert.deepEqual(flow.queueStatuses('category'), [4,5,10]);
  assert.deepEqual(flow.pendingStatuses('category'), [4]);
  assert.equal(flow.visibility(4, 'category'), 'writable');
  assert.equal(flow.visibility(5, 'category'), 'read-only');
  assert.equal(flow.visibility(10, 'category'), 'read-only');
});
test('XN has no region visibility and returns to the next configured node after customer resubmission', () => {
  assert.deepEqual(salesPlanVisibleStatuses('XN', ['region']), []);
  assert.deepEqual(salesPlanVisibleStatuses('XN', ['province']), [2,3,4,5,6,8,10]);
  const flow = salesPlanWorkflow('XN');
  assert.equal(flow.transition(2, 'REJECT'), 6);
  assert.equal(flow.resubmit(6), 2);
  assert.equal(flow.actor(2), 'province');
  assert.equal(flow.actor(1), undefined);
  assert.equal(flow.actor(7), undefined);
  for (const status of [5,10]) for (const action of ['APPROVE','REJECT']) assert.equal(flow.transition(status, action), undefined);
});

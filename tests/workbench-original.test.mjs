/** Adapted from AionUi salesPlanExportModel and salesPlanAccessModel unit tests; Apache-2.0. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: [
      "export * from './src/workbench-original/workbenches/regionalApproval/models/salesPlanExportModel.ts';",
      "export * from './src/workbench-original/workbenches/regionalApproval/models/salesPlanAccessModel.ts';",
      "export * from './src/workbench-original/bridge.ts';",
    ].join('\n'),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const {
  aggregateSalesPlanExportAmounts,
  salesPlanAccessForRow,
  salesPlanStagesForPermissions,
  verifySavedSalesPlan,
  bindWorkbenchHost,
  salesPlan,
} = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

const sku = (id, overrides = {}) => ({
  id, skuCode: id, versionId: 'version-1', productCategName: 'Test',
  baseQty: '1', price: '10', amtBase: '10', qty: '0.1', amt: '1.01',
  regionConfirmedQty: '2.125', regionConfirmedAmount: '21.25',
  provinceConfirmedQty: '3.125', provinceConfirmedAmount: '31.25',
  areaConfirmedQty: '4.125', areaConfirmedAmount: '41.25',
  categoryConfirmedQty: '5.125', categoryConfirmedAmount: '51.25',
  ...overrides,
});

test('copied workbench exports exact amounts beyond JavaScript integer precision', () => {
  assert.deepEqual(aggregateSalesPlanExportAmounts({ versionId: 'version-1', skuCount: 2 }, [
    sku('01'), sku('02', { qty: '0.2', amt: '9999999999999999.99' }),
  ]), {
    qty: '0.3', amt: '10000000000000001.00',
    regionConfirmedQty: '4.250', regionConfirmedAmount: '42.50',
    provinceConfirmedQty: '6.250', provinceConfirmedAmount: '62.50',
    areaConfirmedQty: '8.250', areaConfirmedAmount: '82.50',
    categoryConfirmedQty: '10.250', categoryConfirmedAmount: '102.50',
  });
});

test('copied workbench preserves zero confirmation and rejects incomplete or mismatched export rows', () => {
  const row = { versionId: 'version-1', skuCount: 2 };
  const result = aggregateSalesPlanExportAmounts(row, ['01', '02'].map(id => sku(id, {
    areaConfirmedQty: '0', areaConfirmedAmount: '0', categoryConfirmedQty: null, categoryConfirmedAmount: null,
  })));
  assert.equal(result.areaConfirmedQty, '0');
  assert.equal(result.areaConfirmedAmount, '0');
  assert.equal(result.categoryConfirmedQty, null);
  assert.equal(result.categoryConfirmedAmount, null);
  for (const rows of [
    [sku('01')], [sku('01'), sku('02', { versionId: 'other' })],
    [sku('01'), sku('01')], [sku('01'), sku('02', { skuCode: '01' })],
    [sku('01'), sku('02', { regionConfirmedQty: null, regionConfirmedAmount: '10' })],
  ]) assert.throws(() => aggregateSalesPlanExportAmounts(row, rows));
});

const plan = { planId: 'p', versionId: 'v', status: 10, planTypeCode: 'Y' };
const detail = {
  currentVersion: { id: 'v', planId: 'p', status: 10, effective: true, planTypeCode: 'Y' },
  skus: [], versions: [], logs: [],
  actionContext: { versionId: 'v', status: 10, nodeOrder: 5, allowedActions: ['SAVE'], snapshotHash: 'a'.repeat(64) },
};

test('copied action projection does not infer write permission from readable plans', () => {
  assert.deepEqual(salesPlanStagesForPermissions(), []);
  assert.deepEqual(salesPlanStagesForPermissions(['sales-plan:plan:approve']), []);
  assert.deepEqual(salesPlanAccessForRow(plan, detail)?.allowedActions, ['SAVE']);
  assert.equal(salesPlanAccessForRow(plan, { ...detail, actionContext: undefined }), undefined);
  assert.equal(salesPlanAccessForRow({ ...plan, versionId: 'other' }, detail), undefined);
  assert.equal(salesPlanAccessForRow({ ...plan, status: 5 }, detail), undefined);
  assert.equal(salesPlanAccessForRow(plan, { ...detail, actionContext: { ...detail.actionContext, snapshotHash: '' } }), undefined);
});

test('copied SAVE verification requires exact readback, matching audit receipt and unchanged version', () => {
  const item = { id: 's', versionId: 'v', skuCode: '10001', price: '2', areaConfirmedQty: '12', categoryConfirmedQty: '13' };
  const before = { ...detail, skus: [item] };
  const receipt = { planId: 'p', versionId: 'v', fromStatus: 10, toStatus: 10, auditId: 'sales-plan-log:42', requestId: 'request', traceId: 'trace' };
  const request = { action: 'SAVE', expectedStatus: 10, adjustments: [{ skuCode: '10001', adjustQty: '2.125' }] };
  const after = {
    ...before,
    skus: [{ ...item, categoryConfirmedQty: '15.125', categoryConfirmedAmount: '30.25' }],
    logs: [{ id: '42', planId: 'p', requestId: 'request', traceId: 'trace', versionId: 'v', fromStatus: 10, toStatus: 10, actionCode: 'SAVE' }],
  };
  assert.equal(verifySavedSalesPlan(before, after, request, receipt), true);
  for (const stale of [
    { ...after, skus: [{ ...after.skus[0], categoryConfirmedAmount: '26' }] },
    { ...after, skus: [item] }, { ...after, logs: [] },
    { ...after, currentVersion: { ...after.currentVersion, id: 'new' } },
    { ...after, currentVersion: { ...after.currentVersion, status: 5 } },
  ]) assert.equal(verifySavedSalesPlan(before, stale, request, receipt), false);
});

test('workbench bridge keeps host request identity and cannot reuse a released document binding', async () => {
  assert.throws(() => salesPlan.list.invoke({}), /WORKBENCH_HOST_NOT_BOUND/);
  const signal = new AbortController().signal;
  const query = { periodId: '9007199254740993', status: 5, pageNo: 1, pageSize: 20, signal };
  const value = { records: [sku('9007199254740995')], total: 1, current: 1, size: 20, pages: 1 };
  const host = { salesPlan: { list: { invoke: async input => { assert.equal(input, query); return value; } } } };
  const release = bindWorkbenchHost(host);
  assert.throws(() => bindWorkbenchHost(host), /WORKBENCH_HOST_ALREADY_BOUND/);
  assert.equal(await salesPlan.list.invoke(query), value);
  release();
  assert.throws(() => salesPlan.list.invoke(query), /WORKBENCH_HOST_NOT_BOUND/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeGroupSkus } from '../src/workbench/original/workbenches/regionalApproval/models/salesPlanGroupSkuModel.ts';

const plan = (planId, versionId, skuCount = 1) => ({ planId, versionId, skuCount, status: 1, planTypeCode: 'Y' });
const sku = (versionId, qty, price) => ({
  id: `id-${versionId}`, skuCode: '1001', versionId, productCategName: '汤圆',
  materialDescription: '黑芝麻汤圆', baseQty: '1', qty, amtBase: price, price,
});

test('同一 SKU 跨计划按各自单价精确汇总，待确认数量同步计入', () => {
  const sources = [
    { plan: plan('p1', 'v1'), skus: [sku('v1', '2', '10')] },
    { plan: plan('p2', 'v2'), skus: [sku('v2', '3', '12')] },
  ];
  assert.deepEqual(summarizeGroupSkus(sources), [{
    skuCode: '1001', categoryName: '汤圆', description: '黑芝麻汤圆',
    baseQty: '2', qty: '5', baseAmount: '22', amount: '56.00',
  }]);
  assert.equal(summarizeGroupSkus(sources, undefined, { p1: { '1001': '4' } })[0].amount, '76.00');
});

test('任一版本 SKU 不完整或串入其他版本时拒绝显示部分合计', () => {
  assert.throws(() => summarizeGroupSkus([{ plan: plan('p1', 'v1', 2), skus: [sku('v1', '2', '10')] }]));
  assert.throws(() => summarizeGroupSkus([{ plan: plan('p1', 'v1'), skus: [sku('v2', '2', '10')] }]));
});

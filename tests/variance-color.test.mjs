import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/workbench/original/workbenches/regionalApproval/models/salesPlanVarianceModel.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64'));

/** V1.8 #14：差额正数红、负数绿、零和缺值保持中性，正负号保留在文案里。 */
test('variance sign drives the colour class in both directions', () => {
  const classOf = (value) => m.salesPlanVarianceClass(value, 'red', 'green');
  assert.equal(classOf('924.74'), 'red', '正数用红色');
  assert.equal(classOf('0.01'), 'red');
  assert.equal(classOf('-924.74'), 'green', '负数用绿色');
  assert.equal(classOf('-0.01'), 'green');
  assert.equal(classOf('0'), undefined, '零保持中性');
  assert.equal(classOf('-0.00'), undefined);
  assert.equal(classOf('—'), undefined, '缺值不能猜成正数');
  assert.equal(classOf(''), undefined);
  assert.equal(classOf(null), undefined);
  assert.equal(classOf(undefined), undefined);
  assert.equal(classOf('¥924.74'), undefined, '带符号的展示串不走这条规则');
  assert.equal(m.salesPlanVarianceSign('120'), 'positive');
  assert.equal(m.salesPlanVarianceSign('-120.5'), 'negative');
  assert.equal(m.salesPlanVarianceSign('0.00'), 'zero');
});

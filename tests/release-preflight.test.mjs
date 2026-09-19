import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('release source keeps the shipped dashboard and toolbar features', async () => {
  const source = await readFile('src/workbench/original/workbenches/regionalApproval/RegionalApprovalWorkbench.tsx', 'utf8');
  const zh = await readFile('src/workbench/original/zh-CN.json', 'utf8');
  for (const marker of ['<Filter size={16} strokeWidth={3} />', '<ChartHistogram size={16} />', 'setSelectedRowIds(keys.map(String))']) {
    assert.ok(source.includes(marker), `missing ${marker}`);
  }
  assert.ok(zh.includes('"pageTitle": "当前页明细汇总"'));
});

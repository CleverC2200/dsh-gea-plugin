import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles} = await build({entryPoints:['src/workbench-original/workbenches/regionalApproval/regionalApprovalQueryModel.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const m = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
test('V1.6 organization totals include quantity targets from every child',()=>{
 const row={planId:'p',versionId:'v',orgCode:'org',dealerCode:'d',status:1,skuCount:1,currentQty:'2',currentAmount:'20',targetQty:'4',targetAmount:'40'};
 const [{summary}] = m.groupRegionalApprovalLiveRows([m.toRegionalApprovalLiveRow(row),m.toRegionalApprovalLiveRow({...row,planId:'p2',versionId:'v2'})],'region');
 assert.equal(summary.targetQty,'8');
 assert.deepEqual(m.regionalApprovalLiveProgress(summary),{amount:50,quantity:50});
});

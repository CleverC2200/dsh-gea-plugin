import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const {outputFiles} = await build({entryPoints:['src/workbench/original/workbenches/regionalApproval/regionalApprovalQueryModel.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const m = await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].contents).toString('base64'));
test('V1.6 organization totals include targets and derived monthly plans from every child',()=>{
 const row={planId:'p',versionId:'v',orgCode:'org',dealerCode:'d',status:1,skuCount:1,mPlanQty:'1.5',mPlanAmount:'10.25',currentQty:'2',currentAmount:'20',targetQty:'4',targetAmount:'40'};
 const [{summary}] = m.groupRegionalApprovalLiveRows([m.toRegionalApprovalLiveRow(row),m.toRegionalApprovalLiveRow({...row,planId:'p2',versionId:'v2'})],'region');
 assert.equal(summary.targetQty,'8');
 assert.equal(summary.mPlanQty,'3.0');
 assert.equal(summary.mPlanAmount,'20.50');
 assert.deepEqual(m.regionalApprovalLiveProgress(summary),{amount:50,quantity:50});
});

test('V1.6 derives monthly plan totals from SKU base values without rounding',()=>{
 const categories=m.aggregateRegionalApprovalLiveCategories([
  {versionId:'v',skuCode:'1',productCategName:'汤圆',baseQty:'10.125',amtBase:'100.01',qty:'20',amt:'200'},
  {versionId:'v',skuCode:'2',productCategName:'汤圆',baseQty:'0.875',amtBase:'0.99',qty:'1',amt:'10'},
 ]);
 assert.deepEqual({quantity:categories[0].baseQuantity,amount:categories[0].baseAmount},{quantity:'11.000',amount:'101.00'});
});

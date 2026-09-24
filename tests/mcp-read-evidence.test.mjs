import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const out=await build({entryPoints:['src/host/mcp-read-evidence.ts'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const m={exports:{}};new Function('require','module','exports',out.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);
const {mcpReadReceipts,createMcpReadLedger}=m.exports;
const parameters={action:'query',queries:[{name:'customers',query:{dimensions:['inv.cust_code'],measures:['inv.row_count'],limit:3,filters:[{member:'inv.stat_date',operator:'equals',values:['2026-09-22']}]}}]};
test('inline receipts retain exact values, filters and bounded sample scope',()=>{
 const output='prefix '+String.raw`{"datasets":[{"name":"customers","hasMore":false,"rows":[{"id":9007199254740999,"amt":0.1234567890123456789,"inv.row_count":60948}]}]}`+' suffix';
 const [receipt]=mcpReadReceipts('dealer',parameters,output);
 assert.equal(receipt.rows[0].id,'9007199254740999');assert.equal(receipt.rows[0].amt,'0.1234567890123456789');
 assert.equal(receipt.query.query.limit,3);assert.deepEqual(receipt.query.query.filters,parameters.queries[0].query.filters);
 assert.equal(receipt.coverage,'query-scope-only');assert.equal(receipt.observedRows,1);
});
test('artifact pages are evidence, unknown or error shapes are not empty successes',()=>{
 const wrap=page=>JSON.stringify({queryArtifact:{resources:[{contents:[{text:JSON.stringify(page)}]}]}});
 assert.equal(mcpReadReceipts('dealer',parameters,wrap({datasetName:'customers',totalRows:50,rows:[{code:'001'}]}))[0].transportHasMore,'unknown');
 for(const output of ['not JSON','{}','{"datasets":[{"name":"customers"}]}','{"success":false,"datasets":[{"name":"customers","rows":[]}]}',wrap({datasetName:'wrong',rows:[]})]) assert.deepEqual(mcpReadReceipts('dealer',parameters,output),[]);
 assert.equal(mcpReadReceipts('dealer',parameters,wrap({datasetName:'customers',rows:[]}))[0].availability,'empty-query-result');
});
test('ledger clears completed renamed queries only, bounds receipts, and isolates scopes and resets',()=>{
 const ledger=createMcpReadLedger();ledger.rememberPending('one','dealer',parameters);
 ledger.rememberPending('two','dealer',parameters);
 const renamed={...parameters,queries:[{...parameters.queries[0],name:'renamed'}]};
 ledger.success('one','dealer',renamed,JSON.stringify({datasets:[{name:'renamed',rows:Array.from({length:100},(_,i)=>({code:String(i),value:'x'.repeat(80)}))}]}));
 assert.equal(ledger.pending('one').length,0);assert.equal(ledger.pending('two').length,1);
 assert.equal(ledger.evidence('one')[0].observedRows,100);assert.equal(ledger.evidence('one')[0].rowsOmitted,true);
 assert.ok(Buffer.byteLength(JSON.stringify(ledger.evidence('one')))<4000);
 ledger.clear('one');assert.equal(ledger.evidence('one').length,0);assert.equal(ledger.pending('two').length,1);
 ledger.clear();assert.equal(ledger.pending('two').length,0);
});

test('in-flight responses cannot revive prior-turn or prior-login evidence',()=>{
 const ledger=createMcpReadLedger();const old=ledger.epoch('one');
 ledger.clear('one');ledger.epoch('one');
 const text=JSON.stringify({datasets:[{name:'customers',rows:[{code:'prior-user'}]}]});
 ledger.success('one','dealer',parameters,text,old);
 ledger.rememberPending('one','dealer',parameters,old);
 assert.deepEqual(ledger.evidence('one'),[]);assert.deepEqual(ledger.pending('one'),[]);
 const current=ledger.epoch('one');ledger.clear();ledger.success('one','dealer',parameters,text,current);
 assert.deepEqual(ledger.evidence('one'),[]);
});

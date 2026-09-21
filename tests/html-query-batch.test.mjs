import test from 'node:test';
import assert from 'node:assert/strict';
import {readHtmlBatch} from '../src/html-query-batch.ts';
test('opt-in compact transfer removes only the identical records alias',async()=>{
 const rows=[{sku:'A',qty:null}];
 const value={rows,records:rows,total:1,rejectedColumns:['secret']};
 const compact=await readHtmlBatch([{sql:'ok'}],async()=>value,{compactRows:true});
 assert.deepEqual(compact.results[0].value,{rows,total:1,rejectedColumns:['secret']});
 assert.equal((await readHtmlBatch([{sql:'ok'}],async()=>value)).results[0].value.records,rows);
 const different={rows,records:[{other:1}]};
 assert.deepEqual((await readHtmlBatch([{sql:'ok'}],async()=>different,{compactRows:true})).results[0].value,different);
});
test('batch preserves ordering and does not turn a failed SQL into empty data', async()=>{
 const result=await readHtmlBatch([{sql:'ok'},{sql:'denied'}],async q=>{if(q.sql==='denied')throw Error('NO_RETURN_COLUMN_ALLOWED');return {rows:[{sku:'A'}],rejectedColumns:['qty']}});
 assert.deepEqual(result.results,[{ok:true,value:{rows:[{sku:'A'}],rejectedColumns:['qty']}},{ok:false,error:'NO_RETURN_COLUMN_ALLOWED'}]);
});
test('batch bounds and nested query validation run before any reads',async()=>{
 for(const input of [[],Array(9).fill({sql:'x'}),[{sql:'x',queries:[]}],[null]])
   await assert.rejects(readHtmlBatch(input,async()=>assert.fail('must not read')),/INVALID_SQL_BATCH/);
});

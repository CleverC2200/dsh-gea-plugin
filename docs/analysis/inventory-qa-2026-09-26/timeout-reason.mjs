import test from 'node:test';import assert from 'node:assert/strict';import {mkdir,writeFile} from 'node:fs/promises';
import {transportSignal} from '../../../src/shared/transport-signal.ts';import {networkError} from '../../../src/shared/net-error.ts';
await mkdir('.runtime/inventory-qa-20260926',{recursive:true});
test('timeout must not turn into indistinguishable user cancellation',async()=>{
 const source=new AbortController();const transport=transportSignal(source.signal);source.abort(new DOMException('deadline reached','TimeoutError'));
 const error=networkError(transport.signal.reason,{what:'fixture model',stage:'流式读取',timeoutMs:120000});
 const result={source:source.signal.reason.name,transport:transport.signal.reason.name,error:{name:error.name,message:error.message,code:error.code}};
 await writeFile('.runtime/inventory-qa-20260926/timeout-reason.json',JSON.stringify(result,null,2));console.log(result);transport.dispose();
 assert.match(error.message,/TIMEOUT|超时/);
});

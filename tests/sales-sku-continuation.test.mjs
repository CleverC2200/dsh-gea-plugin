import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';

const output = await build({entryPoints:['src/host/business.ts'],bundle:true,packages:'external',write:false,platform:'node',format:'cjs'});
const module = {exports:{}};
new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
const versionId = 'v-continuation';
const rows = Array.from({length:23}, (_,i)=>({versionId,skuCode:`sku-${i}`,materialDescription:'变长物料'.repeat(i % 3 === 0 ? 180 : 40),qty:i === 4 ? null : '1.000',amt:'2.00'}));
function fixture(t, values=rows, intercept) {
  const business = new module.exports.Business({geaBaseUrl:'https://gea.fixture',analysisAgentCode:'sales_forecast',requestTimeoutMs:2000,inputByteBudget:4300,pageSize:50});
  business.restoreDesktopLogin({schema:1,environment:'production',base:'https://gea.fixture',auth:{token:'fixture',tenantId:'0',name:'Test',id:'u',username:'test'}});
  t.after(()=>business.dispose());
  t.mock.method(globalThis,'fetch',async(url,init)=> {
    assert.equal(new URL(url).pathname,`/sales-plan/plans/versions/${versionId}/skus`);
    await intercept?.(business, init);
    return Response.json({success:true,result:values});
  });
  return {business, read:(query,signal=new AbortController().signal)=>business.agentQuery({kind:'versionSkus',query},signal).then(JSON.parse)};
}

test('model SKU continuation traverses variable rows under budget without skips or duplicates',async t=> {
  const f=fixture(t);
  let query={versionId,pageNo:1,pageSize:50};
  const seen=[];
  for(let turns=0; query && turns<30; turns++) {
    const result=await f.read(query);
    assert.ok(Buffer.byteLength(JSON.stringify(result),'utf8') <= 4300);
    seen.push(...result.value.records);
    assert.ok(Object.hasOwn(result.value,'nextQuery'));
    query=result.value.nextQuery;
  }
  assert.deepEqual(seen.map(row=>row.skuCode),['sku-0','sku-1','sku-2','sku-3','sku-4','sku-5','sku-6','sku-7','sku-8','sku-9','sku-10','sku-11','sku-12','sku-13','sku-14','sku-15','sku-16','sku-17','sku-18','sku-19','sku-20','sku-21','sku-22']);
  assert.equal(seen[4].qty,null);
  assert.equal(seen[4].baseQty,null);
  assert.equal(query,null);
});

test('one SKU exceeding the byte budget rejects without claiming a complete page',async t=> {
  const f=fixture(t,[{versionId,skuCode:'huge',materialDescription:'超长物料'.repeat(5000),qty:null,amt:null}]);
  await assert.rejects(f.read({versionId,pageSize:50}),/SNAPSHOT_TOO_LARGE/);
});

test('cancellation and identity revocation discard late SKU pages',async t=> {
  for(const revoke of ['cancel','logout']) {
    const controller=new AbortController();
    const f=fixture(t, rows, async business=> {
      if(revoke === 'cancel') controller.abort(new Error('cancelled paging'));
      else business.logout();
    });
    await assert.rejects(f.read({versionId,pageSize:50},controller.signal));
  }
});

test('invalid continuation positions reject before reading and empty results have no continuation',async t=> {
  const f=fixture(t,[]);
  for(const query of [{versionId,offset:-1},{versionId,offset:0.5},{versionId,offset:0,pageNo:2}])
    await assert.rejects(f.read(query),/INVALID_QUERY/);
  const result=await f.read({versionId,offset:0,pageSize:50});
  assert.equal(result.coverage,'complete');
  assert.deepEqual(result.value.records,[]);
  assert.equal(result.value.nextQuery,null);
});

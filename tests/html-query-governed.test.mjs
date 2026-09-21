import test from "node:test";
import assert from "node:assert/strict";
import { prepareHtmlQuery, readHtmlQuery } from "../src/html-query.ts";

test("HTTP 200 business execution failure reports the business code, not HTTP success", async () => {
  await assert.rejects(readHtmlQuery({sql:'SELECT sku FROM inventory',pageNo:1},{
    endpoint:'https://gea.test',token:'test',signal:new AbortController().signal,
    fetch:async()=>Response.json({success:false,code:500,message:'受控 SQL 执行失败',result:null}),
  }),error=>error.message.includes('业务码 500')&&!error.message.includes('GEA_HTTP_200'));
});

test("named parameters are exact and cannot use GEA reserved names", () => {
  assert.throws(() => prepareHtmlQuery({sql: "SELECT :__gea_user AS value", parameters: {__gea_user: 1}}), /RESERVED_QUERY_PARAMETER/);
  assert.throws(() => prepareHtmlQuery({sql: "SELECT :value AS value", parameters: {value: 1, extra: 2}}), /UNUSED_QUERY_PARAMETER/);
  assert.throws(() => prepareHtmlQuery({sql: "SELECT :value AS value", parameters: {}}), /MISSING_QUERY_PARAMETER/);
  assert.deepEqual(prepareHtmlQuery({sql: "SELECT ':ignored' AS label, :value AS value", parameters: {value: "[]"}}).values, ["[]"]);
});

test("partial field permissions survive the HTML query boundary", async () => {
  const metadata = {returnedColumns: [{alias: "sku"}], rejectedColumns: [{alias: "amount", reason: "RETURN_PERMISSION_DENIED"}]};
  const result = await readHtmlQuery({sql: "SELECT sku, amount FROM inventory ORDER BY sku", pageNo: 1}, {
    endpoint: "https://gea.test", token: "test", signal: new AbortController().signal,
    fetch: async () => Response.json({success: true, result: {rows: [{sku: "A"}], total: 1, ...metadata}}),
  });
  assert.deepEqual(result.returnedColumns, metadata.returnedColumns);
  assert.deepEqual(result.rejectedColumns, metadata.rejectedColumns);
  assert.deepEqual(result.rows, [{sku: "A"}]);
});

for (const reasonCode of ["RESOURCE_NOT_PUBLISHED", "NO_RETURN_COLUMN_ALLOWED"]) {
  test(`${reasonCode} is an error, not empty data or retryable failure`, async () => {
    let calls = 0;
    await assert.rejects(readHtmlQuery({sql: "SELECT sku FROM inventory ORDER BY sku", pageNo: 1}, {
      endpoint: "https://gea.test", token: "test", signal: new AbortController().signal,
      fetch: async () => { calls++; return Response.json({success: false, failure: {stage: "AUTHORIZE", reasonCode}}); },
    }), error => error.code === reasonCode && error.retryable === false);
    assert.equal(calls, 1);
  });
}

test("compact rows response avoids duplicating large results and keeps permission metadata",async()=>{
 const transport={endpoint:'https://gea.test',token:'test',signal:new AbortController().signal,fetch:async()=>Response.json({success:true,result:{rows:[{sku:'A',payload:'x'.repeat(10000)}],total:1,returnedColumns:[{alias:'sku'}],rejectedColumns:[{alias:'denied'}]}})};
 const normal=await readHtmlQuery({sql:'SELECT sku FROM inventory ORDER BY sku',pageNo:1},transport);
 const compact=await readHtmlQuery({sql:'SELECT sku FROM inventory ORDER BY sku',pageNo:1,resultShape:'rows'},transport);
 assert.deepEqual(compact.rows,normal.rows);assert.deepEqual(compact.rejectedColumns,normal.rejectedColumns);assert.deepEqual(compact.returnedColumns,normal.returnedColumns);
 assert.equal(compact.records,undefined);assert.ok(JSON.stringify(compact).length<JSON.stringify(normal).length*.55);
});

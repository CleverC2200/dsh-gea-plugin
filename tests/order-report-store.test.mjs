import test from 'node:test';
import assert from 'node:assert/strict';
import { orderReportStore } from '../src/host/order-report-store.ts';

const period = { type: 'WEEK', start: '2026-10-12', end: '2026-10-19' };
const identity = { tenantId: '0', id: 'test-editor', reportScope: {key:'order:base:郑州',base:'郑州'} };
const report = { schemaVersion: 1, facts: { complete: true, periods: { week: { value: 0 } } }, edits: { summary: { positive: '测试' }, references: [{ name: '链接', url: 'https://example.com' }] } };
test('report round trip preserves zero, edits, idempotency and rejects stale revision', async () => {
  let row;
  let writes = 0;
  const execute = async (sql, p) => {
    assert.equal(p.tenant, 0);
    assert.equal(p.scope, 'order:base:郑州');
    assert.equal(p.consumer, 'order');
    if (sql.startsWith('SELECT')) return { rows: row ? [row] : [], rejectedColumns: [] };
    writes++;
    assert.equal(p.actor, 'test-editor');
    row = { report_data: p.report, schema_version: 1, version: p.next, last_request_id: p.request };
    return { affectedRows: 1 };
  };
  const save = { operation: 'save', period, report, expectedVersion: 0, requestId: 'test-save-request-0001' };
  assert.equal((await orderReportStore(save, identity, execute)).saved, true);
  assert.deepEqual((await orderReportStore({ operation: 'load', period }, identity, execute)).report, report);
  await orderReportStore(save, identity, execute);
  assert.equal(writes, 1);
  await assert.rejects(orderReportStore({ ...save, requestId: 'test-save-request-0002' }, identity, execute), /VERSION_CONFLICT/);
  await assert.rejects(orderReportStore({ ...save, tenant: 1 }, identity, execute), /REQUEST_INVALID/);
});
test('denial, missing columns, duplicate keys and unconfirmed writes never report success', async () => {
  const load = { operation: 'load', period };
  await assert.rejects(orderReportStore(load, identity, async () => { throw Error('ROW_SCOPE_DENIED'); }), /ROW_SCOPE_DENIED/);
  await assert.rejects(orderReportStore(load, identity, async () => ({ rows: [{}] })), /FORMAT_INVALID/);
  await assert.rejects(orderReportStore(load, identity, async () => ({ rows: [{}, {}] })), /READ_INCOMPLETE/);
  await assert.rejects(orderReportStore({ ...load, operation: 'save', report, expectedVersion: 0, requestId: 'test-save-request-0001' }, identity, async () => ({ rows: [] })), /SAVE_NOT_CONFIRMED/);
});
import {gzipSync} from 'node:zlib';
test('compressed page report is decoded without dropping edits or facts',async()=>{
 let row;
 const execute=async(sql,p)=>{if(sql.startsWith('SELECT'))return {rows:row?[row]:[]};row={report_data:p.report,version:p.next,last_request_id:p.request,schema_version:1};return {affectedRows:1};};
 await orderReportStore({operation:'save',period,expectedVersion:0,requestId:'compressed-request-0001',report:{encoding:'gzip-base64',data:gzipSync(JSON.stringify(report)).toString('base64')}},identity,execute);
 const restored=await orderReportStore({operation:'load',period},identity,execute);
 assert.deepEqual(restored.report,report);
 assert.deepEqual(restored.scope,identity.reportScope);
 await assert.rejects(orderReportStore({operation:'save',period,report:{encoding:'gzip-base64',data:'not gzip'}},identity,execute),/FORMAT_INVALID/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { orderReportWithEdits } from "../src/host/order-report-edits.ts";
const identity = {
  tenantId: "0",
  id: "editor",
  reportScope: { key: "order:base:郑州", base: "郑州" },
};
const period = { type: "WEEK", start: "2099-10-01", end: "2099-10-08" };
test("separate edits preserve snapshot and independent versions with exact reopen", async () => {
  const rows = new Map(),
    writes = [];
  const execute = async (sql, p) => {
    if (sql.startsWith("SELECT")) return { rows: rows.has(p.scope) ? [rows.get(p.scope)] : [] };
    writes.push({ ...p });
    rows.set(p.scope, {
      report_data: p.report,
      schema_version: 1,
      version: p.next,
      last_request_id: p.request,
    });
    return { affectedRows: 1 };
  };
  const report = {
    schemaVersion: 1,
    facts: { complete: true, value: 0 },
    edits: { summary: { positive: "old" } },
  };
  await orderReportWithEdits(
    { operation: "save", period, expectedVersion: 0, requestId: "snapshot-request-0001", report },
    identity,
    execute,
  );
  const edits = { summary: { positive: "edited" }, references: [{ url: "https://example.com" }] };
  await orderReportWithEdits(
    {
      operation: "save-edits",
      period,
      expectedVersion: 0,
      requestId: "edit-only-request-0001",
      report: { edits },
    },
    identity,
    execute,
  );
  assert.equal(writes.length, 2);
  assert.notEqual(writes[0].scope, writes[1].scope);
  assert.equal(writes[0].scopeRefs, writes[1].scopeRefs);
  assert.equal(writes[1].consumer, "order");
  const loaded = await orderReportWithEdits({ operation: "load", period }, identity, execute);
  assert.deepEqual(loaded.report, { ...report, edits });
  assert.equal(loaded.version, 1);
  assert.equal(loaded.editVersion, 1);
  await assert.rejects(
    orderReportWithEdits(
      {
        operation: "save-edits",
        period,
        expectedVersion: 0,
        requestId: "edit-only-request-0002",
        report: { edits },
      },
      identity,
      execute,
    ),
    /VERSION_CONFLICT/,
  );
});
test("edits before any snapshot are readable without claiming complete facts", async () => {
  const rows = new Map();
  const execute = async (sql, p) => {
    if (sql.startsWith("SELECT")) return { rows: rows.has(p.scope) ? [rows.get(p.scope)] : [] };
    rows.set(p.scope, {
      report_data: p.report,
      schema_version: 1,
      version: p.next,
      last_request_id: p.request,
    });
    return { affectedRows: 1 };
  };
  await orderReportWithEdits(
    {
      operation: "save-edits",
      period,
      expectedVersion: 0,
      requestId: "edit-only-request-0003",
      report: { edits: { summary: { positive: "draft" } } },
    },
    identity,
    execute,
  );
  const loaded = await orderReportWithEdits({ operation: "load", period }, identity, execute);
  assert.equal(loaded.report.facts, null);
  assert.equal(loaded.report.edits.summary.positive, "draft");
  assert.equal(loaded.editVersion, 1);
});

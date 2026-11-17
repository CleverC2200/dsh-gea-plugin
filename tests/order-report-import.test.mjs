import test from "node:test";
import assert from "node:assert/strict";
import { orderReportWithEdits } from "../src/host/order-report-edits.ts";
const identity = {
  tenantId: "0",
  id: "editor",
  reportScope: { key: "order:base:郑州", base: "郑州" },
};
const period = { type: "WEEK", start: "2026-10-19", end: "2026-10-26" };
const batch = {
  schemaVersion: 1,
  batchId: "workbook-20261025",
  period,
  source: { kind: "message", name: "用户复盘" },
  summary: { risk: "原因待核验" },
  unmet: [
    {
      key: "row1",
      base: "郑州",
      source: { sheet: "当前对话", row: 1 },
      dimension: "base",
      entity: "郑州",
      reason: "原因待核验",
      measure: "待制定改善措施",
    },
  ],
};
function database() {
  const rows = new Map();
  let writes = 0;
  return {
    rows,
    get writes() {
      return writes;
    },
    execute: async (sql, p) => {
      if (sql.startsWith("SELECT")) return { rows: rows.has(p.scope) ? [rows.get(p.scope)] : [] };
      writes++;
      rows.set(p.scope, {
        report_data: p.report,
        schema_version: 1,
        version: p.next,
        last_request_id: p.request,
      });
      return { affectedRows: 1 };
    },
  };
}
const invoke = (db, input) => orderReportWithEdits({ period, ...input }, identity, db.execute);
test("preview does not write; commit preserves manual edits and same-request retry is idempotent", async () => {
  const db = database();
  await invoke(db, {
    operation: "save-edits",
    expectedVersion: 0,
    requestId: "manual-request-0001",
    report: { edits: { summary: { positive: "人工结论" } } },
  });
  const p = await invoke(db, { operation: "preview-import", batch });
  assert.equal(db.writes, 1);
  assert.equal(p.canCommit, true);
  assert.equal(p.previewId.length, 43);
  assert.match(p.previewId, /^[A-Za-z0-9_-]+$/);
  const request = {
    operation: "commit-import",
    batch,
    previewId: p.previewId,
    expectedVersion: p.editVersion,
    requestId: "import-request-0001",
  };
  const saved = await invoke(db, request);
  assert.equal(saved.saved, true);
  assert.equal(saved.edits.summary.positive, "人工结论");
  assert.equal(saved.edits.imports.length, 1);
  const retry = await invoke(db, request);
  assert.equal(retry.unchanged, true);
  assert.equal(db.writes, 2);
  const loaded = await invoke(db, { operation: "load" });
  assert.equal(loaded.report.edits.imports.length, 1);
  await invoke(db, {
    operation: "save-edits",
    expectedVersion: 2,
    requestId: "manual-request-0002",
    report: { edits: { summary: { positive: "手改" }, imports: [] } },
  });
  assert.equal((await invoke(db, { operation: "load" })).report.edits.imports.length, 1);
});
test("scope, period, unauthorized fields, stale preview and examples cannot publish", async () => {
  const db = database();
  for (const bad of [
    { ...batch, period: { ...period, start: "2026-10-01" } },
    { ...batch, unmet: [{ ...batch.unmet[0], base: "华东" }] },
    { ...batch, metrics: { value: 2.3 } },
  ])
    await assert.rejects(invoke(db, { operation: "preview-import", batch: bad }), /ORDER_IMPORT/);
  const p = await invoke(db, { operation: "preview-import", batch });
  await assert.rejects(
    invoke(db, {
      operation: "commit-import",
      batch,
      previewId: "stale",
      expectedVersion: 0,
      requestId: "import-request-0002",
    }),
    /PREVIEW_STALE/,
  );
  await assert.rejects(
    invoke(db, {
      operation: "commit-import",
      batch: { ...batch, source: { kind: "example", name: "示例" } },
      previewId: p.previewId,
      expectedVersion: 0,
      requestId: "import-request-0002",
    }),
    /NOT_PUBLISHABLE/,
  );
  assert.equal(db.writes, 0);
});
test("same content deduplicates and changed logical batch retains history", async () => {
  const db = database();
  for (const [index, content] of ["原因待核验", "原因待核验", "已核实的原因"].entries()) {
    const b = { ...batch, summary: { risk: content } };
    const p = await invoke(db, { operation: "preview-import", batch: b });
    const saved = await invoke(db, {
      operation: "commit-import",
      batch: b,
      previewId: p.previewId,
      expectedVersion: p.editVersion,
      requestId: "import-request-000" + index,
    });
    assert.equal(saved.edits.imports.length, index === 2 ? 2 : 1);
  }
  assert.equal(db.writes, 2);
});
test("unconfirmed database write never yields success", async () => {
  const db = database();
  const p = await invoke(db, { operation: "preview-import", batch });
  await assert.rejects(
    orderReportWithEdits(
      {
        operation: "commit-import",
        period,
        batch,
        previewId: p.previewId,
        expectedVersion: 0,
        requestId: "import-request-failed",
      },
      identity,
      async (sql, params) =>
        sql.startsWith("SELECT") ? db.execute(sql, params) : { affectedRows: 0 },
    ),
    /ORDER_REPORT/,
  );
});

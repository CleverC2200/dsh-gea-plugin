import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { orderReportStore } from "../src/host/order-report-store.ts";
const period = { type: "WEEK", start: "2099-10-12", end: "2099-10-19" };
const identity = {
  tenantId: "0",
  id: "test-editor",
  reportScope: { key: "order:base:郑州", base: "郑州" },
};
const report = {
  schemaVersion: 1,
  facts: { complete: true, rows: randomBytes(240000).toString("base64") },
  edits: { summary: { positive: "完整报告" } },
};
function database() {
  const rows = new Map(),
    writes = [];
  return {
    rows,
    writes,
    async execute(sql, p) {
      assert.ok(sql.length <= 65536);
      assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 65536);
      if (sql.startsWith("SELECT"))
        return {
          rows: p.partScopes
            ? p.partScopes.flatMap((key) =>
                rows.has(key) ? [rows.get(key)] : [],
              )
            : rows.has(p.scope)
              ? [rows.get(p.scope)]
              : [],
        };
      writes.push(p.scope);
      rows.set(p.scope, {
        scope_key: p.scope,
        report_data: p.report,
        version: p.next ?? 1,
        last_request_id: p.request,
        schema_version: 1,
      });
      return { affectedRows: 1 };
    },
  };
}
test("oversized report verifies immutable parts before committing, then edits and reopens exactly", async () => {
  const db = database();
  const save = {
    operation: "save",
    period,
    report,
    expectedVersion: 0,
    requestId: "large-parts-request-0001",
  };
  await orderReportStore(save, identity, db.execute);
  assert.ok(db.writes.length > 2);
  assert.equal(db.writes.at(-1), identity.reportScope.key);
  const count = db.writes.length;
  await orderReportStore(save, identity, db.execute);
  assert.equal(db.writes.length, count);
  const load = () =>
    orderReportStore({ operation: "load", period }, identity, db.execute);
  assert.deepEqual((await load()).report, report);
  const updated = {
    ...report,
    edits: { summary: { positive: "修改后完整回读" } },
  };
  await orderReportStore(
    {
      ...save,
      report: updated,
      expectedVersion: 1,
      requestId: "large-parts-request-0002",
    },
    identity,
    db.execute,
  );
  assert.deepEqual((await load()).report, updated);
  const part = db.writes.findLast((key) => key.startsWith("order:part:"));
  db.rows.get(part).report_data = "corrupt";
  await assert.rejects(load(), /PARTS_INCOMPLETE/);
});
test("denied or incomplete staging never commits over an existing report", async () => {
  for (const failure of ["denied", "missing"]) {
    const db = database();
    const old = {
      schemaVersion: 1,
      facts: { complete: true },
      edits: { summary: { positive: "原报告" } },
    };
    const save = {
      operation: "save",
      period,
      expectedVersion: 0,
      requestId: "original-report-request-0001",
      report: old,
    };
    await orderReportStore(save, identity, db.execute);
    const execute = async (sql, p) => {
      if (
        failure === "denied" &&
        sql.startsWith("INSERT") &&
        p.scope.startsWith("order:part:")
      )
        throw Error("WRITE_DENIED");
      if (failure === "missing" && p.partScopes) return { rows: [] };
      return db.execute(sql, p);
    };
    await assert.rejects(
      orderReportStore(
        {
          ...save,
          expectedVersion: 1,
          requestId: "large-parts-request-0003",
          report,
        },
        identity,
        execute,
      ),
      /WRITE_DENIED|PARTS_INCOMPLETE/,
    );
    assert.deepEqual(
      (
        await orderReportStore(
          { operation: "load", period },
          identity,
          db.execute,
        )
      ).report,
      old,
    );
  }
});

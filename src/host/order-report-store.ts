import { gunzipSync } from "node:zlib";
import { encodeOrderReport, decodeOrderReport } from "./order-report-codec.ts";
import { isReportParts, readReportParts, writeReportParts } from "./order-report-parts.ts";

const table = "agents_order_workbench_report";
const identityWhere =
  "tenant_id = :tenant AND scope_key = :scope AND consumer_code = :consumer AND period_type = :kind AND period_start = CAST(:start AS DATE) AND period_end_exclusive = CAST(:end AS DATE)";
const fields = "report_data, version, last_request_id, schema_version";
const fail = (code: string) => Object.assign(Error(code), { code });
type Execute = (
  sql: string,
  parameters: Record<string, unknown>,
  requestId?: string,
) => Promise<any>;

/** Fixed report statements only. Tenant, author and Consumer come from the authenticated Host. */
export async function orderReportStore(
  input: any,
  identity: {
    tenantId: string;
    id: string;
    reportScope: { key: string; base: string; bases?: unknown[] };
  },
  execute: Execute,
) {
  if (
    !input ||
    !["load", "save"].includes(input.operation) ||
    Object.keys(input).some(
      (key) => !["operation", "period", "expectedVersion", "requestId", "report"].includes(key),
    )
  )
    throw fail("ORDER_REPORT_REQUEST_INVALID");
  if (input.operation === "save" && input.report?.encoding === "gzip-base64") {
    if (
      typeof input.report.data !== "string" ||
      input.report.data.length > 4_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.report.data)
    )
      throw fail("ORDER_REPORT_FORMAT_INVALID");
    try {
      input = {
        ...input,
        report: JSON.parse(
          gunzipSync(Buffer.from(input.report.data, "base64"), {
            maxOutputLength: 20_000_000,
          }).toString("utf8"),
        ),
      };
    } catch {
      throw fail("ORDER_REPORT_FORMAT_INVALID");
    }
  }
  const period = input.period;
  if (
    !period ||
    !["WEEK", "MONTH"].includes(period.type) ||
    ![period.start, period.end].every(
      (value: unknown) =>
        typeof value === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString().slice(0, 10) === value,
    ) ||
    period.start >= period.end ||
    Date.parse(period.end) - Date.parse(period.start) > 31 * 86400000
  )
    throw fail("ORDER_REPORT_PERIOD_INVALID");
  const params: Record<string, unknown> = {
    tenant: Number(identity.tenantId),
    scope: identity.reportScope.key,
    consumer: "order",
    kind: period.type,
    start: period.start,
    end: period.end,
  };
  if (!Number.isSafeInteger(params.tenant) || !identity.id) throw fail("GEA_IDENTITY_INCOMPLETE");
  const readParameters = { ...params };
  const read = async () => {
    const result = await execute(
      `SELECT ${fields} FROM ${table} WHERE ${identityWhere} LIMIT 2`,
      readParameters,
    );
    if (!Array.isArray(result.rows) || result.rows.length > 1 || result.rejectedColumns?.length)
      throw fail("ORDER_REPORT_READ_INCOMPLETE");
    const row = result.rows[0];
    if (!row) return null;
    if (
      !["report_data", "version", "last_request_id", "schema_version"].every((key) =>
        Object.hasOwn(row, key),
      ) ||
      Number(row.schema_version) !== 1 ||
      !Number.isSafeInteger(Number(row.version))
    )
      throw fail("ORDER_REPORT_FORMAT_INVALID");
    return row;
  };
  const decode = async (row: any) => {
    if (!row) return { version: 0, report: null };
    const envelope = JSON.parse(row.report_data);
    if (isReportParts(envelope) && envelope.requestId !== row.last_request_id)
      throw fail("ORDER_REPORT_FORMAT_INVALID");
    const encoded = isReportParts(envelope)
      ? await readReportParts(envelope, readParameters as any, execute)
      : row.report_data;
    const report = decodeOrderReport(encoded);
    if (report.schemaVersion !== 1 || !report.facts || !report.edits)
      throw fail("ORDER_REPORT_FORMAT_INVALID");
    return {
      version: Number(row.version),
      requestId: row.last_request_id,
      report,
    };
  };
  const existing = await read();
  if (input.operation === "load")
    return { ...(await decode(existing)), scope: identity.reportScope };
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    typeof input.requestId !== "string" ||
    !/^[a-zA-Z0-9-]{16,64}$/.test(input.requestId) ||
    input.report?.schemaVersion !== 1 ||
    input.report?.facts?.complete !== true ||
    !input.report?.edits
  )
    throw fail("ORDER_REPORT_SAVE_INVALID");
  const reportJson = JSON.stringify(input.report);
  if (Buffer.byteLength(reportJson) > 20_000_000) throw fail("ORDER_REPORT_TOO_LARGE");
  if (existing?.last_request_id === input.requestId) {
    if (JSON.stringify((await decode(existing)).report) !== reportJson)
      throw fail("ORDER_REPORT_REQUEST_REUSED");
    return {
      version: Number(existing.version),
      requestId: input.requestId,
      saved: true,
    };
  }
  if (Number(existing?.version ?? 0) !== input.expectedVersion)
    throw fail("ORDER_REPORT_VERSION_CONFLICT");
  Object.assign(params, {
    scopeName: identity.reportScope.base || "授权基地汇总",
    scopeRefs: JSON.stringify({
      base: identity.reportScope.base,
      ...(identity.reportScope.bases ? { bases: identity.reportScope.bases } : {}),
    }),
    next: input.expectedVersion + 1,
    expected: input.expectedVersion,
    request: input.requestId,
    actor: identity.id,
    now: new Date().toISOString().slice(0, 19).replace("T", " "),
  });
  let sql = existing
    ? `UPDATE ${table} SET report_data = :report, version = :next, last_request_id = :request, update_by = :actor, update_time = :now WHERE ${identityWhere} AND version = :expected`
    : `INSERT INTO ${table} (tenant_id, scope_key, period_type, period_start, period_end_exclusive, scope_name, scope_refs, consumer_code, report_data, schema_version, calculation_version, version, last_request_id, create_by, create_time, update_by, update_time) VALUES (:tenant, :scope, :kind, :start, :end, :scopeName, :scopeRefs, :consumer, :report, 1, 'order-report-v1', :next, :request, :actor, :now, :actor, :now)`;
  const available = 65_536 - Buffer.byteLength(JSON.stringify({ ...params, report: "" })) - 16;
  if (available <= 0) throw fail("ORDER_REPORT_PARAMETERS_TOO_LARGE");
  // Stop recompressing once the existing atomic SQL/parameter split can hold the full envelope.
  const targetBytes = available + Math.max(0, 65_536 - sql.length - 32);
  const encodedReport = await encodeOrderReport(reportJson, targetBytes);
  const storedReport =
    Buffer.byteLength(encodedReport) > targetBytes
      ? await writeReportParts(
          encodedReport,
          readParameters as any,
          {
            actor: identity.id,
            scopeName: String(params.scopeName),
            scopeRefs: String(params.scopeRefs),
          },
          input.requestId,
          execute,
        )
      : encodedReport;
  params.report = storedReport;
  if (Buffer.byteLength(JSON.stringify(params)) > 65_536) {
    const prefix = String(storedReport).slice(0, -available);
    // Only our ASCII compression envelope may enter a SQL literal, never report text.
    if (!prefix || /[^A-Za-z0-9+/=,:{}"-]/.test(prefix)) throw fail("ORDER_REPORT_FORMAT_INVALID");
    sql = sql.replace(":report", `CONCAT('${prefix}', :report)`);
    params.report = String(storedReport).slice(-available);
  }
  if (sql.length > 65_536 || Buffer.byteLength(JSON.stringify(params)) > 65_536)
    throw fail("ORDER_REPORT_PARAMETERS_TOO_LARGE");
  await execute(sql, params, input.requestId);
  const saved = await read();
  if (
    saved?.last_request_id !== input.requestId ||
    Number(saved.version) !== params.next ||
    saved.report_data !== storedReport
  )
    throw fail("ORDER_REPORT_SAVE_NOT_CONFIRMED");
  return {
    version: Number(saved.version),
    requestId: input.requestId,
    saved: true,
  };
}

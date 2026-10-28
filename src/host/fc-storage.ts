import { createHash } from "node:crypto";
import { legacyPlanningStorage } from "./fc-legacy-planning.ts";

export type FcStorageConfig = {
  dataSourceCode: string;
  published: boolean;
  planningLayout?: "legacy";
  warehouseIds?: Record<string, string>;
  users: Array<{ tenantId: string; userId: string; warehouses: string[] }>;
};
export type FcStorageEnvironments = Partial<Record<"test" | "production", FcStorageConfig>>;
type Kind = "plans" | "cycles" | "submission";
type Scope = { tenantId: string; userId: string; warehouses: string[] };
type Execute = (request: Record<string, unknown>) => Promise<any>;
const tables = {
  plans: "agent_branch_plan_version",
  cycles: "agent_branch_cycle_version",
  submission: "agent_branch_submission_event",
};
const plain = (x: any) => x && typeof x === "object" && !Array.isArray(x);
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(message);
}
function fields(value: any, allowed: string[]) {
  check(
    plain(value) && Object.keys(value).every((k) => allowed.includes(k)),
    "FC_STORAGE_INVALID_FIELDS",
  );
}
function scalarText(x: any, max = 128) {
  return typeof x === "string" && x.length > 0 && x.length <= max;
}
function qty(x: any) {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e9;
}
function date(x: any) {
  return (
    typeof x === "string" &&
    /^20\d\d-\d\d-\d\d$/.test(x) &&
    Number.isFinite(Date.parse(x + "T00:00:00Z")) &&
    new Date(x + "T00:00:00Z").toISOString().slice(0, 10) === x
  );
}
function validate(kind: Kind, value: any, warehouse: string) {
  if (kind === "plans") {
    fields(value, ["plans"]);
    check(
      Array.isArray(value.plans) && value.plans.length > 0 && value.plans.length <= 5000,
      "FC_PLANS_REQUIRED",
    );
    const keys = new Set();
    for (const row of value.plans) {
      fields(row, [
        "warehouseName",
        "warehouseCode",
        "sku",
        "productName",
        "month",
        "category",
        "materialGroup",
        "outboundQty",
        "transferQty",
        "suggestedOutboundQty",
        "suggestedTransferQty",
      ]);
      check(
        row.warehouseCode === warehouse &&
          scalarText(row.warehouseName, 100) &&
          scalarText(row.sku, 64) &&
          scalarText(row.productName, 200) &&
          /^20\d\d-(0[1-9]|1[0-2])$/.test(row.month) &&
          qty(row.outboundQty) &&
          qty(row.transferQty),
        "FC_PLAN_INVALID",
      );
      check(
        [row.category, row.materialGroup].every(
          (x) => x === undefined || (typeof x === "string" && x.length <= 100),
        ),
        "FC_PLAN_DIMENSION_INVALID",
      );
      check(
        [row.suggestedOutboundQty, row.suggestedTransferQty].every((x) => x == null || qty(x)),
        "FC_PLAN_SUGGESTION_INVALID",
      );
      const key = JSON.stringify([row.month, row.sku]);
      check(!keys.has(key), "FC_PLAN_DUPLICATE");
      keys.add(key);
    }
  } else if (kind === "cycles") {
    fields(value, ["days", "rules"]);
    check(
      Number.isInteger(value.days) &&
        value.days >= 1 &&
        value.days <= 365 &&
        Array.isArray(value.rules) &&
        value.rules.length <= 12,
      "FC_CYCLE_INVALID",
    );
    const keys = new Set();
    for (const r of value.rules) {
      fields(r, ["level", "object", "days", "from", "to", "status"]);
      check(
        ["sku", "material-group", "category", "warehouse"].includes(r.level) &&
          scalarText(r.object, 100) &&
          r.object === r.object.trim() &&
          Number.isInteger(r.days) &&
          r.days >= 1 &&
          r.days <= 365,
        "FC_CYCLE_INVALID",
      );
      check(r.level !== "warehouse" || r.object === warehouse, "FC_CYCLE_WAREHOUSE_MISMATCH");
      check(
        [r.from, r.to].every((x) => x === "" || date(x)) &&
          (!r.from || !r.to || r.from <= r.to) &&
          [undefined, "effective", "paused"].includes(r.status),
        "FC_CYCLE_DATE_INVALID",
      );
      const key = JSON.stringify([r.level, r.object]);
      check(!keys.has(key), "FC_CYCLE_DUPLICATE");
      keys.add(key);
    }
  } else {
    fields(value, [
      "stage",
      "snapshotVersion",
      "month",
      "planRevision",
      "cycleRevision",
      "consumptionReviewed",
      "calculationContext",
      "rows",
      "aiPreOrderCode",
      "receipt",
      "errorCode",
    ]);
    check(
      ["confirmed", "dms-received", "dms-unknown"].includes(value.stage) &&
        scalarText(value.snapshotVersion, 160) &&
        /^20\d\d-(0[1-9]|1[0-2])$/.test(value.month) &&
        typeof value.consumptionReviewed === "boolean" &&
        Array.isArray(value.rows) &&
        value.rows.length > 0,
      "FC_SUBMISSION_INVALID",
    );
    check(
      [value.planRevision, value.cycleRevision].every(
        (x) => typeof x === "string" && /^(\d{1,9}|legacy:[a-f0-9]{64})$/.test(x),
      ),
      "FC_SUBMISSION_REVISION_INVALID",
    );
    if (value.calculationContext !== undefined) {
      const c = value.calculationContext;
      fields(c, [
        "asOf",
        "warehouseCode",
        "stockDates",
        "planSource",
        "cycleSource",
        "plans",
        "cycle",
        "evidence",
      ]);
      check(
        date(c.asOf) &&
          c.warehouseCode === warehouse &&
          Array.isArray(c.stockDates) &&
          c.stockDates.every(date),
        "FC_SNAPSHOT_SCOPE_INVALID",
      );
      check(
        ["BI", "human-saved"].includes(c.planSource) &&
          ["default", "saved"].includes(c.cycleSource),
        "FC_UNSAVED_CONFIGURATION",
      );
      check(
        (c.planSource === "human-saved") === (value.planRevision !== "0") &&
          (c.cycleSource === "saved") === (value.cycleRevision !== "0"),
        "FC_PROVENANCE_REVISION_INVALID",
      );
      if (c.planSource === "human-saved") validate("plans", { plans: c.plans }, warehouse);
      else check(Array.isArray(c.plans) && c.plans.length === 0, "FC_PROVENANCE_PLAN_INVALID");
      validate("cycles", c.cycle, warehouse);
      check(
        Array.isArray(c.evidence) && c.evidence.length === value.rows.length,
        "FC_SNAPSHOT_ROWS_INVALID",
      );
      const evidenceSkus = new Set();
      for (const r of c.evidence) {
        fields(r, [
          "sku",
          "stock_date",
          "stat_month",
          "inventory_qty",
          "available_qty",
          "calculation_order_remaining",
          "open_transfer_reported_qty",
          "period_current_out",
          "period_next_out",
          "cycle_days",
          "recommended_qty",
        ]);
        check(
          scalarText(r.sku, 64) &&
            !evidenceSkus.has(r.sku) &&
            value.rows.some(
              (row: any) => row.sku === r.sku && row.recommendedQty === r.recommended_qty,
            ),
          "FC_SNAPSHOT_ROWS_INVALID",
        );
        evidenceSkus.add(r.sku);
      }
      check(
        value.snapshotVersion ===
          "sha256:" + createHash("sha256").update(canonical(c)).digest("hex"),
        "FC_SNAPSHOT_HASH_MISMATCH",
      );
    }
    check(scalarText(value.aiPreOrderCode, 64), "FC_SUBMISSION_KEY_REQUIRED");
    const keys = new Set();
    for (const r of value.rows) {
      fields(r, ["sku", "productName", "recommendedQty", "actualQty", "reason"]);
      check(
        scalarText(r.sku, 64) &&
          typeof r.productName === "string" &&
          r.productName.length <= 200 &&
          qty(r.recommendedQty) &&
          qty(r.actualQty) &&
          typeof r.reason === "string" &&
          r.reason.length <= 500 &&
          (r.actualQty >= r.recommendedQty || r.reason.trim()),
        "FC_SUBMISSION_ROW_INVALID",
      );
      check(!keys.has(r.sku), "FC_SUBMISSION_DUPLICATE");
      keys.add(r.sku);
    }
    if (value.stage === "dms-received") {
      fields(value.receipt, ["orderCode", "aiPreOrderCode", "requestAiPreOrderCode"]);
      check(
        scalarText(value.receipt.orderCode) &&
          scalarText(value.receipt.aiPreOrderCode, 64) &&
          (value.receipt.requestAiPreOrderCode === undefined
            ? value.receipt.aiPreOrderCode === value.aiPreOrderCode
            : value.receipt.requestAiPreOrderCode === value.aiPreOrderCode),
        "FC_DMS_RECEIPT_INVALID",
      );
    } else check(value.receipt === undefined, "FC_DMS_RECEIPT_UNEXPECTED");
    check(
      value.errorCode === undefined || scalarText(value.errorCode, 80),
      "FC_SUBMISSION_ERROR_INVALID",
    );
  }
}
function canonical(value: any): string {
  return JSON.stringify(value, (_key, v) =>
    plain(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
/** Fixed statements only. Published tenant tables and a trusted warehouse binding are required. */
export async function fcStorage(
  config: FcStorageConfig,
  scope: Scope,
  input: any,
  execute: Execute,
) {
  fields(input, ["operation", "kind", "warehouseCode", "entityId", "baseRevision", "value"]);
  check(
    config.published === true && /^[A-Za-z0-9_-]{1,100}$/.test(config.dataSourceCode),
    "FC_STORAGE_NOT_CONFIGURED",
  );
  const kind = input.kind as Kind;
  check(Object.hasOwn(tables, kind), "FC_STORAGE_KIND_INVALID");
  const warehouse = input.warehouseCode;
  check(
    scalarText(warehouse, 64) && scope.warehouses.includes(warehouse),
    "FC_STORAGE_WAREHOUSE_DENIED",
  );
  const entity = kind === "submission" ? input.entityId : kind;
  check(scalarText(entity, 128), "FC_STORAGE_ENTITY_REQUIRED");
  check(kind === "submission" || input.entityId === undefined, "FC_STORAGE_ENTITY_INVALID");
  if (config.planningLayout === "legacy" && kind !== "submission")
    return legacyPlanningStorage(
      config.dataSourceCode,
      scope,
      config.warehouseIds?.[warehouse] ?? "",
      input,
      execute,
      validate,
    );
  const table =
    config.planningLayout === "legacy"
      ? "data_service.agent_branch_submission_event"
      : tables[kind];
  const parameters = { tenant: scope.tenantId, warehouse, entity };
  const where = "tenant_key = :tenant AND warehouse_code = :warehouse AND entity_key = :entity";
  const load = async (expectedRevision?: string) => {
    const reply = await execute({
      dataSourceCode: config.dataSourceCode,
      sql: `SELECT revision AS revision, payload_text AS payload_text, idempotency_key AS idempotency_key FROM ${table} WHERE ${where}${expectedRevision ? " AND revision = :expectedRevision" : ""} ORDER BY revision DESC`,
      parameters: expectedRevision
        ? { ...parameters, expectedRevision: Number(expectedRevision) }
        : parameters,
      pageNo: 1,
      pageSize: 1,
      includeTotal: false,
    });
    check(
      reply?.success === true && reply.code === 200 && Array.isArray(reply.result?.records),
      "FC_STORAGE_READ_FAILED",
    );
    const rows = reply.result.records;
    check(rows.length <= 1, "FC_STORAGE_READ_INVALID");
    if (!rows.length) return { revision: "0", value: null };
    const revision = String(rows[0].revision);
    check(
      /^[1-9]\d{0,8}$/.test(revision) && typeof rows[0].payload_text === "string",
      "FC_STORAGE_READ_INVALID",
    );
    const value = JSON.parse(rows[0].payload_text);
    validate(kind, value, warehouse);
    check(
      kind !== "submission" || value.aiPreOrderCode === entity,
      "FC_SUBMISSION_ENTITY_MISMATCH",
    );
    return { revision, value, idempotencyKey: rows[0].idempotency_key };
  };
  if (input.operation === "load") {
    check(input.value === undefined && input.baseRevision === undefined, "FC_STORAGE_READ_INVALID");
    return { status: "loaded", ...(await load()) };
  }
  check(
    ["save", "verify"].includes(input.operation) &&
      typeof input.baseRevision === "string" &&
      /^(0|[1-9]\d{0,7})$/.test(input.baseRevision),
    "FC_STORAGE_REVISION_INVALID",
  );
  validate(kind, input.value, warehouse);
  check(
    kind !== "submission" || input.value.aiPreOrderCode === entity,
    "FC_SUBMISSION_ENTITY_MISMATCH",
  );
  const payload = canonical(input.value);
  check(Buffer.byteLength(payload, "utf8") <= 48000, "FC_STORAGE_BATCH_TOO_LARGE");
  const revision = String(Number(input.baseRevision) + 1);
  const body = {
    ...parameters,
    revision: Number(revision),
    payload,
    author: scope.userId,
  };
  const key =
    "fc:" +
    createHash("sha256")
      .update(canonical([config.dataSourceCode, kind, body]))
      .digest("hex");
  const request = {
    dataSourceCode: config.dataSourceCode,
    sql: `INSERT INTO ${table} (tenant_key, warehouse_code, entity_key, revision, payload_text, idempotency_key, created_by, created_at) VALUES (:tenant, :warehouse, :entity, :revision, :payload, :key, :author, CURRENT_TIMESTAMP)`,
    parameters: { ...body, key },
    idempotencyKey: key,
  };
  if (input.operation === "verify") {
    const read = await load(revision);
    return read.revision === revision &&
      read.idempotencyKey === key &&
      canonical(read.value) === payload
      ? { status: "saved", ...read }
      : { status: "unresolved", revision, idempotencyKey: key };
  }
  let result;
  try {
    result = await execute(request);
  } catch {
    return { status: "unknown", idempotencyKey: key, revision };
  }
  if (result?.success !== true || result.code !== 200)
    return {
      status: result?.errorCode === "SQL_WRITE_RESULT_UNKNOWN" ? "unknown" : "failed",
      idempotencyKey: key,
      revision,
      traceId: typeof result?.traceId === "string" ? result.traceId : undefined,
      code: result?.code,
    };
  if (result.result?.affectedRows !== 1)
    return { status: "unknown", idempotencyKey: key, revision };
  // Once acknowledged, a failed refresh must never repeat the write.
  try {
    const read = await load(revision);
    if (read.revision === revision && canonical(read.value) === payload)
      return { status: "saved", idempotencyKey: key, ...read };
  } catch {
    /* The write is acknowledged; caller may retry reads only. */
  }
  return { status: "saved-unverified", idempotencyKey: key, revision };
}

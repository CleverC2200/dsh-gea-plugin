import { createHash } from "node:crypto";

type Execute = (body: Record<string, unknown>) => Promise<any>;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const fingerprint = (value: unknown) =>
  "legacy:" + createHash("sha256").update(canonical(value)).digest("hex");
const requireOk = (ok: unknown, code: string) => {
  if (!ok) throw Error(code);
};
const defaultRuleId = "fc-default-cycle-days-v1";
function plan(row: any) {
  return {
    warehouseName: row.warehouseName,
    warehouseCode: row.warehouseCode,
    sku: row.sku,
    productName: row.productName,
    month: row.month,
    category: row.category ?? "",
    materialGroup: row.materialGroup ?? "",
    outboundQty: Number(row.outboundQty),
    transferQty: Number(row.transferQty),
    suggestedOutboundQty:
      row.suggestedOutboundQty == null ? null : Number(row.suggestedOutboundQty),
    suggestedTransferQty:
      row.suggestedTransferQty == null ? null : Number(row.suggestedTransferQty),
  };
}
function normalized(kind: string, value: any) {
  return kind === "plans"
    ? {
        plans: value.plans
          .map(plan)
          .sort((a: any, b: any) => (a.month + ":" + a.sku).localeCompare(b.month + ":" + b.sku)),
      }
    : {
        days: value.days,
        rules: value.rules.map((r: any) => ({
          ...r,
          status: r.status ?? "effective",
        })),
      };
}

/** Original tables use whole-statement UPSERT and content revisions, not append-only numeric revisions. */
export async function legacyPlanningStorage(
  dataSourceCode: string,
  scope: { userId: string; tenantId: string },
  warehouseId: string,
  input: any,
  execute: Execute,
  validate: (kind: any, value: any, warehouse: string) => void,
) {
  const { kind, warehouseCode: warehouse } = input;
  requireOk(
    typeof warehouseId === "string" && warehouseId.length > 0 && warehouseId.length <= 64,
    "FC_STORAGE_WAREHOUSE_ID_REQUIRED",
  );
  const query = async (sql: string, parameters: Record<string, unknown>, pageNo = 1) => {
    const result = await execute({
      dataSourceCode,
      sql,
      parameters,
      pageNo,
      pageSize: 200,
      includeTotal: false,
    });
    requireOk(
      result?.success === true && result.code === 200 && Array.isArray(result.result?.records),
      "FC_STORAGE_READ_FAILED",
    );
    requireOk(typeof result.result.hasMore === "boolean", "FC_STORAGE_READ_INCOMPLETE");
    return result.result;
  };
  const load = async () => {
    if (kind === "plans") {
      const collected: any[] = [];
      for (let page = 1; page <= 25; page++) {
        const result = await query(
          "SELECT warehouse_name AS warehouse_name, warehouse_code AS warehouse_code, sku AS sku, product_name AS product_name, CAST(target_month AS TEXT) AS month, category AS category, material_group AS material_group, outbound_qty AS outbound_qty, transfer_qty AS transfer_qty, suggested_outbound_qty AS suggested_outbound_qty, suggested_transfer_qty AS suggested_transfer_qty FROM data_service.agent_branch_plan_import WHERE warehouse_id=:warehouseId ORDER BY target_month,sku",
          { warehouseId },
          page,
        );
        collected.push(...result.records);
        if (result.hasMore) {
          requireOk(result.records.length > 0 && page < 25, "FC_STORAGE_READ_INCOMPLETE");
          continue;
        }
        if (!collected.length) return { revision: "0", value: null };
        const value = normalized(kind, {
          plans: collected.map((r) =>
            plan({
              warehouseName: r.warehouse_name,
              warehouseCode: r.warehouse_code,
              sku: r.sku,
              productName: r.product_name,
              month: String(r.month).slice(0, 7),
              category: r.category,
              materialGroup: r.material_group,
              outboundQty: r.outbound_qty,
              transferQty: r.transfer_qty,
              suggestedOutboundQty: r.suggested_outbound_qty,
              suggestedTransferQty: r.suggested_transfer_qty,
            }),
          ),
        });
        validate(kind, value, warehouse);
        return { revision: fingerprint(value), value };
      }
      throw Error("FC_STORAGE_READ_INCOMPLETE");
    }
    const result = await query(
      "SELECT CAST(rules AS TEXT) AS rules FROM data_service.agent_branch_cycle_config WHERE warehouse_id=:warehouseId",
      { warehouseId },
    );
    requireOk(!result.hasMore && result.records.length <= 1, "FC_STORAGE_READ_INCOMPLETE");
    if (!result.records.length) return { revision: "0", value: null };
    const stored = JSON.parse(result.records[0].rules);
    requireOk(Array.isArray(stored), "FC_CYCLE_INVALID");
    const defaults = stored.filter((r: any) => r.id === defaultRuleId);
    requireOk(
      defaults.length <= 1 &&
        defaults.every(
          (r: any) =>
            r.level === "warehouse" &&
            r.objectId === warehouseId &&
            r.status === "effective" &&
            !r.effectiveFrom &&
            !r.effectiveTo,
        ),
      "FC_CYCLE_INVALID",
    );
    const value = normalized(kind, {
      days: defaults[0]?.cycleDays ?? 7,
      rules: stored
        .filter((r: any) => r.id !== defaultRuleId)
        .map((r: any) => ({
          level: r.level,
          object: r.level === "warehouse" && r.objectId === warehouseId ? warehouse : r.objectId,
          days: r.cycleDays,
          status: r.status,
          from: r.effectiveFrom ?? "",
          to: r.effectiveTo ?? "",
        })),
    });
    validate(kind, value, warehouse);
    return { revision: fingerprint(value), value };
  };
  if (input.operation === "load") {
    requireOk(
      input.value === undefined && input.baseRevision === undefined,
      "FC_STORAGE_READ_INVALID",
    );
    return { status: "loaded", ...(await load()) };
  }
  requireOk(
    ["save", "verify"].includes(input.operation) &&
      /^(0|legacy:[a-f0-9]{64})$/.test(input.baseRevision),
    "FC_STORAGE_REVISION_INVALID",
  );
  validate(kind, input.value, warehouse);
  const expected = normalized(kind, input.value);
  const revision = fingerprint(expected);
  const key =
    "fc-legacy:" +
    createHash("sha256")
      .update(
        canonical([
          dataSourceCode,
          scope.tenantId,
          scope.userId,
          warehouseId,
          kind,
          input.baseRevision,
          expected,
        ]),
      )
      .digest("hex");
  const current = await load();
  if (input.operation === "verify")
    return current.revision === revision
      ? { status: "saved", ...current, idempotencyKey: key }
      : { status: "unresolved", revision, idempotencyKey: key };
  requireOk(current.revision === input.baseRevision, "FC_STORAGE_REVISION_CONFLICT");
  if (current.revision === revision) return { status: "saved", ...current, idempotencyKey: key };
  let sql: string;
  let expectedAffected = 1;
  const parameters: Record<string, unknown> = {
    warehouseId,
    author: scope.userId,
  };
  if (kind === "plans") {
    // The page saves the full loaded set. Reject omissions instead of silently deleting old SKUs.
    const wanted = new Set(expected.plans!.map((p: any) => p.month + ":" + p.sku));
    requireOk(
      (current.value?.plans ?? []).every((p: any) => wanted.has(p.month + ":" + p.sku)),
      "FC_PLAN_PARTIAL_SNAPSHOT",
    );
    const previous = new Map(
      (current.value?.plans ?? []).map((p: any) => [p.month + ":" + p.sku, canonical(p)]),
    );
    const changed = expected.plans!.filter(
      (p: any) => previous.get(p.month + ":" + p.sku) !== canonical(p),
    );
    expectedAffected = changed.length;
    const values = changed.map((p: any, i: number) => {
      const fields: Record<string, unknown> = {
        name: p.warehouseName,
        code: p.warehouseCode,
        sku: p.sku,
        product: p.productName,
        month: p.month + "-01",
        category: p.category || null,
        material: p.materialGroup || null,
        outbound: p.outboundQty,
        transfer: p.transferQty,
        suggestedOut: p.suggestedOutboundQty,
        suggestedTransfer: p.suggestedTransferQty,
      };
      for (const [name, value] of Object.entries(fields)) parameters[name + i] = value;
      return `(:warehouseId,:name${i},:code${i},:sku${i},:product${i},CAST(:month${i} AS DATE),:category${i},:material${i},:outbound${i},:transfer${i},:suggestedOut${i},:suggestedTransfer${i},:author,CURRENT_TIMESTAMP)`;
    });
    sql =
      "INSERT INTO data_service.agent_branch_plan_import (warehouse_id,warehouse_name,warehouse_code,sku,product_name,target_month,category,material_group,outbound_qty,transfer_qty,suggested_outbound_qty,suggested_transfer_qty,imported_by,updated_time) VALUES " +
      values.join(",") +
      " ON CONFLICT (warehouse_id,target_month,sku) DO UPDATE SET warehouse_name=EXCLUDED.warehouse_name,warehouse_code=EXCLUDED.warehouse_code,product_name=EXCLUDED.product_name,category=EXCLUDED.category,material_group=EXCLUDED.material_group,outbound_qty=EXCLUDED.outbound_qty,transfer_qty=EXCLUDED.transfer_qty,suggested_outbound_qty=EXCLUDED.suggested_outbound_qty,suggested_transfer_qty=EXCLUDED.suggested_transfer_qty,imported_by=EXCLUDED.imported_by,updated_time=EXCLUDED.updated_time";
  } else {
    const rules = expected.rules!.map((r: any, i: number) => ({
      id: `fc-rule-${i}`,
      level: r.level,
      objectId: r.level === "warehouse" ? warehouseId : r.object,
      cycleDays: r.days,
      status: r.status,
      ...(r.from ? { effectiveFrom: r.from } : {}),
      ...(r.to ? { effectiveTo: r.to } : {}),
    }));
    // Last warehouse rule provides the saved fallback without taking precedence over explicit rules.
    if (expected.days !== 7)
      rules.push({
        id: defaultRuleId,
        level: "warehouse",
        objectId: warehouseId,
        cycleDays: expected.days,
        status: "effective",
      });
    parameters.rules = JSON.stringify(rules);
    sql =
      "INSERT INTO data_service.agent_branch_cycle_config (warehouse_id,rules,updated_by,updated_time) VALUES (:warehouseId,CAST(:rules AS JSONB),:author,CURRENT_TIMESTAMP) ON CONFLICT (warehouse_id) DO UPDATE SET rules=EXCLUDED.rules,updated_by=EXCLUDED.updated_by,updated_time=EXCLUDED.updated_time";
  }
  requireOk(
    Object.keys(parameters).length <= 200 &&
      Buffer.byteLength(JSON.stringify(parameters)) <= 65536 &&
      sql.length <= 65536 &&
      expectedAffected <= 100,
    "FC_STORAGE_ATOMIC_BATCH_LIMIT",
  );
  let reply;
  try {
    reply = await execute({
      dataSourceCode,
      sql,
      parameters,
      idempotencyKey: key,
    });
  } catch {
    return { status: "unknown", revision, idempotencyKey: key };
  }
  if (reply?.success !== true || reply.code !== 200)
    return {
      status: reply?.errorCode === "SQL_WRITE_RESULT_UNKNOWN" ? "unknown" : "failed",
      revision,
      idempotencyKey: key,
      code: reply?.code,
      traceId: reply?.traceId,
    };
  if (reply.result?.affectedRows !== expectedAffected)
    return { status: "unknown", revision, idempotencyKey: key };
  try {
    const saved = await load();
    if (saved.revision === revision) return { status: "saved", ...saved, idempotencyKey: key };
  } catch {
    /* Keep the original intent for read-only reconciliation. */
  }
  return { status: "saved-unverified", revision, idempotencyKey: key };
}

import { Decimal } from "decimal.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const numeric = (value: unknown) =>
  (typeof value === "number" || typeof value === "string") &&
  String(value).trim() !== "" &&
  Number.isFinite(Number(value));

/** A ranking page and its totals must come from one complete authorized query scope. */
export function currentShortageRankingResult(input: unknown, page: number) {
  const result = record(input);
  if (!result) throw Error("CURRENT_SHORTAGE_RESULT_INVALID");
  if (result.success === false) return result;
  const columns = result.returnedColumns;
  const required = [
    "snapshot_date",
    "location_type",
    "sku",
    "material_name",
    "demand",
    "allocated",
    "remaining",
    "available",
    "shortage",
    "invalid",
    "scope_invalid",
    "scope_shortage",
    "snapshot_count",
    "page_scope_total",
    "page_row_present",
  ];
  if (
    !Array.isArray(columns) ||
    required.some((key) => !columns.includes(key)) ||
    (Array.isArray(result.rejectedColumns) && result.rejectedColumns.length > 0) ||
    !Array.isArray(result.rows) ||
    !result.rows.length
  )
    throw Error("CURRENT_SHORTAGE_INCOMPLETE");
  const rows = result.rows.map(record);
  const scope = rows[0];
  if (
    !scope ||
    !scope.snapshot_date ||
    scope.location_type !== "基地" ||
    Number(scope.snapshot_count) !== 1 ||
    !numeric(scope.scope_invalid) ||
    Number(scope.scope_invalid) !== 0 ||
    !numeric(scope.scope_shortage) ||
    Number(scope.scope_shortage) < 0 ||
    !numeric(scope.page_scope_total) ||
    !Number.isSafeInteger(Number(scope.page_scope_total)) ||
    Number(scope.page_scope_total) < 0 ||
    rows.some(
      (row) =>
        !row ||
        [
          "snapshot_date",
          "location_type",
          "scope_invalid",
          "scope_shortage",
          "snapshot_count",
          "page_scope_total",
        ].some((key) => String(row[key]) !== String(scope[key])),
    )
  )
    throw Error("CURRENT_SHORTAGE_INCOMPLETE");
  const total = Number(scope.page_scope_total);
  const present = rows.filter(
    (row): row is Record<string, unknown> => !!row && row.page_row_present != null,
  );
  if (
    present.length !== Math.min(10, Math.max(0, total - (page - 1) * 10)) ||
    new Set(present.map((row) => row.sku)).size !== present.length ||
    present.some(
      (row) =>
        typeof row.sku !== "string" ||
        !row.sku.trim() ||
        !numeric(row.invalid) ||
        Number(row.invalid) !== 0 ||
        ["demand", "allocated", "remaining", "available", "shortage"].some(
          (key) => !numeric(row[key]),
        ) ||
        Number(row.shortage) <= 0,
    ) ||
    present.some(
      (row, index) => index > 0 && Number(row.shortage) > Number(present[index - 1].shortage),
    )
  )
    throw Error("CURRENT_SHORTAGE_PAGE_INCOMPLETE");
  const pageQuantity = present.reduce((sum, row) => sum.plus(String(row.shortage)), new Decimal(0));
  const scopeQuantity = new Decimal(String(scope.scope_shortage));
  if (pageQuantity.gt(scopeQuantity)) throw Error("CURRENT_SHORTAGE_INCOMPLETE");
  return {
    ...result,
    rows: present.map((row, index) => ({ ...row, rank: (page - 1) * 10 + index + 1 })),
    total,
    shortageSkuCount: total,
    totalShortage: scopeQuantity.toString(),
    pageShortage: pageQuantity.toString(),
    pageSharePercent: scopeQuantity.gt(0)
      ? pageQuantity.div(scopeQuantity).times(100).toFixed(2)
      : null,
    coverage: "cross-base-sku-ranking-page",
    dataStatus: total ? "ok" : "empty",
    unit: "箱",
    temporalScope: "current-state",
    page,
    pageSize: 10,
    hasMorePages: page * 10 < total,
    orderShortageCount: null,
    note: "同一SKU先跨当前已授权基地汇总净缺口，再按件数降序排名；SKU数只计缺口大于0的不同商品。pageShortage/pageSharePercent仅对应当前页，第1页为前10名。当前净缺口不等于发货日报未满足量，不代表今日新增缺货；不按订单年龄排除有效旧单。",
  };
}

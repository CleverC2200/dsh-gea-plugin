import type { GeaSalesPlanReportFacts } from "@cleverc2200/dsh-agent-workbench/sales-plan";
import { object, text } from "./payload.ts";
import { PLUGIN_QUERY_MAX_PAGE_SIZE } from "./plugin-query.ts";

type ReportSql = {
  sql: string;
  parameters: Record<string, string>;
  pageNo: number;
  pageSize: number;
  includeTotal: true;
};

type ReadSql = (query: ReportSql, signal: AbortSignal) => Promise<unknown>;

const nullableText = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("GEA_INVALID_REPORT_FACTS");
  return value.trim() || null;
};

async function readRows(
  readSql: ReadSql,
  sql: string,
  parameters: Record<string, string>,
  signal: AbortSignal,
) {
  const rows: Record<string, unknown>[] = [];
  let total: number | undefined;
  for (let pageNo = 1; ; pageNo++) {
    signal.throwIfAborted();
    const page = object(
      await readSql(
        { sql, parameters, pageNo, pageSize: PLUGIN_QUERY_MAX_PAGE_SIZE, includeTotal: true },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (
      !Array.isArray(page.rows) ||
      typeof page.total !== "number" ||
      !Number.isSafeInteger(page.total) ||
      page.total < 0 ||
      (total !== undefined && total !== page.total) ||
      page.rows.length !== Math.min(PLUGIN_QUERY_MAX_PAGE_SIZE, page.total - rows.length) ||
      (page.rejectedColumns !== undefined &&
        (!Array.isArray(page.rejectedColumns) || page.rejectedColumns.length > 0))
    )
      throw new Error("GEA_INCOMPLETE_COLLECTION");
    total = page.total;
    rows.push(...page.rows.map(object));
    if (rows.length === total) return rows;
  }
}

export async function readSalesPlanReportFacts(
  query: { planId: string; versionId: string },
  readDetail: (planId: string, signal: AbortSignal) => Promise<unknown>,
  readSql: ReadSql,
  periodMonth: (planId: string) => string | undefined,
  signal: AbortSignal,
): Promise<GeaSalesPlanReportFacts> {
  signal.throwIfAborted();
  const detail = object(await readDetail(query.planId, signal));
  const version = object(detail.currentVersion);
  if (
    version.id !== query.versionId ||
    version.planId !== query.planId ||
    version.effective !== true
  )
    throw new Error("GEA_IDENTITY_MISMATCH");
  const customer = text(version.dealerCode);
  const base = text(version.baseName);
  const month = periodMonth(query.planId);
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("GEA_PLAN_MONTH_SOURCE_MISSING");
  if (!Array.isArray(detail.skus)) throw new Error("GEA_INCOMPLETE_COLLECTION");
  const codes = detail.skus.map((value) => {
    const sku = object(value);
    if (sku.versionId !== query.versionId) throw new Error("GEA_IDENTITY_MISMATCH");
    return text(sku.skuCode);
  });
  if (new Set(codes).size !== codes.length) throw new Error("GEA_INVALID_REPORT_FACTS");
  const [gradingRows, dealerRows] = await Promise.all([
    readRows(
      readSql,
      "SELECT DISTINCT warehouse_group_type FROM agents_sales_target_data_d WHERE cust_code = :customer AND belong_base = :base AND bill_date = :month",
      { customer, base, month: month.replace("-", "") },
      signal,
    ),
    readRows(
      readSql,
      "SELECT DISTINCT cust_type, cust_group_name FROM agents_dim_dealer_data_d WHERE cust_code = :customer",
      { customer },
      signal,
    ),
  ]);
  if (gradingRows.length > 1 || dealerRows.length > 1)
    throw new Error("GEA_AMBIGUOUS_REPORT_FACTS");
  const grading = gradingRows.length ? nullableText(gradingRows[0].warehouse_group_type) : null;
  const customerType = dealerRows.length ? nullableText(dealerRows[0].cust_type) : null;
  const customerGroup = dealerRows.length ? nullableText(dealerRows[0].cust_group_name) : null;
  const rows: GeaSalesPlanReportFacts["rows"] = [];
  const [year, number] = month.split("-").map(Number);
  const next = new Date(Date.UTC(year, number, 1));
  const before = `${next.getUTCFullYear()}${String(next.getUTCMonth() + 1).padStart(2, "0")}01`;
  for (let offset = 0; offset < codes.length; offset += PLUGIN_QUERY_MAX_PAGE_SIZE) {
    const batch = codes.slice(offset, offset + PLUGIN_QUERY_MAX_PAGE_SIZE);
    const parameters = Object.fromEntries(batch.map((code, index) => [`sku${index}`, code]));
    const placeholders = Object.keys(parameters)
      .map((key) => `:${key}`)
      .join(", ");
    const [materials, inventories] = await Promise.all([
      readRows(
        readSql,
        `SELECT DISTINCT material_code, material_group, material_group_name FROM agents_dim_cust_sales_material_detail_d WHERE cust_code = :customer AND material_code IN (${placeholders}) ORDER BY material_code, material_group, material_group_name`,
        { customer, ...parameters },
        signal,
      ),
      readRows(
        readSql,
        `SELECT material_code, inventory_org FROM (
          SELECT material_code, inventory_org,
            ROW_NUMBER() OVER (PARTITION BY material_code ORDER BY COUNT(*) DESC, MAX(act_ship_date) DESC, inventory_org ASC) AS org_rank
          FROM agents_scm_cust_deliv_daily_di
          WHERE cust_code = :customer AND belong_base = :base AND material_code IN (${placeholders})
            AND act_ship_date < :before AND inventory_org IS NOT NULL AND TRIM(inventory_org) <> ''
          GROUP BY material_code, inventory_org
        ) ranked WHERE org_rank = 1 ORDER BY material_code`,
        { customer, base, before, ...parameters },
        signal,
      ),
    ]);
    const materialByCode = new Map<string, { code: string | null; name: string | null }>();
    const inventoryByCode = new Map<string, string | null>();
    for (const row of materials) {
      const code = text(row.material_code);
      if (!batch.includes(code) || materialByCode.has(code))
        throw new Error("GEA_AMBIGUOUS_REPORT_FACTS");
      materialByCode.set(code, {
        code: nullableText(row.material_group),
        name: nullableText(row.material_group_name),
      });
    }
    for (const row of inventories) {
      const code = text(row.material_code);
      if (!batch.includes(code) || inventoryByCode.has(code))
        throw new Error("GEA_AMBIGUOUS_REPORT_FACTS");
      inventoryByCode.set(code, nullableText(row.inventory_org));
    }
    for (const skuCode of batch) {
      const material = materialByCode.get(skuCode);
      rows.push({
        skuCode,
        grading,
        customerType,
        customerGroup,
        materialGroupCode: material?.code ?? null,
        materialGroupName: material?.name ?? null,
        inventoryOrganization: inventoryByCode.get(skuCode) ?? null,
      });
    }
  }
  signal.throwIfAborted();
  return { planId: query.planId, versionId: query.versionId, month, rows };
}

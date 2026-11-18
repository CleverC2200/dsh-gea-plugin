import { object, text } from "./payload.ts";
import { PLUGIN_QUERY_MAX_PAGE_SIZE } from "./plugin-query.ts";

const parseShipmentPage = (value: unknown, maxRows: number) => {
  const page = object(value);
  if (
    !Array.isArray(page.rows) ||
    page.rows.length > maxRows ||
    (page.total != null && page.total !== page.rows.length) ||
    page.hasMore === true ||
    (page.rejectedColumns !== undefined &&
      (!Array.isArray(page.rejectedColumns) || page.rejectedColumns.length > 0))
  )
    throw new Error("GEA_INCOMPLETE_COLLECTION");
  const rows = page.rows.map((value) => {
    const row = object(value);
    const shipments = [row.ship_qty0, row.ship_qty1, row.ship_qty2].map((quantity) => {
      if (
        quantity !== null &&
        (typeof quantity !== "string" || !/^-?\d+(?:\.\d+)?$/.test(quantity))
      )
        throw new Error("GEA_INVALID_SHIPMENT");
      return quantity;
    });
    return { material_code: text(row.material_code), shipments };
  });
  return rows;
};

type ReadShipmentSql = (
  query: {
    sql: string;
    parameters: Record<string, string>;
    pageNo: number;
    pageSize: number;
    includeTotal: false;
  },
  signal: AbortSignal,
) => Promise<unknown>;

export async function readSalesPlanSkuReview(
  query: { planId: string; versionId: string },
  readDetail: (planId: string, signal: AbortSignal) => Promise<unknown>,
  readSql: ReadShipmentSql,
  periodMonth: (planId: string) => string | undefined,
  signal: AbortSignal,
  fillMaterialNames?: (skus: Record<string, unknown>[], signal: AbortSignal) => Promise<void>,
) {
  const detail = object(await readDetail(query.planId, signal));
  const currentVersion = object(detail.currentVersion);
  const customer = text(currentVersion.dealerCode);
  if (!Array.isArray(detail.skus)) throw new Error("GEA_INCOMPLETE_COLLECTION");
  const skus = detail.skus.map((value) => {
    const row = object(value);
    return { ...row, skuCode: text(row.skuCode), versionId: text(row.versionId) };
  });
  signal.throwIfAborted();
  if (
    currentVersion.planId !== query.planId ||
    currentVersion.id !== query.versionId ||
    skus.some((row) => row.versionId !== query.versionId)
  )
    throw new Error("GEA_IDENTITY_MISMATCH");
  const month = periodMonth(query.planId);
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new Error("GEA_PLAN_MONTH_SOURCE_MISSING");
  const [year, number] = month.split("-").map(Number);
  const shift = (offset: number) => {
    const date = new Date(Date.UTC(year, number - 1 + offset, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  };
  const months = [shift(-12), shift(-2), shift(-1)];
  const codes = [...new Set(skus.map((row) => row.skuCode))];
  const [{ facts, shipmentUnavailable }] = await Promise.all([
    readHistoricalShipments(codes, customer, months, readSql, signal),
    fillMaterialNames?.(skus, signal),
  ]);
  signal.throwIfAborted();
  return {
    versionId: query.versionId,
    skus,
    months,
    shipmentUnavailable: shipmentUnavailable || [...facts.values()].some((value) => value === null),
    rows: skus.map((row) => ({
      skuCode: row.skuCode,
      shipments: [0, 1, 2].map((index) => {
        const key = `${index}\u0000${row.skuCode}`;
        return shipmentUnavailable ? null : facts.has(key) ? facts.get(key)! : "0";
      }),
    })),
  };
}

async function readHistoricalShipments(
  codes: string[],
  customer: string,
  months: string[],
  readSql: ReadShipmentSql,
  signal: AbortSignal,
) {
  const facts = new Map<string, string | null>();
  let shipmentUnavailable = false;
  try {
    for (let offset = 0; offset < codes.length; offset += PLUGIN_QUERY_MAX_PAGE_SIZE) {
      signal.throwIfAborted();
      const batch = codes.slice(offset, offset + PLUGIN_QUERY_MAX_PAGE_SIZE);
      const parameters = Object.fromEntries(batch.map((code, index) => [`sku${index}`, code]));
      const placeholders = Object.keys(parameters)
        .map((key) => `:${key}`)
        .join(", ");
      const quantities = months.map(
        (_, index) =>
          `CASE WHEN COUNT(CASE WHEN ship_month = :month${index} THEN 1 END) = 0 THEN '0' WHEN COUNT(CASE WHEN ship_month = :month${index} THEN 1 END) = COUNT(CASE WHEN ship_month = :month${index} THEN act_dl_qty END) THEN CAST(SUM(CASE WHEN ship_month = :month${index} THEN act_dl_qty ELSE 0 END) AS TEXT) ELSE NULL END AS ship_qty${index}`,
      );
      const rows = parseShipmentPage(
        await readSql(
          {
            sql: `SELECT material_code, ${quantities.join(", ")} FROM agents_scm_cust_deliv_daily_di WHERE cust_code = :customer AND ship_month IN (:month0, :month1, :month2) AND material_code IN (${placeholders}) GROUP BY material_code ORDER BY material_code`,
            parameters: {
              customer,
              ...Object.fromEntries(
                months.map((value, index) => [`month${index}`, value.replace("-", "")]),
              ),
              ...parameters,
            },
            pageNo: 1,
            pageSize: PLUGIN_QUERY_MAX_PAGE_SIZE,
            includeTotal: false,
          },
          signal,
        ),
        batch.length,
      );
      for (const row of rows) {
        if (!batch.includes(row.material_code)) throw new Error("GEA_INVALID_SHIPMENT");
        for (const [index, quantity] of row.shipments.entries()) {
          const key = `${index}\u0000${row.material_code}`;
          if (facts.has(key)) throw new Error("GEA_INVALID_SHIPMENT");
          facts.set(key, quantity);
        }
      }
    }
  } catch {
    signal.throwIfAborted();
    shipmentUnavailable = true;
  }
  return { facts, shipmentUnavailable };
}

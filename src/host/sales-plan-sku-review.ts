import { object, text } from "./payload.ts";

const parseShipmentPage = (value: unknown) => {
  const page = object(value);
  if (
    !Array.isArray(page.rows) ||
    typeof page.total !== "number" ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    (page.rejectedColumns !== undefined &&
      (!Array.isArray(page.rejectedColumns) || page.rejectedColumns.length > 0))
  )
    throw new Error("GEA_INCOMPLETE_COLLECTION");
  const rows = page.rows.map((value) => {
    const row = object(value);
    const ship_qty = row.ship_qty;
    if (ship_qty !== null && (typeof ship_qty !== "string" || !/^-?\d+(?:\.\d+)?$/.test(ship_qty)))
      throw new Error("GEA_INVALID_SHIPMENT");
    return { ship_month: text(row.ship_month), material_code: text(row.material_code), ship_qty };
  });
  return { rows, total: page.total };
};

export async function readSalesPlanSkuReview(
  query: { planId: string; versionId: string },
  readDetail: (planId: string, signal: AbortSignal) => Promise<unknown>,
  readSql: (
    query: { sql: string; parameters: Record<string, string>; pageNo: number; pageSize: number },
    signal: AbortSignal,
  ) => Promise<unknown>,
  periodMonth: (planId: string) => string | undefined,
  signal: AbortSignal,
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
  const facts = new Map<string, string | null>();
  let shipmentUnavailable = false;
  try {
    let total: number | undefined;
    let count = 0;
    for (let pageNo = 1; ; pageNo++) {
      signal.throwIfAborted();
      const page = parseShipmentPage(
        await readSql(
          {
            sql: "SELECT ship_month, material_code, CASE WHEN COUNT(act_dl_qty) = COUNT(*) THEN CAST(SUM(act_dl_qty) AS TEXT) ELSE NULL END AS ship_qty FROM agents_scm_cust_deliv_daily_di WHERE cust_code = :customer AND ship_month IN (:month0, :month1, :month2) GROUP BY ship_month, material_code ORDER BY ship_month, material_code",
            parameters: {
              customer,
              ...Object.fromEntries(
                months.map((value, index) => [`month${index}`, value.replace("-", "")]),
              ),
            },
            pageNo,
            pageSize: 1000,
          },
          signal,
        ),
      );
      if (total !== undefined && page.total !== total) throw new Error("GEA_INCOMPLETE_COLLECTION");
      total = page.total;
      for (const row of page.rows) {
        const index = months.findIndex((value) => value.replace("-", "") === row.ship_month);
        const key = `${index}\u0000${row.material_code}`;
        if (index < 0 || facts.has(key)) throw new Error("GEA_INVALID_SHIPMENT");
        facts.set(key, row.ship_qty);
      }
      count += page.rows.length;
      if (count === total) break;
      if (!page.rows.length || count > total || pageNo >= 1000)
        throw new Error("GEA_INCOMPLETE_COLLECTION");
    }
  } catch {
    signal.throwIfAborted();
    shipmentUnavailable = true;
  }
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

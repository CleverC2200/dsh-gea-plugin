export const FC_DMS_WAREHOUSE_TARGET_SQL = `WITH ready AS (
 SELECT MAX(b.inv_batch_id) AS batch_id FROM agents_inv_branch_sku_day AS b
 WHERE b.inv_variant_id='__BRANCH_READY__' AND b.warehouseid=:gea_p1
)
SELECT t.warehouseid AS warehouse_code,t.warehouse_name AS warehouse_name,
 t.dms_customer_code AS customer_code,t.dms_address_code AS address_code,
 t.dms_pickup_point_code AS pup_code,t.dms_address_name AS address_name
 FROM agents_inv_branch_sku_day AS t INNER JOIN ready AS r ON t.inv_batch_id=r.batch_id
 WHERE t.warehouseid=:gea_p1 AND t.inv_variant_id='DMS_TARGET'
 GROUP BY t.warehouseid,t.warehouse_name,t.dms_customer_code,t.dms_address_code,t.dms_pickup_point_code,t.dms_address_name
 ORDER BY t.dms_address_code LIMIT 200`;
export type FcDmsTarget = {
  warehouseCode: string;
  fields: { addressCode: string; customerCode: string; pupCode: string };
  addresses: { code: string; name: string }[];
  message: string;
};
const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const record = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x))
    : {};
const code = (x: unknown) => /^[A-Za-z0-9_-]{1,64}$/.test(text(x));
export async function resolveFcDmsTarget(
  warehouseCode: string,
  addressCode: string,
  execute: (query: {
    sql: string;
    parameters: { gea_p1: string };
    includeTotal: false;
  }) => Promise<unknown>,
  signal: AbortSignal,
): Promise<FcDmsTarget> {
  if (!warehouseCode.trim() || warehouseCode.length > 64 || addressCode.length > 500)
    throw Error("DMS 主数据查询范围无效");
  const empty = (message: string): FcDmsTarget => ({
    warehouseCode,
    fields: { addressCode: "", customerCode: "", pupCode: "" },
    addresses: [],
    message,
  });
  let result: Record<string, unknown>;
  try {
    result = record(
      await execute({
        sql: FC_DMS_WAREHOUSE_TARGET_SQL,
        parameters: { gea_p1: warehouseCode },
        includeTotal: false,
      }),
    );
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    return empty(
      `收货信息读取失败，请稍后重新读取。${error instanceof Error ? error.message : ""}`,
    );
  }
  if (result.failure || (Array.isArray(result.rejectedColumns) && result.rejectedColumns.length))
    return empty("收货信息查询失败或字段未获返回权限，请联系管理员核对。");
  if (!Array.isArray(result.rows) || !result.rows.length)
    return empty("当前分仓尚无已同步的收货信息，请联系管理员核对。");
  if (result.rows.length >= 200) return empty("收货地址数量超出读取范围，请联系管理员核对。");
  const rows = result.rows.map(record);
  if (rows.some((row) => text(row.warehouse_code) !== warehouseCode || !text(row.warehouse_name)))
    throw Error("DMS 分仓主数据范围不一致");
  const customers = new Set(rows.map((row) => text(row.customer_code)));
  const pickups = new Set(rows.map((row) => text(row.pup_code)));
  if (
    customers.size !== 1 ||
    pickups.size !== 1 ||
    rows.some(
      (row) =>
        !code(row.customer_code) ||
        !code(row.pup_code) ||
        !code(row.address_code) ||
        !text(row.address_name),
    )
  )
    return empty("当前分仓的客户、地址或提货点关联不完整，请联系管理员核对。");
  const addresses = new Map<string, string>();
  for (const row of rows) {
    const key = text(row.address_code);
    const name = text(row.address_name).replaceAll("\\t", " ");
    if (addresses.has(key) && addresses.get(key) !== name)
      return empty("当前分仓收货地址存在冲突，请联系管理员核对。");
    addresses.set(key, name);
  }
  const selected = addressCode.trim() || (addresses.size === 1 ? [...addresses.keys()][0] : "");
  if (selected && !addresses.has(selected))
    return empty("所选收货地址不属于当前分仓，请重新选择。");
  return {
    warehouseCode,
    fields: {
      customerCode: text(rows[0].customer_code),
      addressCode: selected,
      pupCode: text(rows[0].pup_code),
    },
    addresses: [...addresses].map(([code, name]) => ({ code, name })),
    message: selected ? "已自动带入收货信息。" : "请选择收货地址，编码将自动带入。",
  };
}

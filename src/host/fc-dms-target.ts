/** Published reads only. Unique name matches remain explicit candidates for human confirmation. */
export const FC_DMS_WAREHOUSE_TARGET_SQL = `SELECT w.warehouse_code AS warehouse_code,
 w.warehouse_name AS warehouse_name, d.cust_code AS customer_code,
 d.cust_name AS customer_name, d.dealer_receive_addr AS receive_addresses
 FROM (SELECT t.warehouseid AS warehouse_code, MAX(t.warehouse_name) AS warehouse_name
 FROM agents_scm_warehouse_transfer_plan_data_d AS t
 WHERE t.warehouseid=:gea_p1 GROUP BY t.warehouseid
 HAVING COUNT(DISTINCT t.warehouse_name)=1) AS w
 INNER JOIN agents_dim_dealer_data_d AS d ON TRIM(d.cust_name)=TRIM(w.warehouse_name)
 GROUP BY w.warehouse_code,w.warehouse_name,d.cust_code,d.cust_name,d.dealer_receive_addr
 LIMIT 2`;
// Validate both code and name against the published pickup master. Some dealer
// rows swap these two fields; accept only an exact canonical pair, never a guessed code.
export const FC_DMS_DEFAULT_PICKUP_SQL = `WITH pickup_master AS (
 SELECT p.pickup_point_code AS pup_code,p.pickup_point_name AS pup_name
 FROM agents_dim_pickup_point_data_d AS p
 GROUP BY p.pickup_point_code,p.pickup_point_name
), customer_links AS (
 SELECT d.pickup_point_code AS source_code,d.pickup_point_name AS source_name
 FROM agents_dim_dealer_data_d AS d WHERE d.cust_code=:gea_p1
 GROUP BY d.pickup_point_code,d.pickup_point_name
)
SELECT CASE WHEN COUNT(*)=COUNT(p.pup_code) AND COUNT(DISTINCT p.pup_code)=1
 THEN MAX(p.pup_code) ELSE NULL END AS pup_code
FROM customer_links AS d LEFT JOIN pickup_master AS p ON
 (TRIM(d.source_code)=TRIM(p.pup_code) AND TRIM(d.source_name)=TRIM(p.pup_name))
 OR (TRIM(d.source_name)=TRIM(p.pup_code) AND TRIM(d.source_code)=TRIM(p.pup_name))`;
export type FcDmsTarget = {
  warehouseCode: string;
  fields: { addressCode: string; customerCode: string; pupCode: string };
  message: string;
};
const text = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const record = (x: unknown): Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x))
    : {};
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
  const fields = { addressCode: "", customerCode: "", pupCode: "" };
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
    return {
      warehouseCode,
      fields,
      message: `主数据未读取成功，请核对并补填三个编码。${error instanceof Error ? error.message : "读取失败"}`,
    };
  }
  if (result.failure || (Array.isArray(result.rejectedColumns) && result.rejectedColumns.length))
    return {
      warehouseCode,
      fields,
      message: "主数据查询失败或字段未获返回权限，请核对并补填三个编码。",
    };
  const rows = result.rows;
  if (!Array.isArray(rows) || rows.length !== 1)
    return { warehouseCode, fields, message: "未找到唯一送达方，请核对并补填三个编码。" };
  const row = record(rows[0]);
  {
    if (
      text(row.warehouse_code) !== warehouseCode ||
      !text(row.warehouse_name) ||
      text(row.customer_name) !== text(row.warehouse_name) ||
      !text(row.customer_code)
    )
      throw Error("DMS 分仓主数据范围不一致");
    fields.customerCode = text(row.customer_code);
    let addresses: unknown;
    try {
      addresses = JSON.parse(text(row.receive_addresses));
    } catch {
      addresses = null;
    }
    const candidates = Array.isArray(addresses)
      ? addresses.map((address) => text(record(address).cust_code))
      : [];
    if (addressCode.trim()) {
      if (candidates.filter((code) => code === addressCode.trim()).length !== 1)
        return {
          warehouseCode,
          fields: { addressCode: "", customerCode: "", pupCode: "" },
          message: "当前分仓未找到该收货地址的唯一关系，请核对后补填编码。",
        };
      fields.addressCode = addressCode.trim();
    } else if (candidates.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(candidates[0])) {
      fields.addressCode = candidates[0];
    }
    let pickupMessage = "";
    try {
      const pickup = record(
        await execute({
          sql: FC_DMS_DEFAULT_PICKUP_SQL,
          parameters: { gea_p1: fields.customerCode },
          includeTotal: false,
        }),
      );
      signal.throwIfAborted();
      if (
        !pickup.failure &&
        !(Array.isArray(pickup.rejectedColumns) && pickup.rejectedColumns.length) &&
        Array.isArray(pickup.rows) &&
        pickup.rows.length === 1
      ) {
        const code = text(record(pickup.rows[0]).pup_code);
        if (/^[A-Za-z0-9_-]{1,64}$/.test(code)) fields.pupCode = code;
      }
    } catch (error) {
      signal.throwIfAborted();
      pickupMessage = error instanceof Error ? error.message : "提货点读取失败";
    }
    return {
      warehouseCode,
      fields,
      message: `已按分仓名称匹配唯一客户，请复核与所选分仓一致。${fields.addressCode ? "已带入唯一收货地址。" : "收货地址不唯一或未提供，请补填。"}${fields.pupCode ? "已带入经主数据核对的唯一提货点。" : "提货点未能唯一核对，请补填。"}${pickupMessage}`,
    };
  }
}

/** Published reads only. Unique name matches remain explicit candidates for human confirmation. */
export const FC_DMS_TARGET_SQL = `SELECT r.receive_cust_code AS address_code,
 CASE WHEN COUNT(DISTINCT r.cust_code)=1 THEN MAX(r.cust_code) ELSE NULL END AS customer_code,
 CASE WHEN COUNT(DISTINCT r.cust_code)=1 AND COUNT(DISTINCT p.warehouse_group_id)=1
 THEN MAX(p.warehouse_group_id) ELSE NULL END AS pup_code
 FROM agents_scm_customer_receive AS r
 LEFT JOIN agents_scm_cust_pickup_point AS p
 ON p.cust_code=r.cust_code AND p.is_default_shipping=TRUE
 WHERE r.receive_cust_code=:gea_p1
 GROUP BY r.receive_cust_code LIMIT 1`;
export const FC_DMS_WAREHOUSE_TARGET_SQL = `SELECT w.warehouse_code AS warehouse_code,
 w.warehouse_name AS warehouse_name, d.cust_code AS customer_code,
 d.cust_name AS customer_name, d.dealer_receive_addr AS receive_addresses
 FROM (SELECT t.warehouse_code AS warehouse_code, MAX(t.warehouse_name) AS warehouse_name
 FROM agents_scm_warehouse_transfer_plan_data_d AS t
 WHERE t.warehouse_code=:gea_p1 GROUP BY t.warehouse_code
 HAVING COUNT(DISTINCT t.warehouse_name)=1) AS w
 INNER JOIN agents_dim_dealer_data_d AS d ON TRIM(d.cust_name)=TRIM(w.warehouse_name)
 LIMIT 2`;
export const FC_DMS_DEFAULT_PICKUP_SQL = `SELECT p.warehouse_group_id AS pup_code
 FROM agents_scm_cust_pickup_point AS p
 WHERE p.cust_code=:gea_p1 AND p.is_default_shipping=TRUE
 GROUP BY p.warehouse_group_id LIMIT 2`;
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
        sql: addressCode.trim() ? FC_DMS_TARGET_SQL : FC_DMS_WAREHOUSE_TARGET_SQL,
        parameters: { gea_p1: addressCode.trim() || warehouseCode },
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
  if (!addressCode.trim()) {
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
    if (Array.isArray(addresses) && addresses.length === 1) {
      const code = text(record(addresses[0]).cust_code);
      if (/^[A-Za-z0-9_-]{1,64}$/.test(code)) fields.addressCode = code;
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
      message: `已按分仓名称匹配唯一客户，请复核与所选分仓一致。${fields.addressCode ? "已带入唯一收货地址。" : "收货地址不唯一或未提供，请补填。"}${fields.pupCode ? "已带入第一默认提货点。" : "第一默认提货点暂未确认，请补填。"}${pickupMessage}`,
    };
  }

  if (text(row.address_code) !== addressCode.trim()) throw Error("DMS 收货地址主数据范围不一致");
  fields.addressCode = text(row.address_code);
  fields.customerCode = text(row.customer_code);
  fields.pupCode = fields.customerCode ? text(row.pup_code) : "";
  return {
    warehouseCode,
    fields,
    message: Object.values(fields).every(Boolean)
      ? "已按收货地址关联客户及第一默认提货点，请核对与所选分仓一致。"
      : "已带入可唯一关联的编码；未匹配或存在多条配置的字段请核对后补填。",
  };
}

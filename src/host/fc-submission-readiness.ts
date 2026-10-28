import { DmsClient, parseDmsOrder, type DmsConfig } from "./dms-orders.ts";
import type { FcStorageConfig } from "./fc-storage.ts";

/** Local checks only: no SQL, login, order or intent write occurs here. */
export function checkFcSubmissionReadiness(
  dms: DmsConfig | undefined,
  storage: FcStorageConfig | undefined,
  identity: { tenantId: string; userId: string },
  warehouseCode: string,
  order: unknown,
) {
  const matches = dms?.users?.filter(
    (u) => u.tenantId === identity.tenantId && u.userId === identity.userId,
  );
  if (!dms || matches?.length !== 1) throw Error("DMS 当前环境或用户映射未配置，请联系管理员");
  new DmsClient(dms, matches[0]).assertConfigured();
  parseDmsOrder(order);
  const grants = storage?.users?.filter(
    (u) => u.tenantId === identity.tenantId && u.userId === identity.userId,
  );
  if (
    !storage?.published ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(storage.dataSourceCode) ||
    grants?.length !== 1
  )
    throw Error("分仓业务入库配置未完成，请配置数据源及发布授权后再提交");
  if (!grants[0].warehouses?.includes(warehouseCode)) throw Error("当前用户未配置该分仓的入库授权");
  if (storage.planningLayout === "legacy") {
    const warehouseId = storage.warehouseIds?.[warehouseCode];
    if (typeof warehouseId !== "string" || !warehouseId || warehouseId.length > 64)
      throw Error("当前分仓与原库 warehouse_id 的映射未配置");
  }
  return { ready: true, scope: "local-configuration" as const };
}

import { DmsClient, parseDmsOrder, type DmsConfig } from "./dms-orders.ts";
import type { FcDmsTarget } from "./fc-dms-target.ts";

export function checkFcSubmissionReadiness(
  dms: DmsConfig | undefined,
  identity: { tenantId: string; userId: string },
  warehouseCode: string,
  order: unknown,
) {
  const matches = dms?.users?.filter(
    (u) => u.tenantId === identity.tenantId && u.userId === identity.userId,
  );
  if (!dms || matches?.length !== 1) throw Error("DMS 当前环境或用户映射未配置，请联系管理员");
  new DmsClient(dms, matches[0]).assertConfigured();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(warehouseCode)) throw Error("DMS 提交缺少有效分仓编码");
  parseDmsOrder(order);
  return { ready: true, scope: "dms-direct" as const };
}

export function checkFcDmsOrderTarget(warehouseCode: string, order: unknown, target: FcDmsTarget) {
  const parsed = parseDmsOrder(order);
  if (
    target.warehouseCode !== warehouseCode ||
    !target.targets.some(
      (entry) =>
        parsed.customerCode === entry.customerCode &&
        parsed.addressCode === entry.addressCode &&
        parsed.pupCode === entry.pupCode,
    )
  )
    throw Error("收货信息未通过当前分仓的核验，请核对客户、收货地址和提货点编码或重新读取收货信息");
  return parsed;
}

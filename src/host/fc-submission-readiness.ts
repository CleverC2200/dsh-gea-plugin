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
    !target.fields.customerCode ||
    !target.fields.addressCode ||
    !target.fields.pupCode ||
    parsed.customerCode !== target.fields.customerCode ||
    parsed.addressCode !== target.fields.addressCode ||
    parsed.pupCode !== target.fields.pupCode
  )
    throw Error("收货信息已变化或当前账号不可读取，请重新选择分仓并读取收货信息");
  return parsed;
}

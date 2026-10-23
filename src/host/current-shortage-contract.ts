/** Fixed page-query routes; the calling Session still owns the Consumer and authorization. */
export function currentShortageResource(consumer: string): string | undefined {
  switch (consumer) {
    case "base-safety-stock":
      return "inventory-aqkc";
    case "branch-inventory":
      return "inventory-fc";
    case "full-chain-inventory":
      return "inventory-qll";
    case "aps":
      return "inventory-apsplan";
    default:
      return undefined;
  }
}

export const CURRENT_SHORTAGE_DESCRIPTION =
  "查询当前未备单订单需求、该订单自身占用、还需满足量和当前缺货量。与基地/分仓/全链/产销协同页面共用已安装固定SQL配置，走当前Agent的统一GEA授权，无需打开页面。" +
  "当前缺货直接用本工具；summary给完整范围汇总，detail给地点+SKU分页，base传基地名称（如郑州），warehouseCode传分仓编码，sku传商品编码。" +
  "只有当前状态，不接受历史日期、月份、SQL、模型名、Consumer或凭据。单位箱。共享库存缺口不分摊到订单；不能据此给缺货订单数。授权/来源失败保留未知，不能换通道重试。";

export const CURRENT_SHORTAGE_ROUTING =
  "当前订单和当前缺货查询使用 gea_current_shortage，与页面共用三层SQL计算。独立询问郑州基地当前缺货时，直接传base=郑州、view=summary；明细使用view=detail。" +
  "本指标的取数入口以这个已安装固定查询为准，旧Skill中的Cube访问步骤不适用于本指标。不要先探测Cube缺货模型，也不要在被拒后切换工具重试。" +
  "已成功读取的数量空值按既定SQL处理；源、映射或权限失败保持未知。输出数量单位箱，当前订单不按月截断，缺货不等于月累计履约缺货。";

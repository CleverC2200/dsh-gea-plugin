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
  "当前缺货直接用本工具；summary给完整范围汇总，locations给完整地点排行，detail给地点+SKU分页。基地SKU订单缺货排行用sku-ranking：先跨已授权基地合并同一商品，按净缺口件数降序，返回正缺口SKU去重数量、完整缺口总量及当前页合计和占比。不得用库存总行数当缺货SKU数，不得把地点+SKU前10条冒充公司SKU前10名。排行后的追问沿用返回的location_code作为warehouseCode，不把仓名或基地名填入编码。base传基地名称（如郑州），sku传商品编码。" +
  "只有当前状态，不接受历史日期、月份、SQL、模型名、Consumer或凭据。单位箱。共享库存缺口不分摊到订单；不能据此给缺货订单数。授权/来源失败保留未知，不能换通道重试。";

export const CURRENT_SHORTAGE_ROUTING =
  "基地SKU订单缺货排行、缺货品项排名或前10商品必须调用gea_current_shortage的view=sku-ranking，沿用base/category筛选及page；直接引用shortageSkuCount、totalShortage、pageShortage和pageSharePercent，不从库存明细条数推算SKU数，不将当前状态说成今日新增。sku-ranking已包含快照、完整总量和去重SKU数，成功后直接回答，不再反复调用summary、locations或相同参数查询。日报对账必须区分订单未满足量与扣可用库存后的净缺口，并说明数据截止时间；不擅自排除旧订单或改变归属。" +
  "当前订单和当前缺货查询使用 gea_current_shortage，与页面共用三层SQL计算。用户未限定基地时省略base，查询全部授权基地，不能把示例基地当默认范围；当前缺货不传asOf或其他日期参数。独立询问某基地缺货总量才用view=summary；哪些分仓缺货最严重使用view=locations。追问其中某仓的SKU时，保留上轮返回的location_code，传warehouseCode、view=detail；继续下一页沿用筛选并递增page。" +
  "本指标的取数入口以这个已安装固定查询为准，旧Skill中的Cube访问步骤不适用于本指标。不要先探测Cube缺货模型，也不要在被拒后切换工具重试。" +
  "已成功读取的数量空值按既定SQL处理；源、映射或权限失败保持未知。输出数量单位箱，当前订单不按月截断，缺货不等于月累计履约缺货。";

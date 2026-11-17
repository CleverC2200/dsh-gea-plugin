import type { Context } from "@deepseek-ai/cordis";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import type { Business } from "./business.ts";
import { registerOrderKpiTool } from "./order-kpi-tool.ts";

export const ORDER_ONTIME_ROUTING =
  "gea_order_ontime是准交率的兼容别名；口径与计算统一由gea_order_kpi从当前Workbench代码读取，不维护独立公式。";
export function registerOrderOntimeTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  registerOrderKpiTool(ctx, business, packages, { name: "gea_order_ontime", metric: "准交率" });
}

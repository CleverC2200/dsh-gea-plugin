import type { Context } from "@deepseek-ai/cordis";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import type { Business } from "./business.ts";
import { registerOrderKpiTool } from "./order-kpi-tool.ts";

export const ORDER_AMENDMENT_ROUTING =
  "gea_order_amendment是改单率的兼容别名；口径与计算统一由gea_order_kpi从当前Workbench代码读取，不维护独立公式。";
export function registerOrderAmendmentTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  registerOrderKpiTool(ctx, business, packages, { name: "gea_order_amendment", metric: "改单率" });
}

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, sessionConsumer } from "./business-identity.ts";
import { readConfiguredHtmlQuery } from "./configured-html-query.ts";

export const ORDER_AMENDMENT_ROUTING =
  "订单工作台改单率及明细回源统一使用gea_order_amendment，复用已安装看板的日表固定查询。" +
  "start含、endExclusive不含，按物流追踪表lastshipmenttime装车完成时间归属实际发货周期；与日表按执行单号＋客户关联，同一最新批次多条取最后装车完成，缺时间不以OMS新增或WMS关单替代；base郑州仅pickup_point=01。" +
  "分子仅客户要求改单量≥0时合计绝对数量差，完整有效量为分母；按商品数量，不按订单张数，不加锁定期或改单时间条件。" +
  "invalid是保留集合内待判定明细条数，不是剔除数；本查询不返回剔除数量，不得据invalid=0写剔除0。" +
  "view=summary取完整汇总，view=details按page分页；明细单页不代替全量分母，不回退旧Cube度量或小时表。";

export function registerOrderAmendmentTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  const resource = packages.find(
    (item) =>
      item.manifest.id === "inventory-orderworkbench" &&
      item.manifest.gea?.consumerCode === "order" &&
      item.manifest.mode !== "mock",
  );
  if (!resource) return;
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "gea_order_amendment",
        description: ORDER_AMENDMENT_ROUTING,
        parameters: {
          start: {
            type: "string",
            required: true,
            description: "装车完成日期，YYYY-MM-DD，包含。",
          },
          endExclusive: {
            type: "string",
            required: true,
            description: "装车完成日期，YYYY-MM-DD，不包含。",
          },
          base: { type: "string", description: "提货点范围；郑州仅提货点01；留空取授权全国。" },
          view: {
            type: "string",
            enum: ["summary", "details"],
            description: "默认summary完整汇总，details分页明细。",
          },
          page: { type: "integer", description: "明细页码，1起，每页200条。" },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
          presentationMeta: () => ({
            source: "GEA_CONFIGURED_SQL",
            operation: "order-amendment",
            readonly: true,
          }),
        },
        timeoutMs: Math.max(business.config.requestTimeoutMs, 90000),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (!exec.agent) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const session = exec.agent.id;
          await assertSessionResourceAvailable(ctx, session, exec.signal);
          if (sessionConsumer(ctx, business, session) !== "order")
            throw Error("GEA_ORDER_AMENDMENT_NOT_AVAILABLE");
          const validDate = (value: string) =>
            /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 10) === value;
          if (
            !validDate(args.start) ||
            !validDate(args.endExclusive) ||
            args.start >= args.endExclusive ||
            Date.parse(args.endExclusive) - Date.parse(args.start) > 366 * 86400000
          )
            throw Error("INVALID_AMENDMENT_PERIOD");
          if (
            (args.view !== undefined && !["summary", "details"].includes(args.view)) ||
            (args.base !== undefined && (typeof args.base !== "string" || args.base.length > 64))
          )
            throw Error("INVALID_AMENDMENT_SCOPE");
          const page = args.page ?? 1;
          if (!Number.isSafeInteger(page) || page < 1 || page > 5000)
            throw Error("INVALID_AMENDMENT_PAGE");
          const changed = new AbortController();
          const unwatch = ctx.agentResources.watch(() => changed.abort());
          const signal = AbortSignal.any([exec.signal, business.identitySignal(), changed.signal]);
          try {
            if (resource.manifest.sqlConfig !== "sql.config.json")
              throw Error("GEA_AGENT_RESOURCE_MISSING");
            const root = await realpath(resource.directory),
              path = await realpath(resolve(root, "sql.config.json"));
            if (!path.startsWith(root + sep)) throw Error("INVALID_SQL_CONFIG_PATH");
            const raw = await readFile(path, "utf8");
            if (Buffer.byteLength(raw) > 5_000_000) throw Error("SQL_CONFIG_TOO_LARGE");
            const config = JSON.parse(raw),
              queryId =
                args.view === "details"
                  ? "workbench.amendment.details"
                  : "workbench.amendment.summary";
            const contract = config.queries?.[queryId]?.metricContract;
            if (
              config.agentId !== "inventory-orderworkbench" ||
              contract?.version !== "quantity-shipment-nonnegative-no-lock-v2" ||
              contract.dateField !== "lastshipmenttime" ||
              contract.dateSource !== "agents_scm_order_trace_final_di" ||
              contract.lockPeriod !== false ||
              contract.changeTimeRequired !== false
            )
              throw Error("GEA_AMENDMENT_PAGE_UPDATE_REQUIRED");
            const result = await readConfiguredHtmlQuery(
              resource,
              {
                queryId,
                parameters: {
                  start: args.start,
                  end_exclusive: args.endExclusive,
                  report_base: args.base ?? "",
                  ...(args.view === "details" ? { page_size: 200, offset: (page - 1) * 200 } : {}),
                },
                freshAfter: Date.now(),
              },
              business,
              signal,
              "order",
            );
            signal.throwIfAborted();
            await assertSessionResourceAvailable(ctx, session, signal);
            if (sessionConsumer(ctx, business, session) !== "order")
              throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
            const current = await readFile(path, "utf8");
            if (current !== raw) throw Error("GEA_AMENDMENT_SOURCE_CHANGED");
            return JSON.stringify({
              readonly: true,
              metricSource: "installed-workbench-amendment-sql",
              queryId,
              period: { start: args.start, endExclusive: args.endExclusive },
              base: args.base ?? "",
              contract,
              result,
            });
          } finally {
            unwatch();
          }
        },
      }),
    ),
  );
}

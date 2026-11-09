import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, sessionConsumer } from "./business-identity.ts";
import { readConfiguredHtmlQuery } from "./configured-html-query.ts";

export const ORDER_ONTIME_ROUTING =
  "订单工作台准交率及明细回源统一使用gea_order_ontime，复用已安装看板固定SQL；不自己拼SQL或改走旧Cube。" +
  "start含、endExclusive不含，按TMS实际到货（GPS围栏优先、到货确认其次）；base为看板基地。" +
  "按执行单号去重，分子为已确认准交数，完整分母包含待判定。kamd/dc晚满18小时、其他晚满12小时为逾期；未知不当已确认逾期。" +
  "view=summary直接返回numerator、denominator、pending、known、late、value；details按page分页，不用单页或样本率替代主率。" +
  "口径说明读取本次skill工具加载的当前Skill及其链接合同；其他历史快照、副本和通用物流签收指标不代表当前看板，不通过glob/grep搜全部历史副本来选口径。";

export function registerOrderOntimeTool(
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
        name: "gea_order_ontime",
        description: ORDER_ONTIME_ROUTING,
        parameters: {
          start: {
            type: "string",
            required: true,
            description: "TMS实际到货日期，YYYY-MM-DD，包含。",
          },
          endExclusive: {
            type: "string",
            required: true,
            description: "TMS实际到货日期，YYYY-MM-DD，不包含。",
          },
          base: {
            type: "string",
            description: "看板基地名称belong_base；留空取授权全国。",
          },
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
            operation: "order-ontime",
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
            throw Error("GEA_ORDER_ONTIME_NOT_AVAILABLE");
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
            throw Error("INVALID_ONTIME_PERIOD");
          if (
            (args.view !== undefined && !["summary", "details"].includes(args.view)) ||
            (args.base !== undefined && (typeof args.base !== "string" || args.base.length > 64))
          )
            throw Error("INVALID_ONTIME_SCOPE");
          const page = args.page ?? 1;
          if (!Number.isSafeInteger(page) || page < 1 || page > 5000)
            throw Error("INVALID_ONTIME_PAGE");
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
                  ? "workbench.ontime.agent.details"
                  : "workbench.ontime.agent.summary";
            const contract = config.queries?.[queryId]?.metricContract;
            if (
              config.agentId !== "inventory-orderworkbench" ||
              contract?.version !== "execution-arrival-18-12-complete-v1" ||
              contract.graceHours?.kamd !== 18 ||
              contract.graceHours?.other !== 12
            )
              throw Error("GEA_ONTIME_PAGE_UPDATE_REQUIRED");
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
            if (current !== raw) throw Error("GEA_ONTIME_SOURCE_CHANGED");
            let metrics;
            if (
              args.view !== "details" &&
              !(
                result &&
                typeof result === "object" &&
                "success" in result &&
                result.success === false
              )
            ) {
              const rows =
                result && typeof result === "object" && "rows" in result ? result.rows : undefined;
              if (!Array.isArray(rows) || rows.length !== 1) throw Error("INVALID_ONTIME_SUMMARY");
              const row = rows[0] as Record<string, unknown>;
              const fields = ["numerator", "denominator", "known", "pending", "late"] as const;
              const counts = Object.fromEntries(
                fields.map((key) => [
                  key,
                  row[key] === null || row[key] === undefined ? NaN : Number(row[key]),
                ]),
              );
              if (
                fields.some((key) => !Number.isSafeInteger(counts[key]) || counts[key] < 0) ||
                counts.known + counts.pending !== counts.denominator ||
                counts.numerator + counts.late !== counts.known
              )
                throw Error("INVALID_ONTIME_COUNTS");
              metrics = {
                ...counts,
                value:
                  counts.denominator > 0 ? (100 * counts.numerator) / counts.denominator : null,
                unit: "%",
                countUnit: "张执行单",
              };
            }
            return JSON.stringify({
              readonly: true,
              metricSource: "installed-workbench-ontime-sql",
              queryId,
              period: { start: args.start, endExclusive: args.endExclusive },
              base: args.base ?? "",
              contract,
              result,
              ...(metrics ? { metrics } : {}),
            });
          } finally {
            unwatch();
          }
        },
      }),
    ),
  );
}

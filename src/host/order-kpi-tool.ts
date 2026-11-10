import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, sessionConsumer } from "./business-identity.ts";
import { readConfiguredHtmlQuery } from "./configured-html-query.ts";

export const ORDER_KPI_ROUTING =
  "作废率、改单率、满足率、准交率、货龄占比、可发货天数的口径及独立问数使用gea_order_kpi。" +
  "该工具调用已安装看板同一套查询、计算与代码合同，不要求打开页面；metric、start、endExclusive、base指定所问范围。" +
  "点击卡片先引用当前current/contract，独立核对调用同一入口；旧会话或知识库不得覆盖当前代码版本。" +
  "只有这六项指标使用该入口，其他订单、库存和业务知识问题继续使用已授权Cube和知识库。";

export function registerOrderKpiTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
  alias?: { name: string; metric: string },
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
        name: alias?.name ?? "gea_order_kpi",
        description: alias
          ? `${alias.name}是${alias.metric}的兼容别名，调用与gea_order_kpi相同的当前计算代码。`
          : ORDER_KPI_ROUTING,
        parameters: {
          ...(alias
            ? {}
            : {
                metric: {
                  type: "string" as const,
                  required: true,
                  description: "六项看板指标名称；仅这一参数选择指标，不提供SQL或公式。",
                },
              }),
          start: { type: "string", required: true, description: "统计开始日期YYYY-MM-DD，包含。" },
          endExclusive: {
            type: "string",
            required: true,
            description: "统计结束日期YYYY-MM-DD，不包含；周期归属由代码合同决定。",
          },
          base: {
            type: "string",
            description: "基地/提货点名称；留空为当前授权全国范围，具体含义由指标合同返回。",
          },
          view: {
            type: "string",
            enum: ["contract", "summary", "details"],
            description: "默认summary；contract仅取当前口径；details取已发布明细。",
          },
          page: { type: "integer", description: "明细页码，1起。" },
          expectedVersion: {
            type: "number",
            description: "卡片提供的代码版本；独立问数可不传，旧版本会被拒绝。",
          },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
          presentationMeta: () => ({
            source: "GEA_CONFIGURED_SQL",
            operation: "order-kpi",
            readonly: true,
          }),
        },
        timeoutMs: Math.max(business.config.requestTimeoutMs, 180000),
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (!exec.agent) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const session = exec.agent.id;
          await assertSessionResourceAvailable(ctx, session, exec.signal);
          if (sessionConsumer(ctx, business, session) !== "order")
            throw Error("GEA_ORDER_KPI_NOT_AVAILABLE");
          const changed = new AbortController(),
            unwatch = ctx.agentResources.watch(() => changed.abort());
          const signal = AbortSignal.any([exec.signal, business.identitySignal(), changed.signal]);
          try {
            if (resource.manifest.sqlConfig !== "sql.config.json")
              throw Error("GEA_AGENT_RESOURCE_MISSING");
            const root = await realpath(resource.directory),
              configPath = await realpath(resolve(root, "sql.config.json"));
            if (!configPath.startsWith(root + sep)) throw Error("INVALID_SQL_CONFIG_PATH");
            const raw = await readFile(configPath, "utf8");
            if (Buffer.byteLength(raw) > 5000000) throw Error("SQL_CONFIG_TOO_LARGE");
            const config = JSON.parse(raw),
              contract = config.metricRuntime;
            if (
              config.agentId !== "inventory-orderworkbench" ||
              contract?.schemaVersion !== 1 ||
              contract.file !== "metric-runtime.mjs" ||
              !/^[a-f0-9]{64}$/.test(contract.sha256 ?? "")
            )
              throw Error("GEA_ORDER_KPI_PAGE_UPDATE_REQUIRED");
            const runtimePath = await realpath(resolve(root, contract.file));
            if (!runtimePath.startsWith(root + sep)) throw Error("INVALID_METRIC_RUNTIME_PATH");
            const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
            if (digest(await readFile(runtimePath)) !== contract.sha256)
              throw Error("GEA_ORDER_KPI_RUNTIME_CHANGED");
            const runtime = await import(
              pathToFileURL(runtimePath).href + "?sha=" + contract.sha256
            );
            if (runtime.metricCalculationVersion !== contract.version)
              throw Error("GEA_ORDER_KPI_RUNTIME_VERSION_MISMATCH");
            const result = await runtime.readOrderMetric(
              config,
              { ...args, ...(alias ? { metric: alias.metric } : {}) },
              async (
                _request: unknown,
                options: { queryId: string; values: Record<string, unknown> },
              ) =>
                readConfiguredHtmlQuery(
                  resource,
                  { queryId: options.queryId, parameters: options.values, freshAfter: Date.now() },
                  business,
                  signal,
                  "order",
                ),
              signal,
            );
            signal.throwIfAborted();
            await assertSessionResourceAvailable(ctx, session, signal);
            if (sessionConsumer(ctx, business, session) !== "order")
              throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
            if (
              (await readFile(configPath, "utf8")) !== raw ||
              digest(await readFile(runtimePath)) !== contract.sha256
            )
              throw Error("GEA_ORDER_KPI_SOURCE_CHANGED");
            return JSON.stringify({
              metricSource: "installed-shared-order-metric-runtime",
              ...result,
            });
          } finally {
            unwatch();
          }
        },
      }),
    ),
  );
}

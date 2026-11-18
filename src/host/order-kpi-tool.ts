import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import type { Business } from "./business.ts";
import {
  assertSessionResourceAvailable,
  sessionConsumer,
} from "./business-identity.ts";
import { readCubeFinalMetric } from "./order-kpi-final.mjs";
import { deadline } from "@deepseek-ai/dsh-timeout";

const orderKpiTimeoutMs = 180000;

export const ORDER_KPI_ROUTING =
  "作废率、改单率、满足率、准交率、货龄占比、可发货天数的口径及独立问数使用gea_order_kpi。" +
  "该工具先发现Cube模型，再查询与其他Agent共用的Cube最终指标；需要业务解释时按需读取已授权知识库，数值口径以当前发布合同为准，不要求打开页面；metric、start、endExclusive、base指定所问范围。" +
  "点击卡片先引用当前current/contract，独立核对调用同一入口；旧会话或知识库不得覆盖当前代码版本。" +
  "分组问数用view=groups和dimensions，先读取contract.grouping.supported及unsupported；应责总监、SKU自动带基地。分组使用groups.contract和行current.target/status，顶层contract/current为原卡片汇总。返回同口径分子分母、待判定及达成状态；原始明细未发布不代表分组未发布。unsupported-dimension是该指标缺少该归属粒度，不是整个指标未发布，也不是权限不足。本期、环比、同比按各自时间窗分别查询，不平均百分比；准交率跨维度合计须重新去重，总监可能共同归属，不相加。" +
  "作废率分组失败时遵守retryPolicy：不自动重复或改写参数重试；说明错误并保留页面已有结论。" +
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
  const failedGroups = new WeakMap<
    AbortSignal,
    Map<string, { retryAt: number; value: string }>
  >();
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
                  description:
                    "六项看板指标名称；仅这一参数选择指标，不提供SQL或公式。",
                },
              }),
          start: {
            type: "string",
            required: true,
            description: "统计开始日期YYYY-MM-DD，包含。",
          },
          endExclusive: {
            type: "string",
            required: true,
            description:
              "统计结束日期YYYY-MM-DD，不包含；周期归属由代码合同决定。",
          },
          base: {
            type: "string",
            description:
              "基地/提货点名称；留空为当前授权全国范围，具体含义由指标合同返回。",
          },
          dimensions: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "base",
                "item",
                "category",
                "director",
                "sku",
                "region",
                "province",
                "customer",
                "salesRegion",
              ],
            },
            description:
              "view=groups分组字段，最多3个且不重复；基地base、品项item、品类category、应责总监director、产品编号sku、大区region、省区province、客户编码customer、销售区域salesRegion（省区优先大区兜底）。默认基地＋品项；先按contract.grouping确认该指标支持的维度，不支持不能泛称指标未发布。",
          },
          view: {
            type: "string",
            enum: ["contract", "summary", "details", "groups"],
            description:
              "默认summary；contract取当前口径；groups按dimensions取当前支持维度分组的分子分母、待判定和状态；details取已发布原始明细，明细可用性与分组独立。",
          },
          page: {
            type: "integer",
            description:
              "原始明细或分组页码，1起；分组每页100项，按hasMore继续，不能将一页当全量；groups.total始终是全量合计。",
          },
          expectedVersion: {
            type: "number",
            description: "卡片提供的代码版本；独立问数可不传，旧版本会被拒绝。",
          },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
          presentationMeta: () => ({
            source: "GEA_CUBE",
            operation: "order-kpi",
            readonly: true,
          }),
        },
        timeoutMs: orderKpiTimeoutMs,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (!exec.agent) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          using budget = deadline(
            exec.signal,
            orderKpiTimeoutMs,
            "GEA_ORDER_KPI_TIMEOUT",
          );
          const session = exec.agent.id;
          await assertSessionResourceAvailable(ctx, session, budget.signal);
          if (sessionConsumer(ctx, business, session) !== "order")
            throw Error("GEA_ORDER_KPI_NOT_AVAILABLE");
          const changed = new AbortController(),
            unwatch = ctx.agentResources.watch(() => changed.abort());
          const identity = business.identitySignal();
          const signal = AbortSignal.any([
            budget.signal,
            identity,
            changed.signal,
          ]);
          try {
            if (resource.manifest.sqlConfig !== "sql.config.json")
              throw Error("GEA_AGENT_RESOURCE_MISSING");
            const root = await realpath(resource.directory),
              configPath = await realpath(resolve(root, "sql.config.json"));
            if (!configPath.startsWith(root + sep))
              throw Error("INVALID_SQL_CONFIG_PATH");
            const raw = await readFile(configPath, "utf8");
            if (Buffer.byteLength(raw) > 5000000)
              throw Error("SQL_CONFIG_TOO_LARGE");
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
            if (!runtimePath.startsWith(root + sep))
              throw Error("INVALID_METRIC_RUNTIME_PATH");
            const digest = (bytes: Buffer) =>
              createHash("sha256").update(bytes).digest("hex");
            if (digest(await readFile(runtimePath)) !== contract.sha256)
              throw Error("GEA_ORDER_KPI_RUNTIME_CHANGED");
            const runtime = await import(
              pathToFileURL(runtimePath).href + "?sha=" + contract.sha256
            );
            if (runtime.metricCalculationVersion !== contract.version)
              throw Error("GEA_ORDER_KPI_RUNTIME_VERSION_MISMATCH");
            const metric = alias?.metric ?? args.metric;
            const retryKey =
              metric === "作废率" && args.view === "groups"
                ? JSON.stringify([
                    session,
                    contract.sha256,
                    metric,
                    args.start,
                    args.endExclusive,
                    args.base ?? "",
                    [...(args.dimensions ?? [])].sort(),
                    args.page ?? 1,
                    args.expectedVersion ?? null,
                  ])
                : undefined;
            const failures = failedGroups.get(identity) ?? new Map();
            for (const [key, failure] of failures)
              if (failure.retryAt <= Date.now()) failures.delete(key);
            const failed = retryKey ? failures.get(retryKey) : undefined;
            if (failed) {
              await assertSessionResourceAvailable(ctx, session, signal);
              if (sessionConsumer(ctx, business, session) !== "order")
                throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
              signal.throwIfAborted();
              return JSON.stringify({
                ...JSON.parse(failed.value),
                retryPolicy: {
                  automaticRetry: false,
                  suppressed: true,
                  retryAfter: new Date(failed.retryAt).toISOString(),
                  reason:
                    "同身份、会话、代码版本及范围的作废率分组请求刚刚失败，本次未重复查询；先说明原失败，不把失败当成无数据。",
                },
              });
            }
            const input = {
              ...args,
              ...(alias ? { metric: alias.metric } : {}),
            };
            const envelope = await runtime.readOrderMetric(
              config,
              { ...input, view: "contract" },
              () => {
                throw Error("GEA_CUBE_FINAL_RAW_QUERY_FORBIDDEN");
              },
              signal,
            );
            const client = await business.moduleMcp("order", signal);
            let result;
            try {
              result = await readCubeFinalMetric(
                config,
                {
                  ...input,
                  metric: envelope.metric,
                  base: envelope.base,
                  start: envelope.period.start,
                  endExclusive: envelope.period.endExclusive,
                  inventoryEndExclusive: envelope.period.inventoryEndExclusive,
                },
                async (
                  name: string,
                  parameters: Record<string, unknown>,
                  callSignal: AbortSignal,
                ) => {
                  await assertSessionResourceAvailable(
                    ctx,
                    session,
                    callSignal,
                  );
                  if (sessionConsumer(ctx, business, session) !== "order")
                    throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
                  return client.call(
                    name as "inspect_cube_model" | "query_business_data",
                    parameters,
                    callSignal,
                  );
                },
                signal,
                envelope,
                {
                  summary: envelope.contract,
                  groups: runtime.metricContract(
                    envelope.metric,
                    config,
                    (
                      args.dimensions ??
                      envelope.contract.grouping.defaultDimensions ?? [
                        "base",
                        "item",
                      ]
                    ).some((dimension: string) =>
                      ["base", "director", "sku"].includes(dimension),
                    )
                      ? "base"
                      : envelope.base
                        ? "base"
                        : "national",
                  ),
                },
              );
            } catch (error) {
              const code =
                error instanceof Error && "code" in error
                  ? String(error.code)
                  : "";
              if (
                input.view !== "groups" ||
                ![
                  "GEA_SQL_UNAVAILABLE",
                  "GEA_SQL_QUERY_TIMEOUT",
                  "CUBE_QUERY_REJECTED",
                ].includes(code)
              )
                throw error;
              result = {
                ...envelope,
                current: {
                  value: null,
                  numerator: null,
                  denominator: null,
                  pending: null,
                },
                sources: [{ code }],
                groups: {
                  availability: "unavailable",
                  rows: [],
                  total: null,
                  code,
                },
              };
            }
            signal.throwIfAborted();
            await assertSessionResourceAvailable(ctx, session, signal);
            if (sessionConsumer(ctx, business, session) !== "order")
              throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
            if (
              (await readFile(configPath, "utf8")) !== raw ||
              digest(await readFile(runtimePath)) !== contract.sha256
            )
              throw Error("GEA_ORDER_KPI_SOURCE_CHANGED");
            const value = JSON.stringify({
              metricSource: "cube-final-published-metric",
              sourceChannel: "Cube",
              ...result,
              ...(retryKey
                ? { retryPolicy: { automaticRetry: false, suppressed: false } }
                : {}),
            });
            if (
              retryKey &&
              result.sources?.some((source: { code?: string }) =>
                ["GEA_SQL_UNAVAILABLE", "GEA_SQL_QUERY_TIMEOUT"].includes(
                  source.code ?? "",
                ),
              )
            ) {
              if (failures.size >= 128)
                failures.delete(failures.keys().next().value!);
              failures.set(retryKey, { retryAt: Date.now() + 60000, value });
              failedGroups.set(identity, failures);
            }
            return value;
          } finally {
            unwatch();
          }
        },
      }),
    ),
  );
}

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, sessionConsumer } from "./business-identity.ts";
import { readConfiguredHtmlQuery } from "./configured-html-query.ts";
import { orchestrationInventoryAccess } from "./orchestration-inventory-access.ts";
import { sameCubeAccess } from "./cube-access.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

export const BRANCH_INVENTORY_ROUTING =
  "分仓库存结构与补货问题直接使用gea_branch_inventory：summary返回全范围库存、可用、占用、冻结、目标及补货测算；health返回分仓货龄与超龄风险汇总；replenishment返回正建议量清单，按建议量降序，每页10条。supply返回本月分仓向基地补货执行单的全范围汇总、满足率和分页明细；supply-current返回当前未收货完成的ASN订单汇总和明细；ASN按warehouseid收货分仓、source_warehouseid来源基地归属，关联基地出库占用并按订单创建时间分配基地与SKU共享可用库存。supply的月度履约按receive_wh归属，不能拿客户出库订单替代。operations返回本月入库、自身出货和分仓费用/过仓全范围摘要。" +
  "与分仓页面共用固定SQL、快照、周期和计算，不要求打开页面，也不改用Cube重算。追问沿用已返回的分仓编码、SKU和周期；下一页保留筛选并递增page。" +
  "该清单只是只读建议，不是正式下单；不含未保存的页面计划/草稿。结构符合率暂不计算。" +
  "库存与建议的行计数为分仓+SKU组合数；补货订单的行计数为收货分仓+执行单+行号+SKU，order_count为去重执行单数。plan_count/stock_only_count只代表是否有计划表记录，不能据此认定有无订单需求或历史发货。" +
  "target_gap_qty=可用库存+调拨中量-目标库存，正数表示富余、负数表示不足，必须保留符号，不能称为绝对值缺口。" +
  "recommended_qty是逐分仓SKU截零后的建议量之和，不得跨SKU抵扣富余或用汇总差额倒算。回答用业务名称，不照抄内部字段名。";

/** Independent dialogue uses the same date, snapshot and pagination reader as the page. */
export function registerBranchInventoryTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "gea_branch_inventory",
        description: BRANCH_INVENTORY_ROUTING,
        parameters: {
          view: {
            type: "string",
            enum: ["summary", "health", "replenishment", "supply", "supply-current", "operations"],
            description:
              "summary为库存与补货建议汇总；health为货龄汇总；replenishment为建议清单；supply为本月基地供货履约汇总及明细；supply-current为当前未收货完成ASN汇总及明细；operations为同分仓、同月份的入库、自身出货和过仓/费用摘要。",
          },
          warehouseCode: {
            type: "string",
            description: "实际分仓编码，留空为当前授权范围。",
          },
          sku: { type: "string", description: "SKU编码，沿用上一轮返回值。" },
          asOf: {
            type: "string",
            description: "读取截至日期YYYY-MM-DD；默认北京时间今天，库存取此前最新快照。",
          },
          cycleDays: {
            type: "integer",
            description: "补货周期1至365天，默认7天；显式沿用用户选定周期。",
          },
          page: { type: "integer", description: "清单页码，1起，每页10条。" },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
          presentationMeta: () => ({
            source: "GEA_CONFIGURED_SQL",
            operation: "branch-inventory",
            readonly: true,
          }),
        },
        timeoutMs: Math.max(business.config.requestTimeoutMs, 60000),
        isConcurrencySafe: () => true,
        presentCall: (args) => ({
          card: "generic",
          title: "GEA · 分仓库存与补货建议",
          rawInput: args,
        }),
        async execute(args, exec) {
          if (!exec.agent) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const session = exec.agent.id;
          await assertSessionResourceAvailable(ctx, session, exec.signal);
          const consumer = sessionConsumer(ctx, business, session);
          const access = orchestrationInventoryAccess(ctx, business, session);
          if (consumer !== "branch-inventory" && !access)
            throw Error("GEA_BRANCH_INVENTORY_NOT_AVAILABLE");
          const resource = packages.find(
            (item) =>
              item.manifest.id === "inventory-fc" &&
              item.manifest.gea?.consumerCode === "branch-inventory" &&
              item.manifest.mode !== "mock",
          );
          if (!resource || resource.manifest.sqlConfig !== "sql.config.json")
            throw Error("GEA_AGENT_RESOURCE_MISSING");
          const resourceChange = new AbortController();
          const unwatch = ctx.agentResources.watch(() => resourceChange.abort());
          const signal = AbortSignal.any([
            exec.signal,
            business.identitySignal(),
            resourceChange.signal,
            ...(access ? [access.sourceSignal] : []),
          ]);
          try {
            const page = args.page ?? 1;
            const cycleDays = args.cycleDays ?? 7;
            if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
              throw Error("INVALID_PAGE");
            if (!Number.isSafeInteger(cycleDays) || cycleDays < 1 || cycleDays > 365)
              throw Error("INVALID_CYCLE");
            const asOf =
              args.asOf ??
              new Intl.DateTimeFormat("en-CA", {
                timeZone: "Asia/Shanghai",
              }).format(new Date());
            const filters = Object.fromEntries(
              [
                ["warehouse_code", args.warehouseCode],
                ["sku", args.sku],
              ].filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === "string" && entry[1].trim() !== "",
              ),
            );
            const supply = args.view === "supply" || args.view === "supply-current";
            let result: unknown;
            try {
              const root = await realpath(resource.directory);
              const path = await realpath(resolve(root, "sql.config.json"));
              if (!path.startsWith(root + sep)) throw Error("INVALID_SQL_CONFIG_PATH");
              const raw = await readFile(path, "utf8");
              if (Buffer.byteLength(raw) > 5_000_000) throw Error("SQL_CONFIG_TOO_LARGE");
              const config = record(JSON.parse(raw));
              if (config?.schemaVersion !== 1 || config.agentId !== resource.manifest.id)
                throw Error("INVALID_AGENT_SQL_CONFIG");
              const { readConfiguredFacts } =
                await import("@cleverc2200/dsh-agent-workbench/configured-facts");
              if (args.view === "operations") {
                if (args.sku) throw Error("OPERATIONS_SKU_SCOPE_NOT_SUPPORTED");
                const read = (viewId: string, filterName: string) =>
                  readConfiguredFacts(
                    config,
                    viewId,
                    {
                      asOf,
                      filters: args.warehouseCode ? { [filterName]: args.warehouseCode } : {},
                    },
                    {
                      signal,
                      execute: (_request, call) =>
                        readConfiguredHtmlQuery(
                          resource,
                          { queryId: call.queryId, parameters: call.values },
                          business,
                          signal,
                          consumer,
                        ),
                      summaryOnly: true,
                    },
                  );
                const [movement, cost] = await Promise.all([
                  read("warehouse-outbound", "warehouse_code"),
                  read("branch-operations", "warehouse_id"),
                ]);
                result = {
                  movement,
                  cost,
                  units: {
                    inbound: "件",
                    throughput: "件",
                    outbound: "件",
                    storageFee: "元",
                    transportFee: "元",
                  },
                  scope: { warehouseCode: args.warehouseCode ?? "全部分仓", asOf },
                };
              } else {
                const detail = args.view === "replenishment" || supply;
                result = await readConfiguredFacts(
                  config,
                  supply
                    ? args.view === "supply"
                      ? "branch-supply"
                      : "orders"
                    : detail
                      ? "replenishment-suggestions"
                      : args.view === "health"
                        ? "health"
                        : "replenishment",
                  { asOf, cycleDays, page, pageSize: 10, filters },
                  {
                    signal,
                    execute: (_request, call) =>
                      readConfiguredHtmlQuery(
                        resource,
                        { queryId: call.queryId, parameters: call.values },
                        business,
                        signal,
                        consumer,
                      ),
                    summaryOnly: !detail,
                    detailsOnly: detail && !supply,
                  },
                );
              }
            } catch (error) {
              signal.throwIfAborted();
              const details = record(error);
              result = {
                success: false,
                errorCode:
                  details?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ||
                  details?.code === "ERR_MODULE_NOT_FOUND"
                    ? "GEA_WORKBENCH_UPDATE_REQUIRED"
                    : (details?.code ?? "BRANCH_INVENTORY_READ_FAILED"),
                message: error instanceof Error ? error.message : "分仓库存读取失败",
                failure: details?.failure,
                returnedColumns: details?.returnedColumns,
                rejectedColumns: details?.rejectedColumns,
              };
            }
            signal.throwIfAborted();
            await assertSessionResourceAvailable(ctx, session, signal);
            if (sessionConsumer(ctx, business, session) !== consumer)
              throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
            if (access) {
              const current = orchestrationInventoryAccess(ctx, business, session);
              if (!current || !sameCubeAccess(access, current))
                throw Error("GEA_INVENTORY_SOURCE_CHANGED");
            }
            return JSON.stringify({
              ...record(result),
              unit: args.view === "operations" ? "各指标单位见units" : "件",
              cycleDays,
              asOf,
              readonly: true,
              metricDefinitions: {
                countGrain:
                  args.view === "supply-current"
                    ? "收货分仓+ASN+行号+SKU；仅未收货完成ASN。"
                    : supply
                      ? "收货分仓+补货执行单+行号+SKU；order_count为去重执行单数。"
                      : "分仓编码+SKU组合；计数不是去重SKU数。",
                baseSupply:
                  "分仓向基地补货，按receive_wh归属；月度池按创建时间，本月满足率为逐行限额发货量合计÷同池订货量合计。当前订单按未收货完成ASN统计，关联基地出库单取占用；需求减占用后按订单创建时间分配基地与SKU共享可用库存。来源为当前加载，历史日期不构成历史状态重放。",
                operations:
                  "本月入库按已发布transactiontime业务日期统计月初至所选日期，in_qty单位件；自身出货按WMS关单日期与delivery_qty件统计，与页面本月出库同口径、按当前所选分仓统计，不代表省区全部出货；过仓及费用按warehouseid和月份精确匹配。缺日期或数量时不得把已知部分称为完整合计。",
                planPresence:
                  "plan_count/stock_only_count仅描述计划记录覆盖，不证明有无订单需求或历史发货。",
                target_gap_qty: {
                  label: "目标库存差额",
                  formula: "可用库存+调拨中量-目标库存",
                  positiveMeans: "富余",
                  negativeMeans: "不足",
                  aggregation: "保留各行差额的符号求和；不得取绝对值或称为补货缺口。",
                },
                recommended_qty: {
                  label: "建议补货量",
                  formula:
                    "以已安装页面推荐量字段为准，使用当前订单净缺口及目标库存计算，已扣减已备货及在途；逐SKU截零后再相加，禁止另按汇总差额重算",
                  aggregation: "不同SKU的富余不能抵扣缺口，不能由全范围净差额倒算。",
                },
                open_transfer_reported_qty: "调拨备单与在途合计，已含在途，不重复叠加。",
                currentOrderShortage:
                  "当前未备单订单缺货另用gea_current_shortage查询，不等于建议补货量或目标库存差额。",
              },
              note: "复用页面固定测算；不含未保存计划/草稿，不代表已提交或正式下单。结构符合率按用户要求暂不计算。",
            });
          } finally {
            unwatch();
          }
        },
      }),
    ),
  );
}

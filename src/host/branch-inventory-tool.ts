import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, sessionConsumer } from "./business-identity.ts";
import { readConfiguredHtmlQuery } from "./configured-html-query.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

export const BRANCH_INVENTORY_ROUTING =
  "分仓库存结构与补货问题直接使用gea_branch_inventory：summary返回全范围库存、可用、占用、冻结、目标及补货测算；health返回分仓货龄与超龄风险汇总；replenishment返回正建议量清单，按建议量降序，每页10条。" +
  "与分仓页面共用固定SQL、快照、周期和计算，不要求打开页面，也不改用Cube重算。追问沿用已返回的分仓编码、SKU和周期；下一页保留筛选并递增page。" +
  "该清单只是只读建议，不是正式下单；不含未保存的页面计划/草稿。结构符合率暂不计算。" +
  "所有行计数均为分仓+SKU组合数，不是去重SKU数。plan_count/stock_only_count只代表是否有计划表记录，不能据此认定有无订单需求或历史发货。" +
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
            enum: ["summary", "health", "replenishment"],
            description:
              "summary为全范围汇总；health为货龄风险汇总；replenishment为正建议量分页清单。",
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
          if (consumer !== "branch-inventory") throw Error("GEA_BRANCH_INVENTORY_NOT_AVAILABLE");
          const resource = packages.find(
            (item) =>
              item.manifest.id === "inventory-fc" &&
              item.manifest.gea?.consumerCode === consumer &&
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
              const detail = args.view === "replenishment";
              result = await readConfiguredFacts(
                config,
                detail
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
                    ),
                  summaryOnly: !detail,
                  detailsOnly: detail,
                },
              );
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
            return JSON.stringify({
              ...record(result),
              unit: "箱",
              cycleDays,
              asOf,
              readonly: true,
              metricDefinitions: {
                countGrain: "分仓编码+SKU组合；计数不是去重SKU数。",
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
                  formula: "每个分仓SKU取max(目标库存-可用库存-调拨中量,0)，再相加",
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

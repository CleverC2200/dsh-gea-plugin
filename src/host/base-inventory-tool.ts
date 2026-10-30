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

export const BASE_INVENTORY_ROUTING =
  "基地库存周转、订单满足率及同比环比统一使用gea_base_inventory，基地库存与智能编排共用已安装页面的固定SQL。按实际基地/品类及业务截止日读取；库存周转用实物库存÷近30日日均动销，满足率用同月已发货订单数量口径。" +
  "需要同比环比时compare=true；逐指标依据两期实际返回值及日期计算，不填补缺值、不编造历史。库存快照日期不对应、范围不一致、来源失败或结果为空时分别说明；未查到某一指标不能断言所有历史均不存在。历史订单为当前来源状态，不冒充历史时点还原。";

export function registerBaseInventoryTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "gea_base_inventory",
        description: BASE_INVENTORY_ROUTING,
        parameters: {
          asOf: { type: "string", description: "业务截止日期YYYY-MM-DD，默认北京时间今天。" },
          base: { type: "string", description: "实际基地名称；留空为授权范围。" },
          category: { type: "string", description: "实际品类名称；留空为各品类。" },
          compare: {
            type: "boolean",
            description: "需要同比环比时为true，实际读取上月和去年同月对应截止日。",
          },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
          presentationMeta: () => ({
            source: "GEA_CONFIGURED_SQL",
            operation: "base-safety-stock",
            readonly: true,
          }),
        },
        timeoutMs: Math.max(business.config.requestTimeoutMs, 180000),
        isConcurrencySafe: () => true,
        presentCall: (args) => ({
          card: "generic",
          title: "GEA · 基地库存、履约与同比环比",
          rawInput: args,
        }),
        async execute(args, exec) {
          if (!exec.agent) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const session = exec.agent.id;
          await assertSessionResourceAvailable(ctx, session, exec.signal);
          const consumer = sessionConsumer(ctx, business, session);
          const access = orchestrationInventoryAccess(ctx, business, session);
          if (consumer !== "base-safety-stock" && !access)
            throw Error("GEA_BASE_INVENTORY_NOT_AVAILABLE");
          const resource = packages.find(
            (item) =>
              item.manifest.id === "inventory-aqkc" &&
              item.manifest.gea?.consumerCode === "base-safety-stock" &&
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
            const asOf =
              args.asOf ??
              new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
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
              const { readBaseInventoryMetrics } =
                await import("@cleverc2200/dsh-agent-workbench/configured-facts");
              result = await readBaseInventoryMetrics(
                config,
                { asOf, base: args.base, category: args.category, compare: args.compare === true },
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
                    : (details?.code ?? "BASE_INVENTORY_READ_FAILED"),
                message: error instanceof Error ? error.message : "基地指标读取失败",
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
              readonly: true,
              metricSource: "installed-base-page-sql",
            });
          } finally {
            unwatch();
          }
        },
      }),
    ),
  );
}

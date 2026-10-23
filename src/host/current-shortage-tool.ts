import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import type { Business } from "./business.ts";
import { assertSessionResourceAvailable, sessionConsumer } from "./business-identity.ts";
import { readConfiguredHtmlQuery } from "./configured-html-query.ts";
import {
  CURRENT_SHORTAGE_DESCRIPTION,
  currentShortageResource,
} from "./current-shortage-contract.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
const quantity = (value: unknown): boolean =>
  (typeof value === "number" || typeof value === "string") &&
  String(value).trim() !== "" &&
  Number.isFinite(Number(value));

/** Failed or partially authorized queries never become a zero-valued business answer. */
export function currentShortageResult(input: unknown, view: boolean | "locations", page: number) {
  const detail = view === true;
  const locations = view === "locations";
  const result = record(input);
  if (!result) throw Error("CURRENT_SHORTAGE_RESULT_INVALID");
  if (result.success === false) return result;
  const columns = result.returnedColumns;
  const required = [
    "snapshot_date",
    "location_type",
    "demand",
    "allocated",
    "remaining",
    "available",
    "shortage",
    "invalid",
  ];
  if (detail)
    required.push("location_code", "location_name", "sku", "page_scope_total", "page_row_present");
  if (locations) required.push("location_code", "location_name", "base", "warehouse_code");
  if (
    !Array.isArray(columns) ||
    required.some((name) => !columns.includes(name)) ||
    !Array.isArray(result.rows) ||
    (Array.isArray(result.rejectedColumns) && result.rejectedColumns.length > 0)
  )
    throw Error("CURRENT_SHORTAGE_INCOMPLETE");
  const rows = result.rows.map(record);
  if (rows.some((row) => !row)) throw Error("CURRENT_SHORTAGE_RESULT_INVALID");
  const present = rows.filter(
    (row): row is Record<string, unknown> => !!row && (!detail || row.page_row_present != null),
  );
  if (
    present.some(
      (row) =>
        !quantity(row.invalid) ||
        Number(row.invalid) !== 0 ||
        !row.snapshot_date ||
        !["基地", "分仓"].includes(String(row.location_type)) ||
        ["demand", "allocated", "remaining", "available", "shortage"].some(
          (key) => !quantity(row[key]),
        ),
    )
  )
    throw Error("CURRENT_SHORTAGE_INCOMPLETE");
  let total = present.length;
  if (locations) {
    if (
      result.hasMorePages === true ||
      (result.totalRowCount != null && Number(result.totalRowCount) !== present.length) ||
      present.some((row) => !row.location_code || !row.location_name) ||
      new Set(present.map((row) => JSON.stringify([row.location_type, row.location_code]))).size !==
        present.length
    )
      throw Error("CURRENT_SHORTAGE_INCOMPLETE");
    present.sort(
      (a, b) =>
        Number(b.shortage) - Number(a.shortage) ||
        String(a.location_code).localeCompare(String(b.location_code)),
    );
  }
  if (detail) {
    const count = rows[0]?.page_scope_total;
    if (!quantity(count) || !Number.isSafeInteger(Number(count)) || Number(count) < 0)
      throw Error("CURRENT_SHORTAGE_PAGE_INVALID");
    total = Number(count);
    if (
      rows.some((row) => String(row?.page_scope_total) !== String(count)) ||
      present.length !== Math.min(10, Math.max(0, total - (page - 1) * 10))
    )
      throw Error("CURRENT_SHORTAGE_PAGE_INCOMPLETE");
  }
  return {
    ...result,
    rows: present,
    total,
    dataStatus: present.length ? "ok" : "empty",
    coverage: detail
      ? "location-sku-page"
      : locations
        ? "complete-location-ranking"
        : "complete-scope-summary",
    unit: "箱",
    temporalScope: "current-state",
    orderShortageCount: null,
    note: "当前有效未备单订单；订单→库存池与SKU→地点三层计算。remaining为逐订单截零后加总，不能用汇总需求减汇总占用替代；available仅为这些订单涉及SKU的同池可用量，不是全库存。共享库存缺口不分摊到订单；未提供受影响订单数。",
    ...(detail ? { page, pageSize: 10, hasMorePages: page * 10 < total } : {}),
  };
}

/** Only trusted installed IDs are resolved; no arbitrary SQL or caller-selected identity is exposed. */
export function registerCurrentShortageTool(
  ctx: Context,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "gea_current_shortage",
        description: CURRENT_SHORTAGE_DESCRIPTION,
        parameters: {
          view: {
            type: "string",
            enum: ["summary", "locations", "detail"],
            description:
              "默认summary为完整范围汇总；locations按当前缺货量降序返回完整地点排行；detail为地点+SKU分页。",
          },
          base: {
            type: "string",
            description: "基地名称，如郑州；省略为当前Agent授权范围。",
          },
          warehouseCode: {
            type: "string",
            description: "分仓编码；不填仓库名称。",
          },
          sku: { type: "string", description: "商品编码。" },
          category: { type: "string", description: "源中的产品大类名称。" },
          page: { type: "integer", description: "detail页码，1起，每页10条。" },
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
          presentationMeta: () => ({
            source: "GEA_CONFIGURED_SQL",
            operation: "current-shortage",
            readonly: true,
          }),
        },
        timeoutMs: Math.max(business.config.requestTimeoutMs, 60000),
        isConcurrencySafe: () => true,
        presentCall: (args) => ({
          card: "generic",
          title: "GEA · 当前订单与缺货",
          rawInput: args,
        }),
        async execute(args, exec) {
          if (!exec.agent) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const session = exec.agent.id;
          await assertSessionResourceAvailable(ctx, session, exec.signal);
          const consumer = sessionConsumer(ctx, business, session);
          const id = currentShortageResource(consumer);
          if (!id) throw Error("GEA_CURRENT_SHORTAGE_NOT_AVAILABLE");
          const resource = packages.find(
            (item) =>
              item.manifest.id === id &&
              item.manifest.gea?.consumerCode === consumer &&
              item.manifest.mode !== "mock",
          );
          if (!resource) throw Error("GEA_AGENT_RESOURCE_MISSING");
          const signal = AbortSignal.any([exec.signal, business.identitySignal()]);
          const detail = args.view === "detail",
            locations = args.view === "locations",
            page = args.page ?? 1;
          if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
            throw Error("CURRENT_SHORTAGE_PAGE_INVALID");
          const parameters = {
            base: args.base ?? null,
            warehouse_code: args.warehouseCode ?? null,
            sku: args.sku ?? null,
            category: args.category ?? null,
            ...(detail ? { page_size: 10, offset: (page - 1) * 10 } : {}),
          };
          const result = await readConfiguredHtmlQuery(
            resource,
            {
              queryId: detail
                ? "current-shortage.detail"
                : locations
                  ? "current-shortage.locations"
                  : "current-shortage.summary",
              parameters,
            },
            business,
            signal,
          );
          signal.throwIfAborted();
          await assertSessionResourceAvailable(ctx, session, signal);
          if (sessionConsumer(ctx, business, session) !== consumer)
            throw Error("GEA_BUSINESS_IDENTITY_CHANGED");
          return JSON.stringify(
            currentShortageResult(result, locations ? "locations" : detail, page),
          );
        },
      }),
    ),
  );
}

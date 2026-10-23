import {
  decodeSalesPlanResult,
  salesPlanCustomer,
  salesPlanDimensionsPath,
  salesPlanQueryValue,
  salesPlanWireKey,
} from "./sales-plan-wire.ts";
import { createGeaSqlDatabase, type ConfiguredSqlRequest } from "../html-sql.ts";
import {
  salesPlanDraftMatches,
  salesPlanDraftSnapshot,
  salesPlanLocalDraftValid,
  type SalesPlanLocalDraft,
  type SalesPlanApprovalRole,
  type ApprovalStageId,
  type GeaSalesPlanDetail,
} from "@cleverc2200/dsh-agent-workbench/sales-plan";
import * as salesPlan from "@cleverc2200/dsh-agent-workbench/sales-plan";
import { SalesPlanTransactions } from "./sales-plan-transactions.ts";
import { object, text, keys } from "./payload.ts";
export { object } from "./payload.ts";
import { GatewayRequests } from "./gateway-requests.ts";
import { navigationAgents, navigationDomains } from "./navigation-catalog.ts";
import type { BusinessNavigationCatalog } from "@cleverc2200/dsh-agent-workbench/client";
import { avatarUrl } from "./avatar.ts";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
/**
 * Host 侧业务门面：集中维护 GEA 身份、查询选择、权限校验和只读快照。
 * 浏览器只能提交资源标识与用户意图，凭证、来源数据和最终写入校验都留在这里。
 */
import { resolveInventoryRoles, type InventoryRoleProfile } from "./inventory-role.ts";
import { prepareGatewayLaunch } from "./html-gateway.ts";
import { prepareGatewayMcp } from "./gateway-mcp.ts";
import { readHtmlQuery } from "../html-query.ts";
import { createSqlReadLimit } from "../shared/sql-read-limit.js";
import { createSalesReadonly, SalesReadonlyError } from "../shared/sales-readonly.js";
import { probeTables, withDefaultPaging } from "./plugin-query.ts";
import { openGatewayMcp, type GatewayMcpClient } from "./gateway-mcp-client.ts";
import { currentPageEnvelope, pageIdentityFresh, type PageIdentity } from "./page-identity.ts";
import { workbenchPresence, type WorkbenchPresence } from "./workbench-presence.ts";
import { normalizeSurface, type WorkbenchSurface } from "./workbench-surface.ts";
import { compressForModel } from "@cleverc2200/dsh-agent-workbench/page-interaction/payload-budget";
import { aggregateSalesPlans } from "./sales-plan-aggregate.ts";

/** 受管表列清单的缓存时长：一次探查够用一段时间，又不至于一直用旧结构。 */
const PLUGIN_SCHEMA_TTL_MS = 10 * 60_000;

import {
  validateServiceAccounts,
  serviceAccountReady,
  type ServiceAccounts,
} from "./service-account.ts";
import { readSalesPlanWorkflowConfig } from "./workflow-config.ts";
import { createHash, randomUUID } from "node:crypto";
import { brandString, type Branded } from "@deepseek-ai/dsh-brand";
import QRCode from "qrcode";
import { resolveEnvironments } from "../shared/environments.js";
import { Decimal } from "decimal.js";
import { transportSignal } from "../shared/transport-signal.ts";
import {
  notificationPage,
  notificationDetail,
} from "@cleverc2200/dsh-agent-workbench/notifications";
import { resolveNavigationTarget, type NavigationInput } from "./navigation-target.ts";
import { GeaResponseError, geaResponseError } from "../shared/gea-error.js";
import { modelHttpError } from "../shared/model-http-error.ts";
import { ApiLogBatch, parseApiBatchRequest } from "./api-log-batch.ts";
import { DebugRunCoordinator } from "./debug-run.ts";
import { GeaApiLogCenter, type ApiLogSnapshot } from "./api-log.ts";

import { createCapabilityRegistry, type CapabilityRegistry } from "../capability/registry.ts";
import { workbenchContract, effectRank, type CapabilityEffect } from "../capability/contract.ts";
import { sharedAgentCapability, WORKBENCH_AGENT_CODE } from "./shared-agent.ts";

export type QueryId = Branded<"gea-query">;
export type PreviewId = Branded<"gea-preview">;
export type Row = Record<string, string | number | boolean | null>;

export interface Deployment {
  /** Optional fixed-run SQL allowance; zero refuses before credentials and transport. */
  sqlReadLimit?: {
    consumerCode: string;
    maxRequests: number;
    maxPagesPerQuery: number;
    maxRowsPerQuery: number;
  };
  /** The native sales capability uses the same enabled declaration as installed HTML capabilities. */
  workbenchCapability?: {
    enabled?: boolean;
    readonlyValidation?: {
      maxRequests: number;
      periods: number;
      list: number;
      detail: number;
      versionSkus: number;
      workflowSql: number;
      maxWorkflowRows: number;
      metadata: number;
    };
  };
  serviceAccounts?: ServiceAccounts;
  geaBaseUrl: string;
  environment?: "production" | "test";
  geaEnvironments?: { production: string; test: string };
  pageSize: number;
  periodPageSize: number;
  requestTimeoutMs: number;
  mcpRequestTimeoutMs?: number;
  mcpMaxResponseBytes?: number;
  /** Environment-specific Cube MCP source; absence keeps the existing deployment's routing. */
  cubeMcpCodes?: { production?: string; test?: string };
  modelRequestTimeoutMs: number;
  maxSnapshotBytes: number;
  runtimeDir: string;
  analysisMode: "receipt" | "model";
  analysisModel: string;
  analysisAgentCode: string;
  analysisSource: "gea" | "direct" | "receipt";
  inputByteBudget: number;
  /**
   * 问答侧是否允许调用受管只读 SQL（`/ai/gateway/sql/execute`）。
   * 默认关闭：问答取数只走模块 MCP + 页面证据（页面自己的查询不受影响）。
   */
  agentSqlRead?: boolean;
  /** 将当前页快照交给 DSH 一次性子 Agent 压缩；测试/旧宿主可显式关闭。 */
  visibleContextSubagent?: boolean;
}
export interface Page {
  queryId: QueryId;
  source: "GEA_LIVE_READONLY";
  sourceUrl: string;
  fetchedAt: string;
  tenantId: string;
  query: Record<string, string>;
  current: number;
  size: number;
  total: number;
  records: Row[];
}
export interface Preview {
  previewId: PreviewId;
  snapshotHash: string;
  bytes: number;
  limitBytes: number;
  snapshot: object;
  prompt: string;
}
export interface Collection {
  records: Row[];
  total: number | null;
  returned: number;
  coverage: "complete" | "partial" | "unknown";
  fetchedAt: string;
  sourceUrl: string;
  missingFields: Record<string, string[]>;
}
export interface Detail {
  planId: string;
  scope: "current-plan";
  currentVersion: Row | null;
  fetchedAt: string;
  sourceUrl: string;
  missing: string[];
}

/** 浏览器当前可见页的最小只读投影，不作为 GEA 写操作依据。 */
export interface VisibleWorkbenchContext {
  format: "gea-workbench-visible-v1";
  sequence: number;
  view: "regional-approval";
  scope: {
    month: string;
    planType: string;
    approvalStage: string;
    dimension: string | null;
  };
  visibleRows: Array<Record<string, string | number | null>>;
  selectedPlanIds: string[];
  expandedPlanIds: string[];
  expandedFields: Array<{
    id: string;
    label: string;
    value: string;
    editable: boolean;
  }>;
  pagination: { page: number; pageSize: number; total: number };
  evidence: {
    source: "gea-user-session";
    completeness: "paged-queue";
    queryState: "success";
    dataVersion: string;
  };
}

export type GeaModelRoute = {
  baseUrl: string;
  secret: string;
  agentCode: string;
  models: string[];
  names: Record<string, string>;
  contextWindows?: Record<string, number>;
};

const planFields = [
  "planId",
  "versionId",
  "seq",
  "periodId",
  "planTypeCode",
  "dealerCode",
  "dealerName",
  "orgCode",
  "orgName",
  "provinceCode",
  "provinceName",
  "areaCode",
  "areaName",
  "regionName",
  "provinceRegionName",
  "salesGroupName",
  "baseName",
  "status",
  "returnReason",
  "targetQty",
  "targetAmount",
  "currentQty",
  "currentAmount",
  "skuCount",
  "submitter",
  "submitTime",
  "finishedAt",
  "updatedAt",
];
const versionFields = [
  "id",
  ...planFields.filter(
    (key) => !["planId", "versionId", "currentQty", "currentAmount", "skuCount"].includes(key),
  ),
  "planId",
  "effective",
];
const skuFields = [
  "id",
  "versionId",
  "skuCode",
  "materialDescription",
  "materialDesc",
  "materialName",
  "skuname",
  "skuName",
  "productName",
  "productCategName",
  "baseQty",
  "qty",
  "price",
  "amt",
  "amtBase",
  "regionConfirmedQty",
  "regionConfirmedAmount",
  "provinceConfirmedQty",
  "provinceConfirmedAmount",
  "areaConfirmedQty",
  "areaConfirmedAmount",
  "categoryConfirmedQty",
  "categoryConfirmedAmount",
];
/** GEA 只在部分计划回填物料名称；同一 SKU 编码在别处回填过的名称可以复用。 */
const materialNameFields = [
  "materialDescription",
  "materialDesc",
  "materialName",
  "skuName",
  "skuname",
  "productName",
] as const;
const materialNameLimit = 5000;
class MaterialNameIndex {
  private readonly names = new Map<string, string>();

  /** 先取本记录自带的权威字段，缺失时再回落到同编码已见过的名称。 */
  apply(records: Array<Record<string, unknown>>): void {
    for (const record of records) {
      const code = record.skuCode == null ? undefined : String(record.skuCode);
      const provided = materialNameFields
        .map((key) => record[key])
        .find((value): value is string => typeof value === "string" && value.trim() !== "");
      if (provided !== undefined && code !== undefined) this.remember(code, provided.trim());
      const name = provided?.trim() ?? (code === undefined ? undefined : this.names.get(code));
      if (name !== undefined && record.materialDescription !== name)
        record.materialDescription = name;
    }
  }

  private remember(code: string, name: string): void {
    if (this.names.get(code) === name) return;
    if (this.names.size >= materialNameLimit) this.names.clear();
    this.names.set(code, name);
  }
}
const exactNumber = /Id$|Code$|Qty$|Amount$|^(id|qty|price|amt|amtBase|qtyDelta|amountDelta)$/;

/** 在 JavaScript 进行舍入前保留小数词法形式和不透明标识。 */
function parseJson(text: string, salesDimensions = false): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: { source?: string }) => {
    if (salesDimensions && key === "cust_code" && value !== null) {
      if (typeof value !== "number" || !context?.source) throw new Error("GEA_INVALID_CUSTOMER");
      return salesPlanCustomer(context.source);
    }
    if (typeof value === "number" && exactNumber.test(key)) {
      if (!context?.source) throw new Error("EXACT_JSON_RUNTIME_REQUIRED");
      return context.source;
    }
    return value;
  });
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function businessValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

/** 将内部只读快照投影成会话中可见的业务资料，避免暴露接口和字段实现。 */
function businessBrief(snapshot: object): string {
  const root = plainObject(snapshot);
  const records = Array.isArray(root.records)
    ? root.records
    : root.record
      ? [{ record: root.record }]
      : [];
  const lines = records.map((candidate, index) => {
    const entry = plainObject(candidate);
    const detail = plainObject(entry.detail);
    const current = plainObject(detail.currentVersion);
    const row = Object.keys(current).length ? current : plainObject(entry.record);
    const field = (...names: string[]) => {
      for (const name of names) {
        const value = businessValue(row[name] ?? entry[name]);
        if (value !== undefined) return value;
      }
      return "未提供";
    };
    const area = [field("provinceName"), field("regionName")]
      .filter((value) => value !== "未提供")
      .join(" / ");
    return [
      `计划 ${index + 1}`,
      `编号：${field("planId")}`,
      `经销商：${field("dealerName")}`,
      `区域：${area || "未提供"}`,
      `周期：${field("periodId", "periodMonth")}`,
      `数量（目标 / 当前）：${field("targetQty")} / ${field("currentQty")}`,
      `金额（目标 / 当前）：${field("targetAmount")} / ${field("currentAmount")}`,
    ].join("；");
  });
  return [
    "请根据以下销售计划资料，向业务同事给出简洁说明。",
    "先说本次结果和必要依据；说明影响判断的范围或缺口，有实际价值时再给下一步。仅在已核对范围内说明暂未发现明显异常。",
    "默认不倾倒系统字段、接口地址、哈希、JSON、内部状态码或计算中间过程；用业务语言说明实际覆盖范围和重要数据时间，不复述本段原文。",
    "仅在用户明确要求核对明细、审计依据或技术排查时，才补充必要的业务口径说明。不得执行审批、保存、提交或写回。",
    "",
    `业务资料（共 ${lines.length} 条计划）：`,
    ...(lines.length ? lines : ["未取得可供说明的计划资料。"]),
  ].join("\n");
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("INVALID_QUERY");
  return value;
}
/** 销售计划各 kind 允许的查询字段。 */
const PLAN_QUERY_FIELDS: Record<string, string[]> = {
  aggregate: [
    "periodId",
    "orderType",
    "planTypeCode",
    "dealerCode",
    "areaCode",
    "provinceCode",
    "orgCode",
    "baseName",
    "status",
  ],
  periods: ["periodMonth", "planType", "pageNo", "pageSize"],
  list: [
    "orderType",
    "periodId",
    "planTypeCode",
    "dealerCode",
    "areaCode",
    "provinceCode",
    "orgCode",
    "baseName",
    "status",
    "pageNo",
    "pageSize",
    "versionIds",
    "summaryOnly",
    "statuses",
    "approvalRole",
  ],
  detail: ["planId", "orderType", "approvalRole"],
  versions: ["planId"],
  logs: ["planId", "pageNo", "pageSize"],
  versionSkus: ["versionId", "pageNo", "pageSize", "offset"],
  compare: ["planId", "fromVersionId", "toVersionId"],
};

/**
 * 销售计划查询的形状校验 + 容错。
 *
 * 分页参数对不分页的 kind（detail/versions/compare…）没有意义，但也不算错：线上实测模型
 * 会给 detail 顺手带上 pageSize，严格拒绝等于白烧一轮。同理，模型常把 detail 的 planId
 * 顺手带进 versionSkus（session-2bb0684f 就因为这个多余字段连撞 5 次 INVALID_QUERY）。
 * 这两类"多余但无害"的字段直接丢掉继续跑；真正用错的 key（例如给 detail 传 versionId）
 * 仍然报错，并给出该怎么改。
 *
 * @param kind 查询种类（periods/list/detail/versions/logs/versionSkus/compare）。
 * @param query 模型给的查询对象；返回的是"过滤后的有效字段"。
 */
export function normalizePlanQuery(
  kind: string,
  query: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = PLAN_QUERY_FIELDS;
  if (!Object.hasOwn(allowed, kind)) throw new Error("INVALID_QUERY");
  const ignoredPaging = Object.keys(query).filter(
    (key) => (key === "pageNo" || key === "pageSize") && !allowed[kind].includes(key),
  );
  // 只在"必需的那个 id 已经在了"时才忽略多余字段，避免把"拿 planId 当版本号"这种真错误吞掉。
  const benignExtras: Record<string, string[]> = { versionSkus: ["planId"] };
  const ignoredBenign =
    kind === "versionSkus" && query.versionId != null
      ? (benignExtras[kind] ?? []).filter((key) => query[key] !== undefined)
      : [];
  const ignoredKeys = [...ignoredPaging, ...ignoredBenign];
  const effective =
    ignoredKeys.length === 0
      ? query
      : Object.fromEntries(Object.entries(query).filter(([key]) => !ignoredKeys.includes(key)));
  const unsupported = Object.keys(effective).filter((key) => !allowed[kind].includes(key));
  if (unsupported.length) {
    // 这些提示直接决定模型下一轮能不能纠正，不要只说"参数不支持"。
    const guidance =
      kind === "list"
        ? " For a month, call kind=periods with periodMonth (YYYY-MM) first, then pass the returned periodId together with planTypeCode from that result; never invent periodId or planTypeCode."
        : kind === "detail"
          ? " kind=detail takes planId from kind=list or kind=versions output, plus optional orderType; never pass versionId here and never invent an id."
          : kind === "versionSkus"
            ? " kind=versionSkus takes only versionId (detail 的 currentVersion.id，或 list 的 versionId) plus initial pageNo/pageSize or the returned nextQuery; planId is not needed."
            : kind === "periods"
              ? " periodMonth must be YYYY-MM, for example 2026-09."
              : "";
    throw new Error(
      `INVALID_QUERY: kind=${kind} accepts only ${allowed[kind].join(", ")}.${guidance}`,
    );
  }
  return effective;
}

function versionNumber(value: unknown): number {
  if (typeof value === "number") return integer(value, 0);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("INVALID_PAYLOAD");
}
function project(value: unknown, fields: readonly string[]): Row {
  const row = object(value);
  return Object.fromEntries(
    fields
      .filter((key) => row[key] != null || (row[key] === null && salesPlanWireKey(key) !== key))
      .map((key) => {
        const v = row[key];
        if (v === null) return [key, null];
        if (!["string", "number", "boolean"].includes(typeof v))
          throw new Error("GEA_INVALID_RECORD");
        return [key, v as string | number | boolean];
      }),
  );
}

/**
 * 按字节预算裁剪行数组，保留尽量多的完整行。
 *
 * 上游的 detail 会把整条计划的全部 SKU 一起返回，直接交给模型会超过按上下文
 * 算出的输入预算（SNAPSHOT_TOO_LARGE）。这里按预算截断，并让调用方把“被丢弃的
 * 行数”明确写给模型，避免它把子集当成全部。
 * @param rows - 已投影的行。
 * @param budgetBytes - 该数组可占用的字节数。
 * @returns 保留的行与被丢弃的行数。
 */
function capRows<T extends Record<string, unknown>>(
  rows: readonly T[],
  budgetBytes: number,
): { rows: T[]; omitted: number } {
  const kept: T[] = [];
  let used = 2;
  for (const row of rows) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (used + size > budgetBytes) break;
    kept.push(row);
    used += size;
  }
  return { rows: kept, omitted: rows.length - kept.length };
}

function visibleWorkbenchText(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new Error("INVALID_WORKBENCH_CONTEXT");
  return value;
}

function validateVisibleWorkbenchContext(
  payload: Record<string, unknown>,
): VisibleWorkbenchContext {
  keys(payload, [
    "format",
    "sequence",
    "view",
    "scope",
    "visibleRows",
    "selectedPlanIds",
    "expandedPlanIds",
    "expandedFields",
    "pagination",
    "evidence",
  ]);
  if (payload.format !== "gea-workbench-visible-v1" || payload.view !== "regional-approval")
    throw new Error("INVALID_WORKBENCH_CONTEXT");
  const scope = object(payload.scope);
  keys(scope, ["month", "planType", "approvalStage", "dimension"]);
  const pagination = object(payload.pagination);
  keys(pagination, ["page", "pageSize", "total"]);
  const evidence = object(payload.evidence);
  keys(evidence, ["source", "completeness", "queryState", "dataVersion"]);
  if (
    evidence.source !== "gea-user-session" ||
    evidence.completeness !== "paged-queue" ||
    evidence.queryState !== "success"
  )
    throw new Error("INVALID_WORKBENCH_CONTEXT");
  if (!Array.isArray(payload.visibleRows) || payload.visibleRows.length > 100)
    throw new Error("INVALID_WORKBENCH_CONTEXT");
  const visibleRows = payload.visibleRows.map((candidate) => {
    const row = object(candidate);
    if (Object.keys(row).length > 20) throw new Error("INVALID_WORKBENCH_CONTEXT");
    return Object.fromEntries(
      Object.entries(row).map(([key, value]) => {
        if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) throw new Error("INVALID_WORKBENCH_CONTEXT");
        if (value !== null && typeof value !== "string" && typeof value !== "number")
          throw new Error("INVALID_WORKBENCH_CONTEXT");
        if (typeof value === "string" && value.length > 512)
          throw new Error("INVALID_WORKBENCH_CONTEXT");
        if (typeof value === "number" && !Number.isFinite(value))
          throw new Error("INVALID_WORKBENCH_CONTEXT");
        return [key, value] as const;
      }),
    );
  });
  if (
    !Array.isArray(payload.selectedPlanIds) ||
    payload.selectedPlanIds.length > visibleRows.length ||
    payload.selectedPlanIds.some((id) => typeof id !== "string" || id.length > 256)
  )
    throw new Error("INVALID_WORKBENCH_CONTEXT");
  // 展开状态是老客户端可能不带的新字段：缺失按空处理，带了就严格校验。
  const expandedPlanIds = payload.expandedPlanIds ?? [];
  if (
    !Array.isArray(expandedPlanIds) ||
    expandedPlanIds.length > 100 ||
    expandedPlanIds.some((id) => typeof id !== "string" || id.length > 256)
  )
    throw new Error("INVALID_WORKBENCH_CONTEXT");
  const expandedFields = payload.expandedFields ?? [];
  if (!Array.isArray(expandedFields) || expandedFields.length > 120)
    throw new Error("INVALID_WORKBENCH_CONTEXT");
  const normalizedFields = expandedFields.map((candidate) => {
    const field = object(candidate);
    keys(field, ["id", "label", "value", "editable"]);
    if (typeof field.editable !== "boolean") throw new Error("INVALID_WORKBENCH_CONTEXT");
    return {
      id: visibleWorkbenchText(field.id),
      label: visibleWorkbenchText(field.label),
      value: visibleWorkbenchText(field.value),
      editable: field.editable,
    };
  });
  return {
    format: "gea-workbench-visible-v1",
    sequence: integer(payload.sequence, 1),
    view: "regional-approval",
    scope: {
      month: visibleWorkbenchText(scope.month),
      planType: visibleWorkbenchText(scope.planType),
      approvalStage: visibleWorkbenchText(scope.approvalStage),
      dimension: scope.dimension === null ? null : visibleWorkbenchText(scope.dimension),
    },
    visibleRows,
    selectedPlanIds: [...new Set(payload.selectedPlanIds)],
    expandedPlanIds: [...new Set(expandedPlanIds)],
    expandedFields: normalizedFields,
    pagination: {
      page: integer(pagination.page, 1),
      pageSize: integer(pagination.pageSize, 1, 100),
      total: integer(pagination.total, 0),
    },
    evidence: {
      source: "gea-user-session",
      completeness: "paged-queue",
      queryState: "success",
      dataVersion: visibleWorkbenchText(evidence.dataVersion),
    },
  };
}
/** 运算前校验来源小数；任何无效记录都不能被静默跳过。 */
function decimalSources(
  values: unknown[],
): { values: Decimal[] } | { missing: "decimal-source-unavailable" | "decimal-range-exceeded" } {
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ||
        value.length > 1024,
    )
  )
    return { missing: "decimal-source-unavailable" };
  const Exact = Decimal.clone({ precision: 4096 });
  const parsed = values.map((value) => new Exact(String(value)));
  if (parsed.some((value) => !value.isFinite() || Math.abs(value.e) > 1024))
    return { missing: "decimal-range-exceeded" };
  return { values: parsed };
}
function difference(row: Row, target: string, current: string) {
  const decimals = decimalSources([row[target], row[current]]);
  if ("missing" in decimals) return { basis: [target, current], missing: decimals.missing };
  return {
    basis: [target, current],
    operation: "target-minus-current",
    value: decimals.values[0].minus(decimals.values[1]).toFixed(),
  };
}
/** 独立汇总完整且已校验的 SKU 集合，不改写 GEA 版本中的来源字段。 */
function skuTotal(rows: Record<string, unknown>[], field: "qty" | "amt") {
  const basis = `detail.skus[].${field}`;
  const recordCount = rows.length;
  const decimals = decimalSources(rows.map((row) => row[field]));
  if ("missing" in decimals)
    return { basis, operation: "sum", recordCount, missing: decimals.missing };
  return {
    basis,
    operation: "sum",
    recordCount,
    value: decimals.values.length
      ? decimals.values.reduce((total, value) => total.plus(value)).toFixed()
      : "0",
  };
}

/** 由此处持有凭证和已读取记录；调用方只能选择标识，不能提供业务数据。 */
export class Business {
  // epoch 绑定登录身份，queryEpoch 绑定当前查询；任一边界变化都会取消旧请求并丢弃旧选择。
  private readonly identityListeners = new Set<() => void>();

  /** 观察登录身份变化，但不暴露登录凭证。 */
  watchIdentity(listener: () => void): () => void {
    this.identityListeners.add(listener);
    return () => {
      this.identityListeners.delete(listener);
    };
  }

  private notifyIdentity(): void {
    for (const listener of this.identityListeners) {
      try {
        listener();
      } catch {
        // 单个消费者不能破坏登录或退出登录流程。
      }
    }
  }

  private auth?: {
    token: string;
    tenantId: string;
    name: string;
    id: string;
    username: string;
    avatar?: string;
    permissionCodes?: string[];
    roles?: SalesPlanApprovalRole[];
  };
  private qr?: { id: string; loginId: string; createdAt: number };
  private epoch = new AbortController();
  private pageIdentityGeneration = randomUUID();
  private queryEpoch = new AbortController();
  private page?: Page;
  private preview?: Preview;
  private details = new Map<string, Detail>();
  private versionsByPlan = new Map<string, Collection>();
  private skusByVersion = new Map<string, Collection>();
  private readonly visibleWorkbenchContexts = new Map<
    string,
    { sequence: number; receivedAt: string; context: VisibleWorkbenchContext }
  >();
  /**
   * 每个对话当前打开的业务页身份（HTML 插件页按最近一次页面活动刷新）。
   * 见 page-identity.ts：这是"当前页是谁"的唯一权威来源。
   */
  private readonly pageIdentities = new Map<string, PageIdentity>();
  /**
   * 「这个对话现在停在哪一页菜单」的状态字段：默认主对话，用户点业务菜单时前端上报。
   * 见 workbench-surface.ts：这是"在不在工作台"的唯一权威来源。
   */
  private readonly surfaces = new Map<string, WorkbenchSurface>();
  private requests = new Map<string, AbortController>();
  private readonly materialNames = new MaterialNameIndex();
  private modelRoutes = new Map<string, GeaModelRoute>();
  private readonly pluginDelegations = new Map<
    string,
    { authToken: string; delegationToken: string }
  >();
  /** Last verified customer-inventory scope for the current login only. */
  private customerInventoryAccess?: { authToken: string; profile: InventoryRoleProfile };
  /** 受管表列清单的短缓存：同一张表不重复探查。 */
  private readonly pluginSchemaCache = new Map<string, { at: number; columns: string[] }>();
  private capabilities: CapabilityRegistry;
  private loginExpired = false;
  readonly runId = randomUUID();
  private selectedBase: string;
  private environment: "production" | "test";
  private readonly environments: Record<string, string>;
  private readonly apiLog: GeaApiLogCenter;
  private readonly debugRuns = new DebugRunCoordinator();
  private readonly apiLogBatch: ApiLogBatch;
  private readonly gatewayRequests: GatewayRequests;
  private readonly salesTransactions: SalesPlanTransactions;
  get base(): string {
    return this.selectedBase;
  }

  /** 登录环境变化时取消推理和查询。 */
  identitySignal(): AbortSignal {
    return this.epoch.signal;
  }

  /** Opaque authority for browser page associations; changes on logout and environment switches. */
  pageSessionScope(): string | undefined {
    return this.auth ? `${this.runId}:${this.pageIdentityGeneration}` : undefined;
  }

  /**
   * Safe browser projection of the customer-inventory authorization receipt.
   * It is available only after the gateway has verified the current delegated
   * session; delegation credentials and raw receipts never leave the Host.
   */
  customerInventoryIdentity(): InventoryRoleProfile | null {
    const auth = this.auth;
    const access = this.customerInventoryAccess;
    return auth && access?.authToken === auth.token ? access.profile : null;
  }

  /** 选择已配置环境，并立即丢弃凭证、二维码和预览。 */
  selectEnvironment(payload: Record<string, unknown>) {
    keys(payload, ["environment"]);
    const environment = text(payload.environment);
    if (!Object.hasOwn(this.environments, environment)) throw new Error("INVALID_GEA_ENVIRONMENT");
    this.clearLogin();
    this.environment = environment as "production" | "test";
    this.selectedBase = this.environments[environment];
    return this.status();
  }

  /** 结束当前 GEA 登录，并使所有绑定旧身份的进行中任务失效。 */
  logout(payload: Record<string, unknown>) {
    keys(payload, []);
    this.clearLogin();
    return this.status();
  }

  private readonly sqlReadLimit: ReturnType<typeof createSqlReadLimit>;
  private readonly salesReadonly: ReturnType<typeof createSalesReadonly>;

  constructor(readonly config: Deployment) {
    this.sqlReadLimit = createSqlReadLimit(config.sqlReadLimit);
    this.salesReadonly = createSalesReadonly(
      config.workbenchCapability?.readonlyValidation,
      config.analysisAgentCode,
      () => this.base,
    );
    this.capabilities = createCapabilityRegistry([
      sharedAgentCapability,
      workbenchContract({
        surface: "gea-workbench",
        pageIds: ["gea-workbench"],
        ...config.workbenchCapability,
      }),
    ]);
    validateServiceAccounts(config.serviceAccounts);
    const resolved = resolveEnvironments(config);
    this.selectedBase = resolved.baseUrl;
    this.environment = resolved.environment as "production" | "test";
    this.environments = resolved.environments;
    this.apiLog = new GeaApiLogCenter(
      () => this.environment,
      undefined,
      undefined,
      this.salesReadonly?.beforeRequest,
      (url, headers, caller) => {
        const auth = this.auth;
        const epoch = this.epoch.signal;
        const token = headers.get("X-Access-Token") ?? new URL(url).searchParams.get("token");
        const tenant = headers.get("X-Tenant-Id");
        const owned =
          !!auth &&
          url.startsWith(this.base + "/") &&
          token === auth.token &&
          (tenant === null || tenant === auth.tenantId);
        return (response) => {
          if (
            owned &&
            response.status === 401 &&
            this.auth === auth &&
            this.epoch.signal === epoch &&
            !epoch.aborted &&
            !caller?.aborted
          )
            this.clearLogin(true);
        };
      },
      () => this.pageIdentityGeneration,
    );
    this.apiLogBatch = new ApiLogBatch(this.apiLog, this.debugRuns);
    this.gatewayRequests = new GatewayRequests({
      scope: () => ({ base: this.base, signal: this.epoch.signal }),
      timeoutMs: config.requestTimeoutMs,
      fetch: (url, init, purpose) => this.apiLog.fetch(url, init, purpose),
      expire: (identity) => {
        if (identity && this.auth?.token === identity.token) this.clearLogin(true);
      },
      decode: (raw, path) => {
        if (path === "/aiportal/agent/market" || path === "/sys/dict/getDictItems/business_domain")
          return object(JSON.parse(raw));
        const data = object(parseJson(raw, salesPlanDimensionsPath(path)));
        return { ...data, result: decodeSalesPlanResult(path, data.result) };
      },
    });
    this.salesTransactions = new SalesPlanTransactions({
      scope: (effect) => {
        this.assertExecutionAllowed(this.config.analysisAgentCode, effect);
        return {
          auth: this.authenticated(),
          base: this.base,
          signal: this.epoch.signal,
          serviceAccount: this.config.serviceAccounts?.[this.environment],
        };
      },
      query: (payload, signal) => this.workbenchQuery(payload, signal),
      workflow: (signal) => this.workflowConfig({}, signal),
      permissions: (signal) => this.refreshPermissions(signal),
      fetch: this.apiLog.fetch,
      expire: (identity) => {
        if (this.auth === identity) this.clearLogin(true);
      },
      decode: parseJson,
      timeoutMs: config.requestTimeoutMs,
      periodPageSize: config.periodPageSize,
    });
  }

  /** 仅桌面拥有者可用：凭证通过私有回环通道传递，绝不经浏览器 RPC。 */
  desktopLoginSnapshot(): unknown {
    return this.auth
      ? {
          schema: 1,
          environment: this.environment,
          base: this.base,
          auth: { ...this.auth },
        }
      : null;
  }
  persistentLoginSnapshot(): unknown {
    return this.desktopLoginSnapshot();
  }
  restorePersistentLogin(value: unknown): void {
    this.restoreDesktopLogin(value);
  }
  restoreDesktopLogin(value: unknown): void {
    const saved = object(value);
    if (
      saved.schema !== 1 ||
      typeof saved.environment !== "string" ||
      this.environments[saved.environment] !== saved.base
    )
      throw Error("DESKTOP_LOGIN_SCOPE_MISMATCH");
    const auth = object(saved.auth);
    if (
      typeof auth.token !== "string" ||
      !auth.token ||
      auth.token.length > 16384 ||
      typeof auth.tenantId !== "string" ||
      !/^\d+$/.test(auth.tenantId)
    )
      throw Error("DESKTOP_LOGIN_INVALID");
    this.clearLogin();
    this.environment = saved.environment as "production" | "test";
    this.selectedBase = this.environments[saved.environment];
    this.auth = {
      token: auth.token,
      tenantId: auth.tenantId,
      name: text(auth.name),
      id: text(auth.id),
      username: text(auth.username),
      avatar: avatarUrl(auth.avatar, this.base),
    };
    this.notifyIdentity();
  }

  /** 释放未完成请求，并清除进程内认证状态。 */
  dispose(): void {
    this.clearLogin();
    this.epoch.abort();
    this.queryEpoch.abort();
  }

  private clearQuery(): void {
    this.queryEpoch.abort();
    this.queryEpoch = new AbortController();
    this.page = undefined;
    this.preview = undefined;
    this.details.clear();
    this.versionsByPlan.clear();
    this.skusByVersion.clear();
    // 注意：这里不能清 visibleWorkbenchContexts。
    // 工作台页面自己的每次实时查询都会走 workbench/query -> clearQuery()，
    // 一旦在这里清掉，页面刚同步上来的可见页快照会立刻被自己的查询抹掉，
    // 模型再读就是"不在工作台"。可见页快照按会话独立存放，
    // 只在离开页面（context=null）或身份变化（clearLogin）时失效。
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
  }
  /** 清理查询缓存和未完成请求，避免新选择沿用旧身份或旧页面的数据。 */
  private clearLogin(expired = false): void {
    this.apiLog.invalidateReplays();
    this.epoch.abort();
    this.epoch = new AbortController();
    this.pageIdentityGeneration = randomUUID();
    this.auth = undefined;
    this.customerInventoryAccess = undefined;
    this.modelRoutes.clear();
    this.pluginDelegations.clear();
    this.moduleMcpCache.clear();
    this.clearTurnReplays();
    this.turnStops.clear();
    this.salesTransactions.clear();
    this.qr = undefined;
    this.loginExpired = expired;
    // 身份变化后，之前的可见页快照一律作废。
    this.visibleWorkbenchContexts.clear();
    this.surfaces.clear();
    // 页面身份同理：换了身份，"当前页"这件事也算不清了。
    this.pageIdentities.clear();
    this.clearQuery();
    this.notifyIdentity();
  }

  /**
   * 浏览器推送当前已显示的最小只读投影；字段都按不可信业务数据处理。
   * 同一 sessionId 的较旧更新不会覆盖较新的页面状态。
   */
  updateVisibleWorkbenchContext(sessionId: string, payload: Record<string, unknown>): void {
    this.authenticated();
    if (!/^session-[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_WORKBENCH_SESSION");
    const context = validateVisibleWorkbenchContext(payload);
    const previous = this.visibleWorkbenchContexts.get(sessionId);
    if (previous && context.sequence < previous.sequence) return;
    this.visibleWorkbenchContexts.set(sessionId, {
      sequence: context.sequence,
      receivedAt: new Date().toISOString(),
      context,
    });
  }

  clearVisibleWorkbenchContext(sessionId: string): void {
    if (!/^session-[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_WORKBENCH_SESSION");
    this.visibleWorkbenchContexts.delete(sessionId);
    // 离开工作台后，之前发起但还没被执行的前端工具调用一律作废。
  }

  /** 当前会话的页面状态与序列号；页面桥用它判断"改动后的状态是否已报回"。 */
  workbenchStateSnapshot(
    sessionId: string,
  ): { sequence: number; state: VisibleWorkbenchContext } | undefined {
    const value = this.visibleWorkbenchContexts.get(sessionId);
    return value ? { sequence: value.sequence, state: value.context } : undefined;
  }

  /**
   * 记录"这个对话现在打开的是哪个业务页"。
   *
   * 页面的每一次活动（打开、轮询、调用）都会刷新时间戳：这样切页之后身份会自然跟到
   * 新页面，不会被上一个页面残留的绑定一直占着。
   */
  touchPageIdentity(sessionId: string, identity: Omit<PageIdentity, "at">): void {
    if (!sessionId) return;
    this.pageIdentities.set(sessionId, { ...identity, at: Date.now() });
  }

  /** 页面关掉时清掉身份；带 pluginId 时只清属于它的那份，避免误删刚切过去的页面。 */
  clearPageIdentity(sessionId: string, pluginId?: string): void {
    const current = this.pageIdentities.get(sessionId);
    if (!current) return;
    if (pluginId && current.pluginId !== pluginId) return;
    this.pageIdentities.delete(sessionId);
  }

  /**
   * 前端上报"这个对话现在停在哪一页菜单"：默认主对话，点业务菜单时带菜单 id 与菜单名。
   *
   * 换菜单（或从主对话切进来）等于换上下文：上一页留下的可见行快照、页面身份、
   * 以及"同一屏不重复发送"的记忆一律作废，由新页面重新上报，避免跨菜单串证据。
   */
  setSurface(sessionId: string, input: { menu?: unknown; title?: unknown }): WorkbenchSurface {
    if (!/^session-[0-9a-f-]{36}$/.test(sessionId)) throw new Error("INVALID_WORKBENCH_SESSION");
    const next = normalizeSurface(input);
    const previous = this.surfaces.get(sessionId);
    this.surfaces.set(sessionId, next);
    // 会话很多时只留最近的一批，避免这张表无限长大。
    while (this.surfaces.size > 500) {
      const oldest = this.surfaces.keys().next();
      if (oldest.done || oldest.value === sessionId) break;
      this.surfaces.delete(oldest.value);
    }
    // 只在"从一个菜单换到另一个菜单"时清：首次上报（previous 为空）可能与页面同步快照
    // 并发，清掉会把刚同步的这一屏弄丢；同一个菜单重复上报更不能清。
    if (previous !== undefined && previous.menu !== next.menu) {
      this.visibleWorkbenchContexts.delete(sessionId);
      this.pageIdentities.delete(sessionId);
    }
    return next;
  }

  /** 当前菜单状态；没上报过就是 undefined（按主对话处理）。 */
  surfaceFor(sessionId: string): WorkbenchSurface | undefined {
    return this.surfaces.get(sessionId);
  }

  /** Withdraw only the surface owned by the closing page. */
  clearSurface(sessionId: string, menu: string): void {
    if (this.surfaces.get(sessionId)?.menu !== menu) return;
    this.surfaces.delete(sessionId);
  }

  /**
   * 这个对话此刻是否还在业务工作台里。
   * 只认菜单状态字段，见 host/workbench-presence.ts。
   */
  workbenchPresenceFor(sessionId: string): WorkbenchPresence {
    return workbenchPresence({ surface: this.surfaces.get(sessionId) });
  }

  /** 当前页身份；超过 TTL 没活动就当没有页面。 */
  currentPageIdentity(sessionId: string): PageIdentity | undefined {
    const value = this.pageIdentities.get(sessionId);
    if (!value) return undefined;
    if (!pageIdentityFresh(value)) {
      this.pageIdentities.delete(sessionId);
      return undefined;
    }
    return value;
  }

  /**
   * 只返回当前 Agent 会话的页面范围，不重新读取 GEA，也不执行任何写操作。
   *
   * focus：用户问题里提到的对象/字段。带上就只回相关行与字段；不带只回摘要（行数、
   * 字段名、范围），避免整屏明细灌进上下文。
   */
  visibleWorkbenchContext(sessionId: string, focus?: string): string {
    const value = this.visibleWorkbenchContexts.get(sessionId);
    // 先看菜单状态字段：主对话（AI 工作台首页）一律不交页面证据，也不去打开页面。
    // 见 workbench-surface.ts / workbench-presence.ts。
    const presence = this.workbenchPresenceFor(sessionId);
    if (!presence.inWorkbench) {
      return JSON.stringify({
        source: "GEA_RENDERED_WORKBENCH",
        coverage: "none",
        authority: "read-only-ui-context",
        inWorkbench: false,
        signal: presence.signal,
        menu: presence.menu,
        menuTitle: presence.menuTitle,
        availability: "not-in-workbench",
        code: "PAGE_NOT_IN_WORKBENCH",
        reason:
          `这个对话在「${presence.menuTitle}」（主对话），没有业务页面证据：不要推断用户在看哪一页，也不要去打开页面。` +
          "这只影响“当前页可见行”这类问题；按月或按范围的数据问题请直接用只读数据工具查询并作答（query_business_data、gea_sales_plan_read；不要自己写 SQL），不要因此拒答或索要经销商编码。" +
          "确实需要“这一屏”时，说清需要哪一页，让用户从左侧功能区点开对应菜单。",
      });
    }
    if (!value) {
      // 绑定页面尚无快照时，保留所属页面和实际工具，不把 Native 当成 HTML lease。
      const identity = this.currentPageIdentity(sessionId);
      if (identity) return currentPageEnvelope(identity);
      return JSON.stringify({
        source: "GEA_RENDERED_WORKBENCH",
        coverage: "none",
        authority: "read-only-ui-context",
        inWorkbench: true,
        signal: presence.signal,
        menu: presence.menu,
        menuTitle: presence.menuTitle,
        availability: "in-workbench-no-snapshot",
        code: "PAGE_HAS_NO_SNAPSHOT",
        reason: `这个对话在业务菜单「${presence.menuTitle}」里，但这一屏还没有上报可见行快照：先用 gea_page 读这一屏，或直接按范围用只读数据工具查询。`,
      });
    }
    const compressed = compressForModel(value.context, focus === undefined ? {} : { focus });
    let context: unknown = value.context;
    try {
      context = JSON.parse(compressed.json);
    } catch {
      // 压缩结果异常就退回原快照：宁可大一点，也不能让页面证据消失。
    }
    const body = JSON.stringify({
      source: "GEA_RENDERED_WORKBENCH",
      renderedAt: value.receivedAt,
      coverage: "current-visible-page",
      authority: "read-only-ui-context",
      inWorkbench: true,
      signal: presence.signal,
      menu: presence.menu,
      menuTitle: presence.menuTitle,
      context,
      ...(compressed.compressed
        ? { contextNote: compressed.note, contextOmitted: compressed.omitted }
        : {}),
    });
    return body;
  }

  /** 首屏查询尚未完成时给浏览器一点时间把当前页快照同步进来。 */
  async waitVisibleWorkbenchContext(
    sessionId: string,
    timeoutMs = 2000,
    focus?: string,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.visibleWorkbenchContexts.has(sessionId))
        return this.visibleWorkbenchContext(sessionId, focus);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.visibleWorkbenchContext(sessionId, focus);
  }

  /** 模型 Gateway 拒绝当前身份后，将该 GEA 登录标记为过期。 */
  expireModelLogin(): void {
    if (this.auth) this.clearLogin(true);
  }

  private readonly avatarRefreshes = new WeakMap<object, Promise<void>>();

  /** 兼容早于头像字段加入前生成的桌面登录快照。 */
  async refreshMissingAvatar(signal: AbortSignal): Promise<void> {
    const auth = this.auth;
    if (!auth || auth.avatar) return;
    const pending = this.avatarRefreshes.get(auth);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        const identity = object(
          await this.gatewayRequests.read(
            "/sys/user/getUserInfo",
            auth,
            AbortSignal.any([signal, this.epoch.signal]),
          ),
        );
        const user = object(identity.userInfo);
        if (this.auth !== auth || String(user.id) !== auth.id) return;
        const avatar = avatarUrl(user.avatar, this.base);
        if (avatar) {
          auth.avatar = avatar;
          this.notifyIdentity();
        }
      } catch {
        this.avatarRefreshes.delete(auth);
        // 资料或头像读取失败不能阻塞账户控件。
      }
    })();
    this.avatarRefreshes.set(auth, refresh);
    return refresh;
  }

  private readonly permissionRefreshes = new WeakMap<object, Promise<void>>();

  /** 只读取当前用户的授权；allAuth 是权限目录，不代表当前用户已获授权。 */
  async refreshPermissions(signal: AbortSignal): Promise<void> {
    const auth = this.auth;
    if (!auth || auth.permissionCodes !== undefined) return;
    const pending = this.permissionRefreshes.get(auth);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        const result = object(
          await this.gatewayRequests.read(
            "/sys/permission/getPermCode",
            auth,
            AbortSignal.any([signal, this.epoch.signal]),
          ),
        );
        if (
          !Array.isArray(result.codeList) ||
          result.codeList.some((code) => typeof code !== "string")
        )
          throw new Error("GEA_INVALID_PERMISSION_CODES");
        if (this.auth === auth) auth.permissionCodes = [...new Set(result.codeList as string[])];
      } catch (error) {
        this.permissionRefreshes.delete(auth);
        if (signal.aborted || !this.auth) throw error;
        // 旧服务端仍保留服务端范围浏览和精确任务/上下文授权。
      }
    })();
    this.permissionRefreshes.set(auth, refresh);
    return refresh;
  }

  private readonly roleRefreshes = new WeakMap<object, Promise<void>>();
  private gatewaySession?: {
    authToken: string;
    conversationId: string;
    sessionId: string;
    delegationToken: string;
  };

  /**
   * 审批身份只认账号角色：经网关会话解析当前用户，拿角色编码/名称映射到审批节点。
   * 通知与任务不参与身份判定；角色读取失败时该账号视为没有审批节点（界面全灰），不阻断其它功能。
   * 默认沿用登录时解析的结果（避免每次查状态都往网关跑）；`force` 由界面刷新触发，
   * 让管理员刚改完角色的人不用重新登录。
   */
  async refreshApprovalRoles(
    signal: AbortSignal,
    options: { force?: boolean } = {},
  ): Promise<void> {
    // Disabled sales keeps startup identity metadata without opening a business Session.
    const native = this.capabilities.get("gea-workbench");
    if (!native || native.enabled === false || native.data?.mock) return;
    const auth = this.auth;
    if (!auth || (!options.force && auth.roles !== undefined)) return;
    const pending = this.roleRefreshes.get(auth);
    if (pending) return pending;
    const refresh = (async () => {
      try {
        const combined = AbortSignal.any([signal, this.epoch.signal]);
        const agentCode = this.config.analysisAgentCode;
        let session =
          this.gatewaySession && this.gatewaySession.authToken === auth.token
            ? this.gatewaySession
            : undefined;
        if (!session) {
          const requestId = randomUUID(),
            conversationId = randomUUID();
          const response = await this.apiLog.fetch(this.base + "/ai/gateway/agent/session", {
            method: "POST",
            redirect: "error",
            signal: combined,
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-Access-Token": auth.token,
              "X-Tenant-Id": auth.tenantId,
              "X-Request-Id": requestId,
            },
            body: JSON.stringify({
              agentCode,
              channel: "AI_PORTAL",
              requestId,
              conversationId,
            }),
          });
          if (!response.ok) throw await geaResponseError(response, [auth.token]);
          const body = object(parseJson(await response.text()));
          const result = object(body.result);
          const context = object(result.gatewayContext);
          const sessionId = text(context.sessionId);
          const delegationToken = text(result.delegationToken);
          if (
            body.success !== true ||
            object(result.accessDecision).allowed !== true ||
            !sessionId ||
            !delegationToken
          )
            throw new Error("GEA_APPROVAL_SESSION_REJECTED");
          session = {
            authToken: auth.token,
            conversationId,
            sessionId,
            delegationToken,
          };
          this.gatewaySession = session;
        }
        const resolved = object(
          await this.gatewayRequests.write(
            "/ai/gateway/agent/session/current-user/resolve",
            auth,
            combined,
            {
              agentCode,
              sessionId: session.sessionId,
              conversationId: session.conversationId,
              delegationToken: session.delegationToken,
            },
          ),
        );
        if (resolved.success !== true) throw new Error("GEA_APPROVAL_ROLES_UNAVAILABLE");
        const roles = Array.isArray(resolved.roles) ? resolved.roles : [];
        const mapped: SalesPlanApprovalRole[] = roles
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
          )
          .map((entry) => ({ code: text(entry.code), name: text(entry.name) }));
        if (this.auth === auth) auth.roles = mapped;
      } catch (error) {
        if (error instanceof SalesReadonlyError) throw error;
        if (signal.aborted || !this.auth) throw error;
        // 角色读不到就不是审批人：保留只读浏览，不放开审批入口。
        // 强制刷新失败时保留上一次解析到的角色——一次查询失败不等于角色被收回。
      }
    })();
    this.roleRefreshes.set(auth, refresh);
    // 这张表只用來合并"正在飞"的请求；落地后必须清掉，否则强制刷新会直接拿到
    // 登录时那条已经完成的结果，等于没重新解析。
    void refresh
      .catch(() => {})
      .finally(() => {
        if (this.roleRefreshes.get(auth) === refresh) this.roleRefreshes.delete(auth);
      });
    return refresh;
  }

  /** 对外状态永远不包含 GEA 凭证。 */
  status() {
    const readonlyValidation = this.salesReadonly?.snapshot();
    const models = this.modelRoutes.get(this.config.analysisAgentCode)?.models;
    return {
      environment: this.environment,
      environments: Object.keys(this.environments),
      authenticated: Boolean(this.auth),
      pageScope: this.pageSessionScope() ?? null,
      resubmitConnected: serviceAccountReady(
        this.config.serviceAccounts?.[this.environment],
        this.auth,
      ),
      loginState: this.auth ? "authenticated" : this.loginExpired ? "expired" : "signed-out",
      permissionCodes: this.auth?.permissionCodes,
      roles: this.auth?.roles,
      user: this.auth
        ? {
            name: this.auth.name,
            tenantId: this.auth.tenantId,
            id: this.auth.id,
            username: this.auth.username,
            avatar: this.auth.avatar,
          }
        : null,
      source: this.base,
      provider: this.config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
      model:
        models?.length && !models.includes(this.config.analysisModel)
          ? models[0]
          : this.config.analysisModel,
      discoveredModels: models ?? [],
      mode: this.config.analysisMode,
      runId: this.runId,
      ...(readonlyValidation ? { readonlyValidation } : {}),
    };
  }

  private authenticated(): NonNullable<Business["auth"]> {
    if (!this.auth) throw new Error("LOGIN_REQUIRED");
    return this.auth;
  }

  /**
   * 持久化私有草稿属于当前登录身份，绝不会调用 GEA 动作，也不代表服务端审批权限。
   * 界面自 0.0.59 起按“详情可读”开放数量编辑入口（见 `canEdit={... Boolean(access.detail)}`），
   * 真正的写权限由 GEA 在提交动作时校验；所以这里只校验登录身份、草稿新鲜度和数据形状，
   * 不再要求审批能力——否则会出现“界面能改、一存就失败”。
   */
  async salesPlanDraft(payload: Record<string, unknown>, caller: AbortSignal) {
    this.assertExecutionAllowed(this.config.analysisAgentCode, "draft");
    keys(payload, ["planId", "versionId", "approvalRole", "draft"]);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    const planId = text(payload.planId),
      versionId = text(payload.versionId);
    const approvalRole =
      payload.approvalRole === undefined ? undefined : text(payload.approvalRole);
    if (
      approvalRole !== undefined &&
      !["region", "province", "area", "category"].includes(approvalRole)
    )
      throw new Error("INVALID_PAYLOAD");
    const draftRole = approvalRole as ApprovalStageId | undefined;
    const owner = createHash("sha256")
      .update(JSON.stringify([this.base, auth.tenantId, auth.id, planId, versionId]))
      .digest("hex");
    const dir = resolve(this.config.runtimeDir, "approval-drafts");
    const file = resolve(dir, owner + ".json");
    const detail = (await this.workbenchQuery(
      { kind: "detail", query: { planId } },
      signal,
    )) as GeaSalesPlanDetail;
    const row = {
      planId,
      versionId,
      status: detail.currentVersion.status,
      planTypeCode: detail.currentVersion.planTypeCode,
    };
    const sourceSnapshot = salesPlanDraftSnapshot(row, detail);
    if (!sourceSnapshot) throw new Error("STALE_DRAFT_VERSION");
    if (payload.draft !== undefined) {
      const draft = payload.draft as SalesPlanLocalDraft;
      if (!salesPlanDraftMatches(draft, row, detail, draftRole)) throw new Error("STALE_DRAFT");
      // 固定记录本次校验用的节点口径，读回时才能用同一套基线还原这些调整量。
      const value = {
        draft: draftRole ? { ...draft, role: draftRole } : draft,
        savedAt: new Date().toISOString(),
        storage: "host",
      };
      signal.throwIfAborted();
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = resolve(dir, owner + "." + randomUUID() + ".tmp");
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      signal.throwIfAborted();
      await rename(temp, file);
      return value;
    }
    try {
      const stored = JSON.parse(await readFile(file, "utf8"));
      signal.throwIfAborted();
      if (
        salesPlanLocalDraftValid(stored.draft, planId, versionId) &&
        stored.draft.status !== row.status
      )
        return { draft: null, sourceSnapshot };
      if (!salesPlanDraftMatches(stored.draft, row, detail))
        return { draft: null, stale: true, sourceSnapshot };
      return { ...stored, sourceSnapshot };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { draft: null, sourceSnapshot };
    }
  }

  /** 使用当前 Host 身份读取完整工作流配置。 */
  async workflowConfig(payload: Record<string, unknown>, caller: AbortSignal) {
    this.salesReadonly?.assertWorkflow();
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    keys(payload, []);
    const auth = this.authenticated();
    const signal = AbortSignal.any([
      caller,
      this.epoch.signal,
      AbortSignal.timeout(this.config.requestTimeoutMs),
    ]);
    return readSalesPlanWorkflowConfig(this.base, auth.token, this.apiLog.fetch, signal);
  }

  salesPlanSubmit(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    return this.salesTransactions.submit(payload, caller);
  }

  salesPlanAction(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    return this.salesTransactions.action(payload, caller);
  }

  async navigationCatalog(
    payload: Record<string, unknown>,
    caller: AbortSignal,
  ): Promise<BusinessNavigationCatalog> {
    this.assertOperation("navigation/catalog");
    keys(payload, []);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    const agents = navigationAgents(
      await this.gatewayRequests.readResult("/aiportal/agent/market", auth, signal),
    );
    let domains: BusinessNavigationCatalog["domains"];
    try {
      const items = navigationDomains(
        await this.gatewayRequests.readResult(
          "/sys/dict/getDictItems/business_domain",
          auth,
          signal,
        ),
      );
      domains = { kind: "available", items };
    } catch {
      signal.throwIfAborted();
      domains = { kind: "unavailable", message: "业务分类暂不可用" };
    }
    signal.throwIfAborted();
    return { agents, domains };
  }

  /** 导航使用当前用户与身份取消信号，原始 Reference 不进入 API 正文日志中心。 */
  async resolveClientNavigation(input: NavigationInput, caller: AbortSignal) {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal, AbortSignal.timeout(30000)]);
    const target = await resolveNavigationTarget(
      (path, body) => this.navigationRequest(path, body, auth, signal),
      input,
      this.config.analysisAgentCode,
    );
    signal.throwIfAborted();
    if (this.auth !== auth) throw Error("STALE_LOGIN");
    return target;
  }

  /** 只确认已在当前身份下展示的目标；固定 ACK 契约且复用重试幂等键。 */
  async acknowledgeClientNavigation(intentId: string, idempotencyKey: string, caller: AbortSignal) {
    this.assertExecutionAllowed(this.config.analysisAgentCode, "submit");
    if (!/^[A-Za-z0-9._:-]{1,36}$/.test(intentId) || !/^[A-Za-z0-9-]{1,128}$/.test(idempotencyKey))
      throw Error("NAVIGATION_REQUEST_INVALID");
    const auth = this.authenticated();
    await this.navigationRequest(
      `/ai/gateway/client-navigation-intents/${encodeURIComponent(intentId)}/ack`,
      { stage: "TARGET_VISIBLE", result: "SUCCESS", idempotencyKey },
      auth,
      AbortSignal.any([caller, this.epoch.signal]),
    );
  }

  /** 导航专用固定路径传输：不保存或回显请求与响应正文，只抛受控错误。 */
  private async navigationRequest(
    path: string,
    body: unknown,
    auth: NonNullable<Business["auth"]>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (
      !/^\/ai\/gateway\/client-navigation-intents\/(resolve|[A-Za-z0-9._:%-]+\/ack)$/.test(path) &&
      !/^\/api\/v1\/notifications(?:\?pageNo=\d+&pageSize=100|\/[A-Za-z0-9._:%-]+)$/.test(path)
    )
      throw Error("NAVIGATION_REQUEST_INVALID");
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    active.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: active,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Access-Token": auth.token,
          "X-Tenant-Id": auth.tenantId,
          "X-Trace-Id": randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw Error(active.aborted ? "NAVIGATION_REQUEST_CANCELLED" : "NAVIGATION_NETWORK_ERROR");
    }
    active.throwIfAborted();
    if (this.auth !== auth) throw Error("STALE_LOGIN");
    if (response.status === 401) {
      this.clearLogin(true);
      throw Error("LOGIN_REQUIRED");
    }
    let data: Record<string, unknown>;
    try {
      data = object(await response.json());
    } catch {
      throw Error("NAVIGATION_INVALID_RESPONSE");
    }
    active.throwIfAborted();
    if (this.auth !== auth) throw Error("STALE_LOGIN");
    if (data.success !== true || !response.ok) {
      const code =
        typeof data.errorCode === "string" &&
        /^(NAVIGATION|NOTIFICATION)_[A-Z_]{1,64}$/.test(data.errorCode)
          ? data.errorCode
          : "NAVIGATION_REQUEST_REJECTED";
      if (code === "NOTIFICATION_UNAUTHENTICATED") {
        this.clearLogin(true);
        throw Error("LOGIN_REQUIRED");
      }
      throw Error(code);
    }
    return data.result;
  }

  /** 使用当前 Host 身份读取固定通知端点，不改变计划选择。 */
  async notifications(payload: Record<string, unknown>, caller: AbortSignal) {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    keys(payload, [
      "pageNo",
      "pageSize",
      "state",
      "states",
      "eventType",
      "id",
      "operation",
      "expectedVersion",
      "idempotencyKey",
      "items",
      "action",
      "targetUserId",
      "comment",
    ]);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    const operation = payload.operation === undefined ? undefined : text(payload.operation);
    if (
      operation !== undefined &&
      !["unread-count", "read", "dismiss", "batch-read", "approval-action"].includes(operation)
    )
      throw new Error("INVALID_PAYLOAD");
    if (operation === "unread-count") {
      return {
        environment: this.environment,
        fetchedAt: new Date().toISOString(),
        count: object(
          await this.gatewayRequests.read("/api/v1/notifications/unread-count", auth, signal),
        ).count,
      };
    }
    if (operation === "read" || operation === "dismiss") {
      keys(payload, ["operation", "id", "expectedVersion", "idempotencyKey"]);
      const id = text(payload.id);
      const expectedVersion = versionNumber(payload.expectedVersion);
      const idempotencyKey = text(payload.idempotencyKey);
      if (operation === "dismiss") {
        const detail = notificationDetail(
          await this.gatewayRequests.read(
            `/api/v1/notifications/${encodeURIComponent(id)}`,
            auth,
            signal,
          ),
          id,
        );
        if (detail.dismissible !== true) throw new Error("NOTIFICATION_NOT_DISMISSIBLE");
      }
      return await this.gatewayRequests.write(
        `/api/v1/notifications/${encodeURIComponent(id)}/${operation}`,
        auth,
        signal,
        { expectedVersion: String(expectedVersion), idempotencyKey },
      );
    }
    if (operation === "batch-read") {
      keys(payload, ["operation", "items", "idempotencyKey"]);
      if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100)
        throw new Error("INVALID_PAYLOAD");
      const items = payload.items.map((item) => {
        const row = object(item);
        keys(row, ["notificationId", "expectedVersion"]);
        return {
          notification_id: text(row.notificationId),
          expected_version: String(versionNumber(row.expectedVersion)),
        };
      });
      if (new Set(items.map((item) => item.notification_id)).size !== items.length)
        throw new Error("INVALID_PAYLOAD");
      return await this.gatewayRequests.write("/api/v1/notifications/batch-read", auth, signal, {
        idempotency_key: text(payload.idempotencyKey),
        items,
      });
    }
    if (operation === "approval-action") {
      keys(payload, [
        "operation",
        "id",
        "action",
        "targetUserId",
        "comment",
        "expectedVersion",
        "idempotencyKey",
      ]);
      const id = text(payload.id);
      const action = text(payload.action);
      if (!["APPROVE", "REJECT", "TRANSFER"].includes(action)) throw new Error("INVALID_PAYLOAD");
      if (action === "TRANSFER") text(payload.targetUserId);
      if (
        payload.comment != null &&
        (typeof payload.comment !== "string" || payload.comment.length > 500)
      )
        throw new Error("INVALID_PAYLOAD");
      return await this.gatewayRequests.write(
        `/api/v1/notifications/${encodeURIComponent(id)}/approval-action`,
        auth,
        signal,
        {
          action,
          target_user_id: payload.targetUserId == null ? null : text(payload.targetUserId),
          comment: payload.comment ?? null,
          expected_version: versionNumber(payload.expectedVersion),
          idempotency_key: text(payload.idempotencyKey),
        },
      );
    }
    let path = "/api/v1/notifications";
    keys(payload, ["pageNo", "pageSize", "state", "states", "eventType", "id"]);
    if (payload.id !== undefined) {
      if (
        payload.pageNo !== undefined ||
        payload.state !== undefined ||
        payload.states !== undefined ||
        payload.eventType !== undefined
      )
        throw new Error("INVALID_PAYLOAD");
      path += "/" + encodeURIComponent(text(payload.id));
    } else {
      const query = new URLSearchParams({
        pageNo: String(integer(payload.pageNo ?? 1, 1, 100000)),
        pageSize: String(integer(payload.pageSize ?? this.config.pageSize, 1, 100)),
      });
      if (payload.state !== undefined && payload.state !== "")
        query.set("state", text(payload.state));
      if (payload.states !== undefined && payload.states !== "")
        query.set("states", text(payload.states));
      if (payload.eventType !== undefined && payload.eventType !== "")
        query.set("eventType", text(payload.eventType));
      path += "?" + query;
    }
    const value = await this.gatewayRequests.read(path, auth, signal);
    signal.throwIfAborted();
    return {
      environment: this.environment,
      fetchedAt: new Date().toISOString(),
      ...(payload.id === undefined
        ? notificationPage(value, integer(payload.pageSize ?? this.config.pageSize, 1, 100))
        : { detail: notificationDetail(value, text(payload.id)) }),
    };
  }

  /** 解析当前登录用户的 GEA 个人模型路由，但不向浏览器暴露密钥。 */
  async modelRoute(
    signal: AbortSignal,
    agentCode = "sales_forecast",
    pageSessionId?: string,
  ): Promise<GeaModelRoute> {
    this.assertModelAllowed();
    this.assertExecutionAllowed(agentCode, "view", pageSessionId);
    const auth = this.authenticated();
    const epoch = this.epoch.signal;
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(agentCode)) throw new Error("GEA_MODEL_AGENT_INVALID");
    const cached = this.modelRoutes.get(agentCode);
    if (cached) return cached;
    const credentialResult = object(
      await this.gatewayRequests.read(
        "/aidata/user-agent-credential/my/list?pageNo=1&pageSize=10",
        auth,
        AbortSignal.any([signal, epoch]),
        false,
      ),
    );
    const records = Array.isArray(credentialResult.records) ? credentialResult.records : [];
    if (records.length > 1) throw new Error("GEA_MODEL_CREDENTIAL_AMBIGUOUS");
    const credential = records[0] ? object(records[0]) : undefined;
    if (!credential) throw new Error("GEA_MODEL_CREDENTIAL_MISSING");
    const status = credential.status;
    if (status === "DISABLED" || status === "REVOKED")
      throw new Error("GEA_MODEL_CREDENTIAL_DISABLED");
    const credentialId = text(credential.credentialId ?? credential.id);
    const claim = await this.gatewayRequests.claim(
      "/aidata/user-agent-credential/my/claim?id=" + encodeURIComponent(credentialId),
      auth,
      AbortSignal.any([signal, epoch]),
      false,
    );
    const claimed = object(claim);
    if (String(claimed.credentialId ?? "") !== credentialId)
      throw new Error("GEA_MODEL_CREDENTIAL_MISMATCH");
    if (!["ACTIVE", "ENABLED"].includes(String(claimed.status)))
      throw new Error("GEA_MODEL_CREDENTIAL_UNAVAILABLE");
    const base = new URL(text(claimed.baseUrl));
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash)
      throw new Error("GEA_MODEL_BASE_URL_INVALID");
    const baseUrl = base.href.replace(/\/$/, "");
    const secret = text(claimed.secret);
    let response: Response;
    try {
      response = await this.apiLog.fetch(baseUrl + "/models", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + secret,
          "X-GEA-Agent-Code": agentCode,
        },
        redirect: "error",
        signal: AbortSignal.any([signal, epoch, AbortSignal.timeout(this.config.requestTimeoutMs)]),
      });
    } catch {
      throw new Error("GEA_MODEL_NETWORK_ERROR");
    }
    if (!response.ok) {
      if (response.status === 401) this.clearLogin(true);
      throw await modelHttpError(response, agentCode, "模型列表读取", [secret, auth.token]);
    }
    const modelsPayload = object(await response.json());
    if (!Array.isArray(modelsPayload.data)) throw new Error("GEA_MODEL_INVALID_RESPONSE");
    const models = modelsPayload.data.map((entry) =>
      typeof entry === "string" ? entry : text(object(entry).id),
    );
    if (!models.length) throw new Error("GEA_MODEL_EMPTY");
    const names: Record<string, string> = {};
    const contextWindows: Record<string, number> = {};
    for (const id of new Set(models)) {
      const item = modelsPayload.data.find(
        (entry: unknown) => typeof entry === "object" && entry !== null && object(entry).id === id,
      );
      const capacity =
        item && typeof item === "object"
          ? (object(item).contextWindow ?? object(item).context_window)
          : undefined;
      if (typeof capacity === "number" && Number.isSafeInteger(capacity) && capacity > 0)
        contextWindows[id] = capacity;
      let label = item && typeof item === "object" ? object(item).name : undefined;
      if (typeof label !== "string" || !label.trim()) {
        try {
          const metadata = object(
            await this.gatewayRequests.read(
              "/airag/airagModel/queryById?id=" + encodeURIComponent(id),
              auth,
              AbortSignal.any([signal, epoch]),
            ),
          );
          if (metadata.id === id) label = metadata.name || metadata.modelName;
        } catch (error) {
          // 无权或不可用的显示名查询不能禁用已授权的模型路由。
          if (epoch.aborted || signal.aborted) throw error;
        }
      }
      names[id] =
        typeof label === "string" && label.trim() && label.length <= 256
          ? label.trim()
          : "GEA 模型（名称未提供）";
    }
    const route = {
      baseUrl,
      secret,
      agentCode,
      models: [...new Set(models)],
      names,
      contextWindows,
    };
    epoch.throwIfAborted();
    signal.throwIfAborted();
    this.modelRoutes.set(agentCode, route);
    return route;
  }

  /** 重启二维码登录，并使旧身份留下的所有选择失效。 */
  async loginStart(signal: AbortSignal, payload: Record<string, unknown> = {}) {
    keys(payload, ["environment"]);
    if (payload.environment !== undefined)
      this.selectEnvironment({ environment: payload.environment });
    this.clearLogin();
    const epoch = this.epoch.signal;
    const result = object(
      await this.gatewayRequests.read(
        "/sys/getLoginQrcode",
        undefined,
        AbortSignal.any([epoch, signal]),
      ),
    );
    const id = text(result.qrcodeId);
    const loginId = randomUUID();
    const url = new URL(this.base + "/sys/thirdLogin/sso/lark/login");
    url.searchParams.set(
      "state",
      `gea-client://scan-login?feishuScanQrcodeId=${encodeURIComponent(id)}`,
    );
    url.searchParams.set("tenantId", "0");
    const image = await QRCode.toDataURL(url.href, { width: 256, margin: 2 });
    if (epoch.aborted) throw new Error("STALE_SELECTION");
    this.qr = { id, loginId, createdAt: Date.now() };
    return { loginId, image, expiresIn: 120 };
  }

  /** 只有二维码登录仍是当前登录时，才接纳两次请求共同返回的身份。 */
  async loginPoll(payload: Record<string, unknown>, signal: AbortSignal) {
    if (!this.qr || payload.loginId !== this.qr.loginId) throw new Error("STALE_LOGIN");
    const qr = this.qr;
    if (Date.now() - qr.createdAt >= 120000) return { status: "expired" };
    const epoch = this.epoch.signal;
    const combined = AbortSignal.any([epoch, signal]);
    const result = object(
      await this.gatewayRequests.read(
        "/sys/getQrcodeToken?qrcodeId=" + encodeURIComponent(qr.id),
        undefined,
        combined,
      ),
    );
    if (result.token === "-1") return { status: "pending" };
    if (result.token === "-2") return { status: "expired" };
    if (result.success !== true) throw new Error("GEA_INVALID_LOGIN");
    if (typeof result.token !== "string" || !result.token.trim() || result.token.length > 16384)
      throw new Error("GEA_INVALID_LOGIN");
    const token = result.token;
    const identity = object(
      await this.gatewayRequests.read("/sys/user/getUserInfo", { token }, combined),
    );
    const user = object(identity.userInfo);
    const tenantId = String(user.loginTenantId ?? user.tenantId ?? "");
    if (!user.id || !/^\d+$/.test(tenantId)) throw new Error("GEA_IDENTITY_INCOMPLETE");
    const name = text(user.realname || user.username);
    if (epoch.aborted || this.qr !== qr) throw new Error("STALE_LOGIN");
    this.auth = {
      token,
      tenantId,
      name,
      id: text(user.id),
      username: text(user.username || user.realname),
      avatar: avatarUrl(user.avatar, this.base),
    };
    this.qr = undefined;
    await this.refreshPermissions(combined);
    await this.refreshApprovalRoles(combined);
    combined.throwIfAborted();
    this.notifyIdentity();
    return { status: "authenticated", ...this.status() };
  }

  /** 只使用当前进程登录准备 Gateway 传输能力。 */
  async htmlLaunch(agentCode: string, signal: AbortSignal, conversationId?: string) {
    this.assertExecutionAllowed(agentCode);
    const auth = this.authenticated();
    const identity = AbortSignal.any([signal, this.epoch.signal]);
    const credentials = await prepareGatewayLaunch(
      this.base,
      auth,
      { consumerType: "AGENT", consumerCode: agentCode },
      identity,
      this.config.requestTimeoutMs,
      this.fetchExternal.bind(this),
      conversationId,
    );
    const inventoryRoleConsumer =
      agentCode === "inventory-personal-workbench" || agentCode === "customer_inventory";
    if (!inventoryRoleConsumer) return credentials;
    try {
      const roleProfile = await resolveInventoryRoles(
        this.base,
        credentials,
        auth.id,
        identity,
        this.config.mcpRequestTimeoutMs ?? 60000,
        this.fetchExternal.bind(this),
      );
      identity.throwIfAborted();
      if (agentCode === "customer_inventory" && this.auth === auth) {
        this.customerInventoryAccess = { authToken: auth.token, profile: roleProfile };
        this.notifyIdentity();
      }
      return { ...credentials, roleProfile };
    } catch {
      identity.throwIfAborted();
      const roleProfile: InventoryRoleProfile = {
        roleCodes: [],
        roleNames: [],
        roles: [],
        customerInventoryScope: {
          status: "unconfigured",
          regions: [],
          provinces: [],
          customerCodes: [],
          version: null,
          expiresAt: null,
        },
      };
      if (agentCode === "customer_inventory" && this.auth === auth) {
        this.customerInventoryAccess = { authToken: auth.token, profile: roleProfile };
        this.notifyIdentity();
      }
      return {
        ...credentials,
        roleProfile: { ...roleProfile, roleLookupFailed: true },
      };
    }
  }

  async openMcpConnection(
    consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string },
    signal: AbortSignal,
  ) {
    this.salesReadonly?.assertOperation("mcp");
    this.assertExecutionAllowed(consumer.consumerCode);
    const auth = this.authenticated();
    const identity = this.epoch.signal;
    return prepareGatewayMcp(
      this.base,
      auth,
      consumer,
      identity,
      this.config.mcpRequestTimeoutMs ?? 300000,
      this.apiLog.fetch,
      {
        cubeMcpCode: this.config.cubeMcpCodes?.[this.environment],
        setupSignal: signal,
        maxResponseBytes: this.config.mcpMaxResponseBytes,
      },
    );
  }

  private readonly moduleMcpCache = new Map<string, { token: string; module: GatewayMcpClient }>();
  /** A rejected business Session cannot authorize later reads, even if the login stays valid. */
  invalidateModuleMcp(consumerCode: string, expected?: GatewayMcpClient): void {
    if (!expected || this.moduleMcpCache.get(consumerCode)?.module === expected)
      this.moduleMcpCache.delete(consumerCode);
  }
  /**
   * 模块自带的 MCP 查询通道（每个 consumerCode 一个会话，登录身份变化即失效）。
   * 页面不可用时的兜底查询走这里：不依赖页面、也不依赖我们替它写 SQL。
   */
  async moduleMcp(consumerCode: string, signal: AbortSignal): Promise<GatewayMcpClient> {
    this.assertExecutionAllowed(consumerCode);
    const auth = this.authenticated();
    const identity = this.epoch.signal;
    signal.throwIfAborted();
    const cached = this.moduleMcpCache.get(consumerCode);
    if (cached && cached.token === auth.token) return cached.module;
    const transport = await this.openMcpConnection({ consumerType: "AGENT", consumerCode }, signal);
    const module = await openGatewayMcp(transport, signal);
    identity.throwIfAborted();
    signal.throwIfAborted();
    this.moduleMcpCache.set(consumerCode, { token: auth.token, module });
    return module;
  }

  private readonly turnReplays = new Map<string, { text: string; at: number }>();
  private readonly turnReadRevisions = new Map<string, number>();
  readTurnRevision(scope: string): number {
    return this.turnReadRevisions.get(scope) ?? 0;
  }
  rememberTurnReplay(scope: string, key: string, text: string): void {
    if (!text) return;
    const full = `${scope || "global"}\u0000${key}`;
    this.turnReplays.delete(full);
    this.turnReplays.set(full, { text, at: Date.now() });
    while (this.turnReplays.size > 60) {
      const oldest = this.turnReplays.keys().next().value as string;
      this.turnReplays.delete(oldest);
    }
  }

  /** 本轮成功聚合的有界摘要；读取失败/停手不抹掉已有事实，换轮或身份沿用回执清理。 */
  successfulPlanEvidence(scope: string): Record<string, unknown>[] {
    const receipts: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const prefix = `${scope || "global"}\u0000plan|`;
    // 优先保留先取得的整体范围，避免后续小范围探查把完整汇总挤出摘要。
    for (const [key, entry] of this.turnReplays) {
      if (!key.startsWith(prefix)) continue;
      try {
        const result = object(JSON.parse(entry.text));
        const query = object(result.query);
        const value = object(result.value);
        if (
          result.source !== "GEA_LIVE_READONLY" ||
          result.coverage !== "complete" ||
          query.kind !== "aggregate" ||
          !Array.isArray(value.totals)
        )
          continue;
        const fingerprint = JSON.stringify(value);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        const receipt: Record<string, unknown> = {
          source: result.source,
          environment: result.environment,
          fetchedAt: result.fetchedAt,
          query,
          coverage: "complete",
          evidenceProjection: "summary",
          geography: "baseName 是基地，不代表组织大区",
          statusBasis: object(value.basis ?? {}).status,
          scopeBasis: object(value.basis ?? {}).scope,
          deliveryBasis: object(value.basis ?? {}).delivery,
          planCount: value.planCount,
          skuRowCount: value.skuRowCount,
          distinctSkuCount: value.distinctSkuCount,
          totals: value.totals,
          bases: value.bases,
          categoryTotals: value.categoryTotals,
          categoryGroupCount: Array.isArray(value.groups) ? value.groups.length : 0,
          groups: Array.isArray(value.groups)
            ? value.groups.map((row) => {
                const group = object(row);
                return Object.fromEntries(
                  [
                    "orderType",
                    "planTypeCode",
                    "baseName",
                    "productCategName",
                    "amt",
                    "qty",
                    "amountShareWithinBase",
                  ].map((field) => [field, group[field]]),
                );
              })
            : [],
          note: "这是成功结果的摘要，不是新的查询。若标有 categoryRowsOmitted/baseRowsOmitted，仅表示此摘要省略；完整表已在对应 aggregate 成功结果中，不能说未取到。",
        };
        if (Buffer.byteLength(JSON.stringify([...receipts, receipt]), "utf8") > 24_000) {
          delete receipt.groups;
          receipt.categoryRowsOmitted = true;
        }
        if (Buffer.byteLength(JSON.stringify([...receipts, receipt]), "utf8") > 24_000) {
          delete receipt.bases;
          receipt.baseRowsOmitted = true;
        }
        if (Buffer.byteLength(JSON.stringify([...receipts, receipt]), "utf8") > 24_000) break;
        receipts.push(receipt);
      } catch {
        /* 非聚合正文或无效回执不能成为成功证据。 */
      }
    }
    return receipts;
  }

  clearTurnReplays(scope?: string): void {
    if (scope !== undefined) {
      for (const key of this.turnReplays.keys())
        if (key.startsWith(`${scope || "global"}\u0000`)) this.turnReplays.delete(key);
      this.turnReadRevisions.set(scope, this.readTurnRevision(scope) + 1);
    } else {
      this.turnReplays.clear();
      this.turnReadRevisions.clear();
    }
  }

  private readonly turnStops = new Map<
    string,
    { at: number; reason: string; kind: "query" | "session-expired" }
  >();

  stopTurn(scope: string, reason: string, kind: "query" | "session-expired" = "query"): void {
    this.turnStops.set(scope || "global", { at: Date.now(), reason, kind });
  }

  turnStopKind(scope: string): "query" | "session-expired" | undefined {
    return this.turnStops.get(scope || "global")?.kind;
  }

  turnStopped(scope: string): string | undefined {
    return this.turnStops.get(scope || "global")?.reason;
  }

  clearTurnStops(scope?: string): void {
    if (scope !== undefined) this.turnStops.delete(scope || "global");
    else this.turnStops.clear();
  }

  /**
   * 诊断用：对某个 consumerCode 真走一遍 MCP（会话申请 → initialize → tools/list），
   * 并把两段 HTTP 的原始请求/响应带出来。只在 GEA_DEBUG_PROBE=1 时经调试路由暴露。
   */
  async debugProbeModuleMcp(
    consumerCode: string,
    signal: AbortSignal,
  ): Promise<{
    consumerCode: string;
    ok: boolean;
    error?: string;
    tools?: string[];
    raw: Array<{
      method: string;
      url: string;
      requestBody?: string;
      status?: number;
      mcpSessionId?: string;
      requestHeaders?: Record<string, string>;
      responseBody?: string;
    }>;
    experiments?: Array<{
      label: string;
      status?: number;
      responseBody?: string;
    }>;
  }> {
    this.assertExecutionAllowed(consumerCode);
    const raw: Array<{
      method: string;
      url: string;
      requestBody?: string;
      status?: number;
      mcpSessionId?: string;
      requestHeaders?: Record<string, string>;
      responseBody?: string;
    }> = [];
    const capture: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const requestBody = typeof init?.body === "string" ? init.body.slice(0, 4000) : undefined;
      const response = await this.apiLog.fetch(input, init);
      const sessionHeader = response.headers.get("mcp-session-id") ?? undefined;
      // 诊断要看清"同一个 body 为什么这次 400、重放 200"：把非敏感请求头一起留下。
      const headerBag = new Headers(init?.headers);
      const requestHeaders: Record<string, string> = {};
      for (const key of ["accept", "content-type", "mcp-protocol-version", "mcp-session-id"]) {
        const value = headerBag.get(key);
        if (value) requestHeaders[key] = value;
      }
      let responseBody: string | undefined;
      const type = response.headers.get("content-type") ?? "";
      // 网关的错误体不一定是 JSON：只要是文本类且不大，就带回来（诊断要的就是这段）。
      const length = Number(response.headers.get("content-length") ?? "0");
      if (
        type.includes("json") ||
        type.includes("text") ||
        (Number.isSafeInteger(length) && length > 0 && length < 20_000)
      ) {
        responseBody = await response
          .clone()
          .text()
          .then((text) => text.slice(0, 4000))
          .catch(() => undefined);
      }
      raw.push({
        method,
        url,
        ...(Object.keys(requestHeaders).length ? { requestHeaders } : {}),
        ...(requestBody === undefined ? {} : { requestBody }),
        status: response.status,
        ...(sessionHeader === undefined ? {} : { mcpSessionId: sessionHeader }),
        ...(responseBody === undefined ? {} : { responseBody }),
      });
      return response;
    };
    // 会话阶段拿到的身份，用来做"带 _meta / 不带 _meta"的对照实验。
    let meta: Record<string, unknown> | undefined;
    let transportSession: string | undefined;
    const experiments: Array<{
      label: string;
      status?: number;
      responseBody?: string;
    }> = [];
    try {
      const auth = this.authenticated();
      const transport = await prepareGatewayMcp(
        this.base,
        auth,
        { consumerType: "AGENT", consumerCode },
        AbortSignal.any([signal, this.epoch.signal]),
        this.config.mcpRequestTimeoutMs ?? 60000,
        capture,
      );
      for (const entry of raw) {
        if (!entry.responseBody) continue;
        try {
          const parsed = JSON.parse(entry.responseBody) as {
            result?: {
              gatewayContext?: { sessionId?: string; conversationId?: string };
              delegationToken?: string;
            };
          };
          const context = parsed.result?.gatewayContext;
          if (context?.sessionId && parsed.result?.delegationToken) {
            transportSession = transportSession ?? entry.mcpSessionId;
            meta = {
              sessionId: context.sessionId,
              conversationId: context.conversationId,
              delegationToken: parsed.result.delegationToken,
              agentCode: consumerCode,
            };
          }
        } catch {
          // 不是 JSON 的响应不参与实验。
        }
      }
      const module = await openGatewayMcp(transport, signal);
      return {
        consumerCode,
        ok: true,
        tools: module.tools().map((tool) => tool.name),
        raw,
        ...(experiments.length ? { experiments } : {}),
      };
    } catch (error) {
      // 对照实验：同一个代理会话下，tools/list 带 _meta 与不带 _meta 各发一次。
      if (meta) {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
        };
        const session = transportSession ?? raw.find((r) => r.mcpSessionId)?.mcpSessionId;
        if (session) headers["mcp-session-id"] = session;
        // 失败的那条 tools/list 原文（含 SDK 用的 id/params），用于区分"body 问题"与"header 问题"。
        const failedList = raw.find(
          (entry) => entry.status === 400 && entry.requestBody?.includes('"tools/list"'),
        );
        const variants: Array<[string, string]> = [
          [
            "tools/list（不带 _meta）",
            JSON.stringify({
              jsonrpc: "2.0",
              id: "probe-0",
              method: "tools/list",
              params: {},
            }),
          ],
          [
            "tools/list（带 _meta，复刻线上）",
            JSON.stringify({
              jsonrpc: "2.0",
              id: "probe-1",
              method: "tools/list",
              params: { _meta: meta },
            }),
          ],
          ...(failedList?.requestBody
            ? ([["原样重放失败的那条 tools/list", failedList.requestBody]] as Array<
                [string, string]
              >)
            : []),
        ];
        for (const [label, body] of variants) {
          try {
            const response = await capture(this.base + "/ai/gateway/mcp/proxy/mcp", {
              method: "POST",
              headers,
              body,
            });
            experiments.push({
              label,
              status: response.status,
              responseBody: raw.at(-1)?.responseBody,
            });
          } catch (experimentError) {
            experiments.push({
              label,
              responseBody:
                experimentError instanceof Error
                  ? experimentError.message
                  : String(experimentError),
            });
          }
        }
      }
      return {
        consumerCode,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        raw,
        ...(experiments.length ? { experiments } : {}),
      };
    }
  }

  /** 为受信任的 HTML 插件提供带用户权限的只读 SQL 查询。SQL 仍由 GEA 网关按 consumerCode 审核。 */
  async pluginSql(
    payload: Record<string, unknown>,
    caller: AbortSignal,
    configured = false,
  ): Promise<unknown> {
    const query =
      payload.query && typeof payload.query === "object" && !Array.isArray(payload.query)
        ? object(payload.query)
        : payload;
    keys(payload, [
      "consumerCode",
      "sql",
      "parameters",
      "values",
      "pageNo",
      "pageSize",
      "maxRows",
      "packing",
      "resultShape",
      "includeTotal",
      "query",
    ]);
    const consumerCode = text(payload.consumerCode ?? query.consumerCode);
    this.assertExecutionAllowed(consumerCode);
    this.sqlReadLimit?.assertAvailable(consumerCode);
    const auth = this.authenticated();
    const sqlValue = query.sql;
    if (typeof sqlValue !== "string" || !sqlValue.trim() || sqlValue.length > 200_000)
      throw new Error("GEA_PLUGIN_SQL_INVALID");
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    let rejectedCurrentLogin: { error: GeaResponseError; epoch: AbortController } | undefined;
    const getDelegation = async () => {
      let delegation = this.pluginDelegations.get(consumerCode);
      if (delegation?.authToken === auth.token) return delegation;
      const requestId = randomUUID();
      const response = await this.apiLog.fetch(this.base + "/ai/gateway/agent/session", {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Access-Token": auth.token,
          "X-Tenant-Id": auth.tenantId,
          "X-Request-Id": requestId,
        },
        body: JSON.stringify({
          agentCode: consumerCode,
          channel: "AI_PORTAL",
          requestId,
          conversationId: randomUUID(),
        }),
      });
      if (!response.ok) {
        const error = await geaResponseError(response, [auth.token]);
        signal.throwIfAborted();
        if (response.status === 401 && this.auth?.token === auth.token) {
          this.clearLogin(true);
          rejectedCurrentLogin = { error, epoch: this.epoch };
        }
        throw error;
      }
      const body = object(await response.json());
      const result = object(body.result);
      if (
        body.success !== true ||
        object(result.accessDecision).allowed !== true ||
        typeof result.delegationToken !== "string" ||
        !result.delegationToken
      )
        throw new Error("GEA_PLUGIN_SESSION_REJECTED");
      delegation = {
        authToken: auth.token,
        delegationToken: result.delegationToken,
      };
      this.pluginDelegations.set(consumerCode, delegation);
      return delegation;
    };
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        this.sqlReadLimit?.assertAvailable(consumerCode);
        const delegation = await getDelegation();
        try {
          // 配置查询自带 LIMIT/OFFSET；旧调用继续由适配器管理分页。
          const transport = {
            endpoint: this.base.replace(/\/$/, "") + "/ai/gateway/sql/execute",
            token: delegation.delegationToken,
            fetch: this.apiLog.fetch,
            signal,
            limit: this.sqlReadLimit,
          };
          const result = configured
            ? await createGeaSqlDatabase(() => delegation.delegationToken, transport)
                .queryConfigured!({
                sql: query.sql,
                parameters: query.parameters,
                includeTotal: false,
              } as ConfiguredSqlRequest)
            : await readHtmlQuery(withDefaultPaging(query), transport);
          return result;
        } catch (error) {
          if ((error as { code?: string })?.code === "GEA_GATEWAY_SESSION_REJECTED") {
            if (this.pluginDelegations.get(consumerCode) === delegation)
              this.pluginDelegations.delete(consumerCode);
            if (attempt === 0 && !signal.aborted) continue;
          }
          throw error;
        }
      }
      throw new Error("GEA_PLUGIN_SESSION_REJECTED");
    } catch (error) {
      // Caller cancellation wins; only this live request's authentication rejection may explain its identity abort.
      caller.throwIfAborted();
      if (
        rejectedCurrentLogin !== undefined &&
        rejectedCurrentLogin.error === error &&
        rejectedCurrentLogin.epoch === this.epoch &&
        !this.auth &&
        this.loginExpired
      )
        throw error;
      // Page refresh, range changes and identity cancellation are not failed reads.
      signal.throwIfAborted();
      // A failed delegated credential must not poison the next page refresh.
      if (error instanceof GeaResponseError) this.pluginDelegations.delete(consumerCode);
      throw error;
    }
  }

  /** 向模型适配器提供同一套脱敏日志边界，浏览器永远拿不到原始凭证。 */
  fetchExternal(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.apiLog.fetch(input, init);
  }

  /** The Host installs its sole capability registry, including the native sales declaration. */
  setCapabilities(capabilities: CapabilityRegistry): void {
    this.capabilities = capabilities;
  }

  /** Reject unavailable or simulated execution before authentication, delegation or transport. */
  assertOperation(operation: string): void {
    this.salesReadonly?.assertOperation(operation);
  }

  assertModelAllowed(): void {
    this.salesReadonly?.assertModel();
  }

  assertExecutionAllowed(
    consumerCode: string,
    effect: CapabilityEffect = "view",
    pageSessionId?: string,
  ): void {
    this.salesReadonly?.assertConsumer(consumerCode, effect);
    const contract =
      consumerCode === this.config.analysisAgentCode && consumerCode !== WORKBENCH_AGENT_CODE
        ? this.capabilities.get("gea-workbench")
        : this.capabilities.list().find((item) => item.data?.consumerCode === consumerCode);
    const page = pageSessionId ? this.currentPageIdentity(pageSessionId) : undefined;
    const pageAnalysis =
      effect === "view" &&
      page?.mock === true &&
      page.consumerCode === consumerCode &&
      page.pluginId === contract?.id;
    let code: string | undefined;
    if (!contract) code = "GEA_PLUGIN_CONSUMER_NOT_ALLOWED";
    else if (contract.enabled === false) code = "GEA_CAPABILITY_DISABLED";
    else if (contract.data?.mock && !pageAnalysis) code = "GEA_CAPABILITY_MOCK_ONLY";
    else if (
      effectRank(effect) > effectRank(contract.maxEffect) ||
      (contract.view && !this.capabilities.allows(contract.view.surface, effect))
    )
      code = "GEA_CAPABILITY_EFFECT_NOT_ALLOWED";
    if (code) throw Object.assign(Error(code), { code });
  }

  /**
   * 只读探查：模块自述里那几张业务表的列清单。
   *
   * 会话里"不用猜表名字段名"靠这一步：表名来自模块契约（宿主静态提取），列名由受管
   * 只读通道探一次得到（同样按权限过滤），结果按表缓存，避免每问一次都重探。
   */
  async pluginSchema(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    this.assertExecutionAllowed(text(payload.consumerCode));
    keys(payload, ["consumerCode", "tables"]);
    const consumerCode = text(payload.consumerCode);
    const requested = Array.isArray(payload.tables) ? payload.tables : [];
    const tables = requested
      .filter(
        (table): table is string => typeof table === "string" && /^agents?_[a-z0-9_]+$/.test(table),
      )
      .slice(0, 20);
    const result: Array<{ table: string; columns: string[]; error?: string }> = [];
    // 缓存命中的直接给，未命中的按预算并行探：串行探十几张表会把工具超时跑爆。
    const pending: string[] = [];
    for (const table of tables) {
      const cacheKey = consumerCode + ":" + table;
      const cached = this.pluginSchemaCache.get(cacheKey);
      if (cached && Date.now() - cached.at < PLUGIN_SCHEMA_TTL_MS) {
        result.push({ table, columns: cached.columns });
        continue;
      }
      pending.push(table);
    }
    const { outcomes, skipped } = await probeTables(
      pending,
      async (table, signal) => {
        const page = object(
          await this.pluginSql(
            {
              consumerCode,
              sql: `SELECT * FROM ${table}`,
              pageNo: 1,
              pageSize: 1,
            },
            signal,
          ),
        );
        const rows = Array.isArray(page.rows)
          ? page.rows
          : Array.isArray(page.records)
            ? page.records
            : [];
        const columns = Array.isArray(page.returnedColumns)
          ? page.returnedColumns.map((column) => String(column))
          : rows.length > 0
            ? Object.keys(object(rows[0]))
            : [];
        return columns.slice(0, 200);
      },
      { signal: caller, limit: tables.length },
    );
    for (const outcome of outcomes) {
      const { table } = outcome;
      if (outcome.error !== undefined) {
        result.push({ table, columns: [], error: outcome.error });
        continue;
      }
      const bounded = outcome.value ?? [];
      const cacheKey = consumerCode + ":" + table;
      if (bounded.length > 0)
        this.pluginSchemaCache.set(cacheKey, {
          at: Date.now(),
          columns: bounded,
        });
      result.push({ table, columns: bounded });
    }
    const byTable = new Map(result.map((row) => [row.table, row]));
    const ordered = tables
      .map((table) => byTable.get(table))
      .filter((row): row is { table: string; columns: string[]; error?: string } => Boolean(row));
    return {
      consumerCode,
      tables: ordered,
      // 没探完的表如实回报，别让模型以为"这个模块就这么多字段"。
      ...(skipped.length
        ? {
            skipped,
            note: `本轮只探了 ${ordered.length} 张表（每次最多 ${
              ordered.length + skipped.length
            } 张）：${skipped.slice(0, 5).join("、")} 等 ${
              skipped.length
            } 张还没探，需要时再调一次 describe。`,
          }
        : {}),
      ...(tables.length === 0
        ? {
            note: "该模块没有可直读的业务表（未声明受管 SQL）：需要它的数据请先打开对应页面，用页面工具读取。",
          }
        : {}),
    };
  }

  /** 返回当前进程内的脱敏接口目录与调用记录。 */
  apiLogSnapshot(payload: Record<string, unknown>): ApiLogSnapshot {
    keys(payload, []);
    this.authenticated();
    return this.apiLog.snapshot();
  }

  /** 清空当前进程内的调用记录，不影响接口目录与业务缓存。 */
  apiLogClear(payload: Record<string, unknown>): ApiLogSnapshot {
    keys(payload, []);
    this.authenticated();
    return this.apiLog.clear();
  }

  /** 在当前身份内执行日志中心已校验的安全重发。 */
  async apiLogReplay(payload: Record<string, unknown>, signal: AbortSignal) {
    let release: (() => void) | undefined;
    try {
      this.assertExecutionAllowed(this.config.analysisAgentCode);
      keys(payload, ["id", "confirmed"]);
      this.authenticated();
      if (payload.confirmed !== true && payload.confirmed !== false) throw Error("INVALID_PAYLOAD");
      release = this.debugRuns.claim(randomUUID());
      return await this.apiLog.replay(
        text(payload.id),
        payload.confirmed,
        AbortSignal.any([signal, this.epoch.signal]),
      );
    } catch (error) {
      return {
        outcome: "rejected",
        recordId: null,
        reason: error instanceof Error ? error.message : "重发被拒绝，无调用日志",
      } as const;
    } finally {
      release?.();
    }
  }

  private debugScope(): string {
    const scope = this.pageSessionScope();
    if (!scope) throw Error("LOGIN_REQUIRED");
    return scope;
  }

  apiLogBatchStart(payload: Record<string, unknown>, signal: AbortSignal) {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    this.authenticated();
    return this.apiLogBatch.start(
      parseApiBatchRequest(payload),
      this.debugScope(),
      this.epoch.signal,
      signal,
    );
  }
  apiLogBatchRead(payload: Record<string, unknown>) {
    keys(payload, ["runId"]);
    this.authenticated();
    return this.apiLogBatch.read(
      payload.runId === undefined ? undefined : text(payload.runId),
      this.debugScope(),
    );
  }
  apiLogBatchStop(payload: Record<string, unknown>) {
    keys(payload, ["runId"]);
    this.authenticated();
    return this.apiLogBatch.stop(text(payload.runId), this.debugScope());
  }

  /** 开启新分页查询时立即失效旧选择，后续 detail/version/SKU 只能引用本次页面。 */
  async plans(payload: Record<string, unknown>, signal: AbortSignal): Promise<Page> {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    this.clearQuery();
    const auth = this.authenticated();
    keys(payload, ["pageNo", "pageSize", "periodId", "planTypeCode", "status"]);
    const current = integer(payload.pageNo ?? 1, 1),
      size = integer(payload.pageSize ?? this.config.pageSize, 1, this.config.pageSize);
    const query = new URLSearchParams({
      pageNo: String(current),
      pageSize: String(size),
    });
    for (const key of ["periodId", "planTypeCode", "status"]) {
      if (payload[key] === undefined || payload[key] === "") continue;
      const value = text(payload[key]);
      if (key === "status" && !/^\d+$/.test(value)) throw new Error("INVALID_QUERY");
      query.set(key, value);
    }
    const epoch = this.queryEpoch.signal;
    const page = object(
      await this.gatewayRequests.read(
        "/sales-plan/plans?" + query,
        auth,
        AbortSignal.any([epoch, this.epoch.signal, signal]),
      ),
    );
    if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_PAGE");
    const records = page.records.map((row) => project(row, planFields));
    records.forEach((row) => text(row.planId));
    if (new Set(records.map((row) => row.planId)).size !== records.length)
      throw new Error("GEA_DUPLICATE_PLAN");
    const result: Page = {
      queryId: brandString<QueryId>(randomUUID()),
      source: "GEA_LIVE_READONLY",
      sourceUrl: this.base + "/sales-plan/plans",
      fetchedAt: new Date().toISOString(),
      tenantId: auth.tenantId,
      query: Object.fromEntries(query),
      current: integer(page.current ?? current, 1),
      size: integer(page.size ?? size, 1),
      total: integer(page.total, 0),
      records,
    };
    if (epoch.aborted) throw new Error("STALE_SELECTION");
    this.page = result;
    return result;
  }

  private selected(payload: Record<string, unknown>) {
    this.authenticated();
    if (!this.page || payload.queryId !== this.page.queryId) throw new Error("STALE_SELECTION");
    const row = this.page.records.find((row) => row.planId === payload.planId);
    if (!row) throw new Error("INVALID_SELECTION");
    return { page: this.page, row };
  }

  /**
   * 周期管理依赖下线后，以当前用户可见计划中的 periodId/planTypeCode 重建只读月份索引。
   * periodId 的现网格式以 YYYYMM 开头；无法识别的历史标识原样展示，避免伪造月份。
   */
  private async salesPlanPeriodPage(
    query: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    records: Row[];
    total: number;
    size: number;
    current: number;
    pages: number;
  }> {
    if (query.status != null && query.status !== "")
      throw new Error(
        "INVALID_QUERY: period status was removed; filter visible plans by plan status instead.",
      );
    const auth = this.authenticated();
    if (typeof salesPlan.salesPlanPeriodMonthForPlanId !== "function")
      throw Object.assign(new Error("请先完成 Workbench 更新后再读取销售计划周期"), {
        code: "GEA_WORKBENCH_UPDATE_REQUIRED",
      });
    const upstreamPageSize = 200;
    const rows: Record<string, unknown>[] = [];
    let pageNo = 1;
    let pageCount = 1;
    let upstreamTotal = 0;
    do {
      const path = `/sales-plan/plans?pageNo=${pageNo}&pageSize=${upstreamPageSize}`;
      const page = object(
        await this.gatewayRequests.read(
          path,
          auth,
          AbortSignal.any([signal, this.epoch.signal]),
          true,
          "periods",
        ),
      );
      if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_PAGE");
      rows.push(...page.records.map(object));
      upstreamTotal = integer(page.total, rows.length);
      const actualSize = integer(page.size ?? upstreamPageSize, 1);
      pageCount = integer(page.pages ?? Math.ceil(upstreamTotal / actualSize), 0, 1000);
      pageNo += 1;
    } while (pageNo <= pageCount);
    if (rows.length < upstreamTotal) throw new Error("GEA_INCOMPLETE_COLLECTION");

    const selectedPlanType =
      query.planType == null || query.planType === "" ? undefined : text(query.planType);
    const discovered = new Map<string, Row>();
    for (const row of rows) {
      const periodId = text(row.periodId);
      const planTypeCode = text(row.planTypeCode);
      const periodMonth = salesPlan.salesPlanPeriodMonthForPlanId(text(row.planId));
      if (!periodMonth) throw new Error("GEA_PLAN_MONTH_SOURCE_MISSING");
      const orderType = row.orderType == null ? "" : text(row.orderType);
      const planType =
        orderType === "Z" || (selectedPlanType === "CORRECTION" && orderType === "M")
          ? "CORRECTION"
          : orderType === "M"
            ? "MONTHLY"
            : "UNKNOWN";
      if (selectedPlanType != null && planType !== selectedPlanType) continue;
      discovered.set(`${periodId}\u0000${planTypeCode}`, {
        periodId,
        tenantId: auth.tenantId,
        periodMonth,
        planType,
        planTypeCode,
        status: "UNKNOWN",
      });
    }
    const periodMonth =
      query.periodMonth == null || query.periodMonth === "" ? undefined : text(query.periodMonth);
    const records = [...discovered.values()]
      .filter((row) => periodMonth == null || row.periodMonth === periodMonth)
      .toSorted(
        (left, right) =>
          String(right.periodMonth).localeCompare(String(left.periodMonth)) ||
          String(left.periodId).localeCompare(String(right.periodId)) ||
          String(left.planTypeCode).localeCompare(String(right.planTypeCode)),
      );
    const current = integer(query.pageNo ?? 1, 1);
    const size = integer(query.pageSize ?? this.config.periodPageSize, 1, 1000);
    const start = (current - 1) * size;
    return {
      records: records.slice(start, start + size),
      total: records.length,
      size,
      current,
      pages: records.length === 0 ? 0 : Math.ceil(records.length / size),
    };
  }

  /** 返回从当前可见计划重建的周期索引，并保留分页覆盖范围。 */
  async periods(signal: AbortSignal): Promise<Collection> {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    const path = "/sales-plan/plans";
    const result = await this.salesPlanPeriodPage({}, signal);
    return this.collection(
      result,
      [
        "periodId",
        "tenantId",
        "periodMonth",
        "planType",
        "planTypeCode",
        "status",
        "submitDeadline",
        "createdAt",
        "updatedAt",
      ],
      ["periodId", "periodMonth", "planTypeCode"],
      path,
      "periodId",
    );
  }

  private collection(
    result: unknown,
    fields: string[],
    expected: string[],
    path: string,
    idKey = "id",
  ): Collection {
    const page = Array.isArray(result) ? { records: result, total: result.length } : object(result);
    if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_PAGE");
    const records = page.records.map((row) => project(row, fields));
    records.forEach((row) => text(row[idKey]));
    if (new Set(records.map((row) => row[idKey])).size !== records.length)
      throw new Error("GEA_DUPLICATE_RECORD");
    const total = page.total == null ? null : integer(page.total, records.length);
    return {
      records,
      total,
      returned: records.length,
      coverage: total === null ? "unknown" : total === records.length ? "complete" : "partial",
      fetchedAt: new Date().toISOString(),
      sourceUrl: this.base + path,
      missingFields: Object.fromEntries(
        records.map((row) => [row[idKey], expected.filter((key) => row[key] == null)]),
      ),
    };
  }

  private request(key: string, signal: AbortSignal): AbortSignal {
    this.requests.get(key)?.abort();
    const request = new AbortController();
    this.requests.set(key, request);
    this.preview = undefined;
    return AbortSignal.any([request.signal, this.queryEpoch.signal, this.epoch.signal, signal]);
  }

  /** 当前计划详情与历史版本选择分开标记。 */
  async detail(payload: Record<string, unknown>, signal: AbortSignal): Promise<Detail> {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    const { row } = this.selected(payload);
    const id = text(row.planId),
      path = "/sales-plan/plans/" + encodeURIComponent(id);
    const active = this.request("detail:" + id, signal);
    this.details.delete(id);
    const result = object(await this.gatewayRequests.read(path, this.authenticated(), active));
    const currentVersion =
      result.currentVersion == null ? null : project(result.currentVersion, versionFields);
    if (currentVersion && (currentVersion.planId !== id || !currentVersion.id))
      throw new Error("GEA_IDENTITY_MISMATCH");
    const detail: Detail = {
      planId: id,
      scope: "current-plan",
      currentVersion,
      fetchedAt: new Date().toISOString(),
      sourceUrl: this.base + path,
      missing: currentVersion
        ? versionFields.filter((key) => currentVersion[key] == null)
        : ["currentVersion"],
    };
    if (active.aborted) throw new Error("STALE_SELECTION");
    this.details.set(id, detail);
    return detail;
  }

  /** 只列出上游计划身份与所选计划一致的版本。 */
  async versions(payload: Record<string, unknown>, signal: AbortSignal): Promise<Collection> {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    const { row } = this.selected(payload);
    const id = text(row.planId),
      path = "/sales-plan/plans/" + encodeURIComponent(id) + "/versions";
    const active = this.request("versions:" + id, signal);
    this.versionsByPlan.delete(id);
    const result = this.collection(
      await this.gatewayRequests.read(path, this.authenticated(), active),
      versionFields,
      ["id", "planId", "seq", "status", "targetQty", "targetAmount"],
      path,
    );
    if (result.records.some((record) => record.planId !== id))
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (active.aborted) throw new Error("STALE_SELECTION");
    this.versionsByPlan.set(id, result);
    return result;
  }

  private selectedVersion(planId: string, versionId: unknown) {
    const versions = this.versionsByPlan.get(planId);
    const record = versions?.records.find((row) => row.id === versionId);
    if (!record || !versions) throw new Error("INVALID_VERSION");
    return {
      record,
      fetchedAt: versions.fetchedAt,
      sourceUrl: versions.sourceUrl,
      missing: versions.missingFields[String(record.id)],
    };
  }

  /** 只读取已证明属于当前查询计划的版本。 */
  async skus(payload: Record<string, unknown>, signal: AbortSignal): Promise<Collection> {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    const { row } = this.selected(payload);
    const version = this.selectedVersion(text(row.planId), payload.versionId);
    const id = text(version.record.id),
      path = "/sales-plan/plans/versions/" + encodeURIComponent(id) + "/skus";
    const active = this.request("skus:" + id, signal);
    this.skusByVersion.delete(id);
    const result = this.collection(
      await this.gatewayRequests.read(path, this.authenticated(), active),
      skuFields,
      ["skuCode", "baseQty", "qty", "price", "amt", "amtBase"],
      path,
    );
    this.materialNames.apply(result.records);
    if (result.records.some((record) => record.versionId !== id))
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (active.aborted) throw new Error("STALE_SELECTION");
    this.skusByVersion.set(id, result);
    return result;
  }

  /** 仅从 Host 已持有且已校验的数据冻结快照，生成带哈希和大小上限的模型输入。 */
  prepare(payload: Record<string, unknown>): Preview {
    this.assertModelAllowed();
    this.preview = undefined;
    keys(payload, ["queryId", "planId", "includeDetail", "versionId", "skuIds"]);
    const { page, row } = this.selected(payload);
    if (payload.includeDetail !== undefined && typeof payload.includeDetail !== "boolean")
      throw new Error("INVALID_PAYLOAD");
    const missing: string[] = [];
    const detail = payload.includeDetail ? this.details.get(text(row.planId)) : undefined;
    if (payload.includeDetail && !detail) throw new Error("DETAIL_NOT_FETCHED");
    if (!detail) missing.push("plan-detail-not-requested");
    const version =
      payload.versionId === undefined
        ? undefined
        : this.selectedVersion(text(row.planId), payload.versionId);
    if (!version) missing.push("version-not-selected");
    let skus:
      | (Collection & {
          selected: number;
          selection: "all-returned" | "subset";
        })
      | undefined;
    if (payload.skuIds !== undefined) {
      if (!version) throw new Error("INVALID_VERSION");
      const loaded = this.skusByVersion.get(text(version.record.id));
      if (!loaded) throw new Error("SKUS_NOT_FETCHED");
      if (
        !Array.isArray(payload.skuIds) ||
        payload.skuIds.some((id) => typeof id !== "string") ||
        new Set(payload.skuIds).size !== payload.skuIds.length
      )
        throw new Error("INVALID_SKU_SELECTION");
      const ids = new Set(payload.skuIds);
      const chosen = loaded.records.filter((row) => ids.has(row.id));
      if (chosen.length !== ids.size) throw new Error("INVALID_SKU_SELECTION");
      skus = {
        ...loaded,
        records: chosen,
        selected: chosen.length,
        selection: chosen.length === loaded.records.length ? "all-returned" : "subset",
        missingFields: Object.fromEntries(
          chosen.map((row) => [row.id, loaded.missingFields[String(row.id)]]),
        ),
      };
    } else missing.push("skus-not-requested");
    const { records, ...metadata } = page;
    const snapshot = {
      format: "gea-readonly-v1",
      pluginVersion: "0.0.1",
      runId: this.runId,
      ...metadata,
      pageRecordCount: records.length,
      coverage: "one-selected-plan",
      record: row,
      calculations: {
        quantityGap: difference(row, "targetQty", "currentQty"),
        amountGap: difference(row, "targetAmount", "currentAmount"),
      },
      missingFields: planFields.filter((key) => row[key] == null),
      detail,
      version,
      skus,
      missing,
    };
    return this.recordPreview(snapshot);
  }

  /** 使用当前由服务端管理的身份读取原工作台固定 GEA 端点。 */
  async workbenchQuery(payload: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    this.clearQuery();
    return this.readWorkbenchQuery(payload, signal);
  }

  private async salesPlanShipments(
    rows: Record<string, unknown>[],
    caller: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    const quantities = new Map<string, string>();
    const amounts = new Map<string, string>();
    const failures = new Map<string, string>();
    const byMonth = new Map<string, Set<string>>();
    for (const row of rows) {
      const month = salesPlan.salesPlanPeriodMonthForPlanId(text(row.planId));
      if (!month || typeof row.dealerCode !== "string" || !row.dealerCode) continue;
      const customers = byMonth.get(month) ?? new Set<string>();
      customers.add(row.dealerCode);
      byMonth.set(month, customers);
    }
    for (const [month, codes] of byMonth) {
      const customers = [...codes];
      const [year, number] = month.split("-").map(Number);
      const nextMonth =
        number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
      for (let offset = 0; offset < customers.length; offset += 100) {
        const batch = customers.slice(offset, offset + 100);
        const customerParameters: Record<string, string> = {};
        const placeholders = batch.map((customer, index) => {
          customerParameters[`customer${index}`] = customer;
          return `:customer${index}`;
        });
        const sources = [
          {
            label: "发货数量",
            field: "ship_qty",
            values: quantities,
            sql: `SELECT cust_code, CAST(SUM(qtyshipped) AS TEXT) AS ship_qty FROM agents_order_execute_isontime_mi WHERE fromorderno_month >= :start AND fromorderno_month < :end AND cust_code IN (${placeholders.join(", ")}) GROUP BY cust_code ORDER BY cust_code`,
            parameters: { start: `${month}-01`, end: `${nextMonth}-01`, ...customerParameters },
          },
          {
            label: "发货金额",
            field: "ship_amount",
            values: amounts,
            sql: `SELECT cust_code, CAST(SUM(income_excl_tax_local) AS TEXT) AS ship_amount FROM agents_scm_cust_deliv_daily_di WHERE ship_month = :month AND cust_code IN (${placeholders.join(", ")}) GROUP BY cust_code ORDER BY cust_code`,
            parameters: { month: month.replace("-", ""), ...customerParameters },
          },
        ];
        for (const source of sources) {
          try {
            const result = object(
              await this.pluginSql(
                {
                  consumerCode: this.config.analysisAgentCode,
                  sql: source.sql,
                  parameters: source.parameters,
                  pageNo: 1,
                  pageSize: 200,
                },
                signal,
              ),
            );
            if (
              !Array.isArray(result.rows) ||
              result.total !== result.rows.length ||
              (Array.isArray(result.rejectedColumns) && result.rejectedColumns.length)
            )
              throw new Error("发货数据读取不完整");
            const received = new Map<string, string>();
            for (const value of result.rows) {
              const row = object(value);
              const metric = row[source.field];
              if (
                typeof row.cust_code !== "string" ||
                !batch.includes(row.cust_code) ||
                received.has(row.cust_code) ||
                typeof metric !== "string" ||
                !/^-?\d+(?:\.\d+)?$/.test(metric)
              )
                throw new Error("发货数据格式不完整");
              received.set(row.cust_code, metric);
            }
            for (const [customer, metric] of received)
              source.values.set(`${month}\u0000${customer}`, metric);
          } catch (error) {
            signal.throwIfAborted();
            for (const customer of batch) {
              const key = `${month}\u0000${customer}`;
              const message = `${source.label}读取失败：${error instanceof Error ? error.message : "查询失败"}`;
              failures.set(key, [failures.get(key), message].filter(Boolean).join("；"));
            }
          }
        }
      }
    }
    signal.throwIfAborted();
    return rows.map((row) => {
      const month = salesPlan.salesPlanPeriodMonthForPlanId(text(row.planId));
      const key = `${month}\u0000${row.dealerCode}`;
      const progress = decimalSources([amounts.get(key), row.targetAmount]);
      return {
        ...row,
        shipQty: quantities.get(key) ?? null,
        shipAmount: amounts.get(key) ?? null,
        amountProgress:
          "values" in progress && progress.values[1].gt(0)
            ? progress.values[0].div(progress.values[1]).times(100).toFixed()
            : null,
        shipmentError:
          failures.get(key) ??
          (!quantities.has(key) || !amounts.has(key) ? "未取得该客户期间的发货数据" : null),
      };
    });
  }

  /** 为模型读取数据，不使浏览器持有的选择或预览失效。
   * @param payload 固定资源类型及已校验的查询字段。
   * @param signal 所属工具执行的取消信号。
   * @returns 带来源、时间和集合覆盖信息的精确 JSON，供 Session 日志记录。
   */
  async agentQuery(payload: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    this.assertModelAllowed();
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    const identity = this.epoch.signal;
    const transport = transportSignal(AbortSignal.any([signal, identity]));
    let value: unknown;
    try {
      value = await this.readWorkbenchQuery(payload, transport.signal, {
        forModel: true,
      });
    } catch (error) {
      signal.throwIfAborted();
      identity.throwIfAborted();
      throw error;
    } finally {
      transport.dispose();
    }
    signal.throwIfAborted();
    identity.throwIfAborted();
    const page = Array.isArray(value) ? undefined : object(value);
    const coverage =
      page && Array.isArray(page.records)
        ? page.records.length === page.total
          ? "complete"
          : "partial"
        : "complete";
    const envelope = (coverageValue: string, valueOut: unknown) =>
      JSON.stringify({
        source: "GEA_LIVE_READONLY",
        environment: this.environment,
        fetchedAt: new Date().toISOString(),
        query: payload,
        coverage: coverageValue,
        value: valueOut,
      });
    // versionSkus 的模型投影按实际返回行数续读，字节裁剪不改变下一次位置。
    // 页面自身的工作台读取仍走 readWorkbenchQuery（完整数据），不受这里影响。
    if (text(payload.kind) === "versionSkus") {
      const rows = (
        Array.isArray(value) ? value : Array.isArray(page?.records) ? page.records : []
      ).map(object);
      const skuView = (row: Record<string, unknown>) => ({
        skuCode: row.skuCode,
        productCategName: row.productCategName ?? null,
        materialDescription: row.materialDescription ?? row.skuName ?? null,
        qty: row.qty ?? null,
        amt: row.amt ?? null,
        price: row.price ?? null,
        baseQty: row.baseQty ?? null,
        amtBase: row.amtBase ?? null,
        regionConfirmedQty: row.regionConfirmedQty ?? null,
        provinceConfirmedQty: row.provinceConfirmedQty ?? null,
        areaConfirmedQty: row.areaConfirmedQty ?? null,
        categoryConfirmedQty: row.categoryConfirmedQty ?? null,
      });
      const views = rows.map(skuView);
      const query = object(payload.query ?? {});
      const requested = Math.min(50, integer(query.pageSize ?? 5, 1, 1000));
      const offset =
        query.offset === undefined
          ? (integer(query.pageNo ?? 1, 1) - 1) * requested
          : integer(query.offset, 0);
      let size = Math.max(1, Math.min(requested, views.length - offset || 1));
      for (;;) {
        const recordsPage = views.slice(offset, offset + size);
        const nextOffset = offset + recordsPage.length;
        const nextQuery =
          nextOffset < views.length
            ? {
                versionId: query.versionId,
                offset: nextOffset,
                pageSize: requested,
              }
            : null;
        const result = envelope(nextQuery === null ? "complete" : "partial", {
          records: recordsPage,
          total: views.length,
          offset,
          pageSize: recordsPage.length,
          nextQuery,
          note:
            nextQuery === null
              ? "本页为最后一页。"
              : `还有 ${views.length - nextOffset} 条：将 nextQuery 原样作为 query 继续取。`,
        });
        const resultBytes = Buffer.byteLength(result, "utf8");
        if (resultBytes <= this.config.inputByteBudget) return result;
        if (size <= 1)
          throw new Error(
            `SNAPSHOT_TOO_LARGE: 单条 SKU 投影 ${resultBytes} 字节，超过单次读取上限 ${this.config.inputByteBudget} 字节。`,
          );
        size = Math.max(1, Math.floor(size / 2));
      }
    }
    // detail：不再内联全部 SKU / 审批日志，避免"一条记录就超限"。
    if (text(payload.kind) === "detail") {
      const detail = object(value);
      const skus = Array.isArray(detail.skus) ? detail.skus.map(object) : [];
      const { skus: _skus, logs: _logs, ...head } = detail;
      const trimmed = envelope("partial", {
        ...head,
        skuCount: skus.length,
        skuSample: skus.slice(0, 3).map((row) => ({
          skuCode: row.skuCode,
          qty: row.qty ?? null,
          amt: row.amt ?? null,
        })),
        omitted:
          "已省略 SKU 明细与审批日志：需要时用 kind=versionSkus（按返回的 nextQuery 续读）或 kind=logs 单独读取。",
      });
      if (Buffer.byteLength(trimmed, "utf8") <= this.config.inputByteBudget) return trimmed;
    }
    const result = envelope(coverage, value);
    const resultBytes = Buffer.byteLength(result, "utf8");
    if (resultBytes > this.config.inputByteBudget)
      throw new Error(
        `SNAPSHOT_TOO_LARGE: 本次结果 ${resultBytes} 字节，超过单次读取上限 ${this.config.inputByteBudget} 字节。` +
          `请缩小范围后重试：list 把 pageSize 降到 5~10 并分页，versions/logs 按单个 planId 查，` +
          `需要看"用户当前这一屏"时改用 gea_visible_workbench_context。`,
      );
    return result;
  }

  private async readWorkbenchQuery(
    payload: Record<string, unknown>,
    signal: AbortSignal,
    options: { forModel?: boolean } = {},
  ): Promise<unknown> {
    keys(payload, ["kind", "query"]);
    let query = object(payload.query ?? {});
    const kind = text(payload.kind);
    this.salesReadonly?.assertQuery(kind);
    query = normalizePlanQuery(kind, query);
    if (kind === "list" && query.versionIds !== undefined) {
      if (!Array.isArray(query.versionIds) || query.versionIds.length === 0)
        throw new Error("INVALID_QUERY");
      const versionIds = query.versionIds.map((value) => text(value));
      if (versionIds.some((value) => value.includes(","))) throw new Error("INVALID_QUERY");
      query = { ...query, versionIds: [...new Set(versionIds)].join(",") };
    }
    if (kind === "list" && query.summaryOnly !== undefined) {
      if (typeof query.summaryOnly !== "boolean") throw new Error("INVALID_QUERY");
      query = { ...query, summaryOnly: String(query.summaryOnly) };
    }
    if (kind === "list" && query.statuses !== undefined) {
      if (
        !Array.isArray(query.statuses) ||
        query.statuses.length === 0 ||
        (query.status != null && query.status !== "")
      )
        throw new Error("INVALID_QUERY");
      const statuses = query.statuses.map((value) => integer(value, 0));
      query = { ...query, statuses: [...new Set(statuses)].join(",") };
    }
    if (kind === "versionSkus") {
      if (query.offset !== undefined && query.pageNo !== undefined)
        throw new Error("INVALID_QUERY: versionSkus uses either pageNo or offset from nextQuery.");
      if (query.offset !== undefined) integer(query.offset, 0);
      if (query.pageNo !== undefined) integer(query.pageNo, 1);
      if (query.pageSize !== undefined) integer(query.pageSize, 1, 1000);
    }
    if (
      kind === "periods" &&
      query.periodMonth != null &&
      !/^\d{4}-\d{2}$/.test(text(query.periodMonth).trim())
    )
      throw new Error(
        "INVALID_QUERY: periodMonth must be YYYY-MM, for example 2026-09 (Chinese month names are not accepted).",
      );
    if (query.orderType != null && !["M", "Z"].includes(String(query.orderType)))
      throw new Error("INVALID_QUERY");
    if (
      query.approvalRole != null &&
      !["region", "province", "area", "category"].includes(String(query.approvalRole))
    )
      throw new Error("INVALID_QUERY");
    if (kind === "periods") return this.salesPlanPeriodPage(query, signal);
    if (kind === "aggregate")
      return aggregateSalesPlans(
        (input, active) => this.readWorkbenchQuery(input, active),
        query,
        signal,
      );
    const id = (key: string) => encodeURIComponent(text(query[key]));
    const paths: Record<string, () => string> = {
      list: () => "/sales-plan/plans",
      detail: () => "/sales-plan/plans/" + id("planId"),
      versions: () => "/sales-plan/plans/" + id("planId") + "/versions",
      logs: () => "/sales-plan/plans/" + id("planId") + "/logs",
      versionSkus: () => "/sales-plan/plans/versions/" + id("versionId") + "/skus",
      compare: () => "/sales-plan/plans/" + id("planId") + "/compare",
    };
    if (kind === "compare") {
      text(query.fromVersionId);
      text(query.toVersionId);
    }
    // versionSkus 不分页：上游按版本返回整份 SKU，模型侧的有界分页由
    // agentQuery 的本地投影负责（见下方 versionSkus 投影分支）。若这里把
    // 它当成远端分页集合，数组结果会走进 object() 而抛 INVALID_PAYLOAD。
    const paged = kind === "periods" || kind === "list";
    const current = paged ? integer(query.pageNo ?? 1, 1) : 1;
    const size = paged
      ? integer(
          query.pageSize ??
            (kind === "periods" ? this.config.periodPageSize : this.config.pageSize),
          1,
          1000,
        )
      : 1;
    const params = new URLSearchParams();
    if (paged) {
      params.set("pageNo", String(current));
      params.set("pageSize", String(size));
    }
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === "" || key === "planId" || key === "versionId") continue;
      if (kind === "versionSkus" && ["pageNo", "pageSize", "offset"].includes(key)) continue;
      if (key === "pageNo" || key === "pageSize")
        params.set(
          key,
          String(integer(value, 1, key === "pageSize" ? 1000 : Number.MAX_SAFE_INTEGER)),
        );
      else if (key === "status" && kind !== "periods") params.set(key, String(integer(value, 0)));
      else if (key === "versionIds" || key === "statuses") params.set(key, String(value));
      else
        params.set(
          salesPlanWireKey(key),
          salesPlanQueryValue(key, key === "dealerCode" ? value : text(value)),
        );
    }
    const result = await this.gatewayRequests.read(
      paths[kind]() + (params.size ? "?" + params : ""),
      this.authenticated(),
      AbortSignal.any([signal, this.epoch.signal]),
      true,
      kind,
    );
    // AionUi 工作台消费完整数组；分页得到的 SKU 子集不能声称数据完整。
    const records = (value: unknown): Record<string, unknown>[] => {
      if (Array.isArray(value)) return value.map(object);
      const page = object(value);
      if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_COLLECTION");
      if (
        (page.total != null && integer(page.total, page.records.length) > page.records.length) ||
        (page.pages != null && integer(page.pages, 0) > 1) ||
        (page.current != null && integer(page.current, 1) > 1)
      )
        throw new Error("GEA_INCOMPLETE_COLLECTION");
      return page.records.map(object);
    };
    if (paged) {
      const page = object(result);
      if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_COLLECTION");
      const total = integer(page.total, page.records.length);
      const pageSize = integer(page.size ?? size, 1);
      const planRows = page.records.map(object);
      if (
        kind === "list" &&
        query.periodId != null &&
        query.periodId !== "" &&
        planRows.some(
          (row) =>
            (typeof row.periodId !== "string" && typeof row.periodId !== "number") ||
            String(row.periodId) !== query.periodId,
        )
      )
        throw new Error("GEA_PLAN_PERIOD_MISMATCH");
      return {
        ...page,
        ...(kind === "list" && query.orderType === "Z" && Array.isArray(page.groupMetrics)
          ? {
              groupMetrics: page.groupMetrics.map((value) => {
                const metric = { ...object(value) };
                delete metric.shipQty;
                delete metric.shipAmount;
                delete metric.amountProgress;
                delete metric.shipmentError;
                return metric;
              }),
            }
          : {}),
        records:
          kind === "list" && query.orderType === "Z"
            ? await this.salesPlanShipments(planRows, signal)
            : planRows,
        total,
        size: pageSize,
        current: integer(page.current ?? current, 1),
        pages: integer(page.pages ?? Math.ceil(total / pageSize), 0),
      };
    }
    if (kind === "detail") {
      const detail = object(result);
      const currentVersion = object(detail.currentVersion);
      const skus = records(detail.skus),
        versions = records(detail.versions),
        logs = records(detail.logs);
      this.materialNames.apply(skus);
      const versionId = text(currentVersion.id);
      const versionIds = new Set([versionId, ...versions.map((version) => text(version.id))]);
      if (
        currentVersion.planId !== query.planId ||
        versions.some((version) => version.planId !== query.planId) ||
        skus.some((sku) => sku.versionId !== versionId) ||
        logs.some((log) => log.planId !== query.planId || !versionIds.has(text(log.versionId)))
      )
        throw new Error("GEA_IDENTITY_MISMATCH");
      if (options.forModel) {
        // 模型侧只回投影后的字段：上游整包带着该计划的全部 SKU 与内部字段，
        // 直接展开必然超过输入预算，detail 会永远 SNAPSHOT_TOO_LARGE。
        const budget = Math.max(4096, Math.floor(this.config.inputByteBudget / 2));
        const cappedSkus = capRows(
          skus.map((sku) => project(sku, skuFields)),
          Math.floor(budget * 0.6),
        );
        const cappedVersions = capRows(
          versions.map((version) => project(version, versionFields)),
          Math.floor(budget * 0.2),
        );
        const cappedLogs = capRows(logs, Math.floor(budget * 0.2));
        return {
          planId: text(detail.planId ?? query.planId),
          currentVersion: project(currentVersion, versionFields),
          skus: cappedSkus.rows,
          skuCoverage: cappedSkus.omitted === 0 ? "complete" : "partial",
          ...(cappedSkus.omitted === 0
            ? {}
            : {
                skuOmitted: cappedSkus.omitted,
                skuHint:
                  "其余明细用 kind=versionSkus（传 currentVersion.id 作为 versionId）分页读取",
              }),
          versions: cappedVersions.rows,
          ...(cappedVersions.omitted === 0 ? {} : { versionsOmitted: cappedVersions.omitted }),
          logs: cappedLogs.rows,
          ...(cappedLogs.omitted === 0 ? {} : { logsOmitted: cappedLogs.omitted }),
        };
      }
      // 通知不参与审批身份：上游万一塞回 workflowApproval 也不再透传，
      // 免得这个已废弃的字段重新变成界面上的判断依据。
      const rest = { ...detail };
      delete rest.workflowApproval;
      delete rest.workflow_approval;
      return { ...rest, currentVersion, skus, versions, logs };
    }
    const values = records(result);
    if (kind === "versionSkus") this.materialNames.apply(values);
    if (
      (kind === "versions" || kind === "logs") &&
      values.some((row) => row.planId !== query.planId)
    )
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (kind === "versionSkus" && values.some((row) => row.versionId !== query.versionId))
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (
      kind === "compare" &&
      values.some((row) => {
        const before = row.before == null ? undefined : object(row.before);
        const after = row.after == null ? undefined : object(row.after);
        return (
          (before &&
            (before.versionId !== query.fromVersionId || before.skuCode !== row.skuCode)) ||
          (after && (after.versionId !== query.toVersionId || after.skuCode !== row.skuCode))
        );
      })
    )
      throw new Error("GEA_IDENTITY_MISMATCH");
    return values;
  }

  /** 工作台提交给原生会话前重新读取所有计划，避免把浏览器旧页面当成事实。 */
  async prepareWorkbench(payload: Record<string, unknown>, signal: AbortSignal): Promise<Preview> {
    this.assertModelAllowed();
    this.assertExecutionAllowed(this.config.analysisAgentCode);
    this.clearQuery();
    keys(payload, ["planIds", "scope"]);
    const scope = payload.scope === undefined ? "details" : payload.scope;
    if (scope !== "summary" && scope !== "details") throw new Error("INVALID_SELECTION");
    if (
      !Array.isArray(payload.planIds) ||
      payload.planIds.length < 1 ||
      payload.planIds.length > 100
    )
      throw new Error("INVALID_SELECTION");
    const ids = payload.planIds.map(text);
    if (new Set(ids).size !== ids.length) throw new Error("INVALID_SELECTION");
    const active = AbortSignal.any([signal, this.epoch.signal, this.queryEpoch.signal]);
    const records: unknown[] = [];
    const summaryFields = ["id", ...planFields, "effective", "createdAt"];
    // 两种范围都会重新读取并校验全部资源身份，然后才选择模型可见字段。
    for (const planId of ids) {
      const detail = object(
        await this.readWorkbenchQuery({ kind: "detail", query: { planId } }, active),
      );
      if (scope === "summary") {
        const currentVersion = project(detail.currentVersion, summaryFields);
        const skus = detail.skus as Record<string, unknown>[];
        records.push({
          planId,
          detail: { currentVersion },
          derivedTotals: {
            quantity: skuTotal(skus, "qty"),
            amount: skuTotal(skus, "amt"),
          },
          missingFields: summaryFields.filter((key) => currentVersion[key] == null),
        });
      } else records.push({ planId, detail });
    }
    active.throwIfAborted();
    const snapshot = {
      format: "gea-workbench-readonly-v1",
      source: "GEA_LIVE_READONLY",
      runId: this.runId,
      fetchedAt: new Date().toISOString(),
      sourceUrl: this.base + "/sales-plan/plans",
      scope,
      coverage:
        scope === "summary" ? "selected-plans-current-summary" : "selected-plans-current-detail",
      records,
      missing:
        scope === "summary"
          ? [
              "unselected-plans",
              "external-history",
              "sku-details-not-in-summary",
              "historical-versions-not-in-summary",
              "approval-logs-not-in-summary",
              "action-context-not-in-summary",
              "additional-version-fields-not-in-summary",
            ]
          : ["unselected-plans", "external-history", "unfetched-sku-details"],
    };
    return this.recordPreview(snapshot);
  }

  /** 记录不可变快照；会话只接收业务投影，原始快照另存为受限审计依据。 */
  private recordPreview(snapshot: object): Preview {
    const json = JSON.stringify(snapshot, null, 2);
    const snapshotHash = createHash("sha256").update(json).digest("hex");
    const prompt = businessBrief(snapshot);
    // 输入改为业务投影后，仍以原始快照的大小作为安全上限，不能借此绕过保护。
    const bytes = Buffer.byteLength(json);
    const limitBytes = Math.min(this.config.maxSnapshotBytes, this.config.inputByteBudget);
    if (bytes > limitBytes) throw new Error("SNAPSHOT_TOO_LARGE");
    this.preview = {
      previewId: brandString<PreviewId>(randomUUID()),
      snapshotHash,
      bytes,
      limitBytes,
      snapshot,
      prompt,
    };
    return this.preview;
  }

  /** 原始快照不进入会话展示，按会话标识保存为本机受限审计依据。 */
  async archivePreview(sessionId: string, preview: Preview): Promise<void> {
    if (!/^session-[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("INVALID_SESSION");
    const dir = resolve(this.config.runtimeDir, "analysis-snapshots");
    const file = resolve(dir, sessionId + ".json");
    const temp = resolve(dir, sessionId + "." + randomUUID() + ".tmp");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(
      temp,
      JSON.stringify(
        {
          schema: 1,
          sessionId,
          snapshotHash: preview.snapshotHash,
          snapshot: preview.snapshot,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await rename(temp, file);
  }

  /** 调用方、登录、查询或 Host 失效时取消待处理的准入。 */
  admissionSignal(caller: AbortSignal): AbortSignal {
    return AbortSignal.any([caller, this.epoch.signal, this.queryEpoch.signal]);
  }

  /** 仅向标准 Session 提交仍然当前的预览。 */
  prepared(id: unknown): Preview {
    this.authenticated();
    if (!this.preview || this.preview.previewId !== id) throw new Error("STALE_PREVIEW");
    return this.preview;
  }
}

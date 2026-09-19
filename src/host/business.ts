import { avatarUrl } from "./avatar.ts";
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { salesPlanDraftMatches, salesPlanDraftSnapshot, type SalesPlanLocalDraft } from '../workbench/original/workbenches/regionalApproval/models/salesPlanLocalDraftModel.ts';
import { correctionAccess, correctionAdjustments, correctionDecimal } from '../workbench/original/workbenches/regionalApproval/models/salesPlanCorrectionModel.ts';
import { salesPlanAccessForRow } from '../workbench/original/workbenches/regionalApproval/models/salesPlanAccessModel.ts';
import { salesPlanWorkflow } from '../workbench/original/salesPlanWorkflow.ts';
import { validateSalesPlanActionInput } from '../workbench/original/workbenches/regionalApproval/models/salesPlanActionModel.ts';
import type { GeaSalesPlanActionRequest } from '../workbench/original/contracts.ts';
/**
 * Host 侧业务门面：集中维护 GEA 身份、查询选择、权限校验和只读快照。
 * 浏览器只能提交资源标识与用户意图，凭证、来源数据和最终写入校验都留在这里。
 */
import { prepareGatewayMcp } from "./gateway-mcp.ts";
import { isDeepStrictEqual } from 'node:util';
import { validateServiceAccounts, serviceAccountReady, submitWithServiceAccount, type ServiceAccounts } from './service-account.ts';
import { prepareSalesPlanResubmit } from '../workbench/original/workbenches/regionalApproval/models/salesPlanSubmitModel.ts';
import type { GeaSalesPlanDetail, GeaSalesPlanPeriod, GeaSalesPlanSku } from '../workbench/original/contracts.ts';
import { readSalesPlanWorkflowConfig } from "./workflow-config.ts";
import { createHash, randomUUID } from "node:crypto";
import { brandString, type Branded } from "@deepseek-ai/dsh-brand";
import QRCode from "qrcode";
import { resolveEnvironments } from "../shared/environments.js";
import { Decimal } from "decimal.js";
import { transportSignal } from "../shared/transport-signal.ts";
import { notificationPage, notificationDetail } from "../shared/notifications.ts";
import { GeaResponseError, geaResponseError } from "../shared/gea-error.js";
import { GeaApiLogCenter, type ApiLogSnapshot } from "./api-log.ts";

export type QueryId = Branded<"gea-query">;
export type PreviewId = Branded<"gea-preview">;
export type Row = Record<string, string | number | boolean>;
export interface Deployment {
  serviceAccounts?: ServiceAccounts;
  geaBaseUrl: string;
  environment?: "production" | "test";
  geaEnvironments?: { production: string; test: string };
  pageSize: number;
  periodPageSize: number;
  requestTimeoutMs: number;
  mcpRequestTimeoutMs?: number;
  modelRequestTimeoutMs: number;
  maxSnapshotBytes: number;
  runtimeDir: string;
  analysisMode: "receipt" | "model";
  analysisModel: string;
  analysisAgentCode: string;
  analysisSource: "gea" | "direct" | "receipt";
  inputByteBudget: number;
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
    (key) =>
      ![
        "planId",
        "versionId",
        "currentQty",
        "currentAmount",
        "skuCount",
      ].includes(key),
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
        .find(
          (value): value is string =>
            typeof value === "string" && value.trim() !== "",
        );
      if (provided !== undefined && code !== undefined)
        this.remember(code, provided.trim());
      const name =
        provided?.trim() ??
        (code === undefined ? undefined : this.names.get(code));
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
const exactNumber =
  /Id$|Code$|Qty$|Amount$|^(id|qty|price|amt|amtBase|qtyDelta|amountDelta)$/;

/** 在 JavaScript 进行舍入前保留小数词法形式和不透明标识。 */
function parseJson(text: string): unknown {
  return JSON.parse(
    text,
    (key: string, value: unknown, context?: { source?: string }) => {
      if (typeof value === "number" && exactNumber.test(key)) {
        if (!context?.source) throw new Error("EXACT_JSON_RUNTIME_REQUIRED");
        return context.source;
      }
      return value;
    },
  );
}

/** 在外部 JSON 输入边界接纳一个对象。 */
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PAYLOAD");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new Error("INVALID_SELECTION");
  return value;
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function businessValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
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
    const row = Object.keys(current).length
      ? current
      : plainObject(entry.record);
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
    "默认按“本次结果、需要关注、请确认或补充、下一步”回答；没有风险时直接说明“暂未发现明显异常”。",
    "不要展示或解释系统字段、接口地址、哈希、抓取时间、JSON、字段路径、内部状态码、覆盖范围或计算中间过程；不要复述本段原文。",
    "仅在用户明确要求核对明细、审计依据或技术排查时，才补充必要的业务口径说明。不得执行审批、保存、提交或写回。",
    "",
    `业务资料（共 ${lines.length} 条计划）：`,
    ...(lines.length ? lines : ["未取得可供说明的计划资料。"]),
  ].join("\n");
}
function integer(
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("INVALID_QUERY");
  return value;
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
      .filter((key) => row[key] != null)
      .map((key) => {
        const v = row[key];
        if (!["string", "number", "boolean"].includes(typeof v))
          throw new Error("GEA_INVALID_RECORD");
        return [key, v as string | number | boolean];
      }),
  );
}
function keys(payload: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    throw new Error("INVALID_PAYLOAD");
}

function visibleWorkbenchText(value: unknown): string {
  if (typeof value !== "string" || value.length > 512)
    throw new Error("INVALID_WORKBENCH_CONTEXT");
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
        if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))
          throw new Error("INVALID_WORKBENCH_CONTEXT");
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
):
  | { values: Decimal[] }
  | { missing: "decimal-source-unavailable" | "decimal-range-exceeded" } {
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
  if ("missing" in decimals)
    return { basis: [target, current], missing: decimals.missing };
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

  private auth?: { token: string; tenantId: string; name: string; id: string; username: string; avatar?: string; permissionCodes?: string[] };
  private qr?: { id: string; loginId: string; createdAt: number };
  private epoch = new AbortController();
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
  private requests = new Map<string, AbortController>();
  private readonly materialNames = new MaterialNameIndex();
  private modelRoutes = new Map<string, GeaModelRoute>();
  private loginExpired = false;
  readonly runId = randomUUID();
  private selectedBase: string;
  private environment: "production" | "test";
  private readonly environments: Record<string, string>;
  private readonly apiLog: GeaApiLogCenter;
  get base(): string {
    return this.selectedBase;
  }

  /** 登录环境变化时取消推理和查询。 */
  identitySignal(): AbortSignal {
    return this.epoch.signal;
  }

  /** 选择已配置环境，并立即丢弃凭证、二维码和预览。 */
  selectEnvironment(payload: Record<string, unknown>) {
    keys(payload, ["environment"]);
    const environment = text(payload.environment);
    if (!Object.hasOwn(this.environments, environment))
      throw new Error("INVALID_GEA_ENVIRONMENT");
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

  constructor(readonly config: Deployment) {
    validateServiceAccounts(config.serviceAccounts);
    const resolved = resolveEnvironments(config);
    this.selectedBase = resolved.baseUrl;
    this.environment = resolved.environment as "production" | "test";
    this.environments = resolved.environments;
    this.apiLog = new GeaApiLogCenter(() => this.environment);
  }

  /** 仅桌面拥有者可用：凭证通过私有回环通道传递，绝不经浏览器 RPC。 */
  desktopLoginSnapshot(): unknown {
    return this.auth ? {schema:1,environment:this.environment,base:this.base,auth:{...this.auth}} : null;
  }
  persistentLoginSnapshot(): unknown { return this.desktopLoginSnapshot(); }
  restorePersistentLogin(value: unknown): void { this.restoreDesktopLogin(value); }
  restoreDesktopLogin(value: unknown): void {
    const saved=object(value);
    if(saved.schema!==1||typeof saved.environment!=="string"||this.environments[saved.environment]!==saved.base)throw Error("DESKTOP_LOGIN_SCOPE_MISMATCH");
    const auth=object(saved.auth);
    if(typeof auth.token!=="string"||!auth.token||auth.token.length>16384||typeof auth.tenantId!=="string"||!/^\d+$/.test(auth.tenantId))throw Error("DESKTOP_LOGIN_INVALID");
    this.clearLogin();
    this.environment=saved.environment as "production"|"test";
    this.selectedBase=this.environments[saved.environment];
    this.auth={token:auth.token,tenantId:auth.tenantId,name:text(auth.name),id:text(auth.id),username:text(auth.username),avatar:avatarUrl(auth.avatar,this.base)};
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
    this.visibleWorkbenchContexts.clear();
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
  }
  /** 清理查询缓存和未完成请求，避免新选择沿用旧身份或旧页面的数据。 */
  private clearLogin(expired = false): void {
    this.apiLog.invalidateReplays();
    this.epoch.abort();
    this.epoch = new AbortController();
    this.auth = undefined;
    this.modelRoutes.clear();
    this.resubmissions.clear();
    this.correctionRequests.clear();
    this.qr = undefined;
    this.loginExpired = expired;
    this.clearQuery();
    this.notifyIdentity();
  }

  /**
   * 浏览器推送当前已显示的最小只读投影；字段都按不可信业务数据处理。
   * 同一 sessionId 的较旧更新不会覆盖较新的页面状态。
   */
  updateVisibleWorkbenchContext(sessionId: string, payload: Record<string, unknown>): void {
    this.authenticated();
    if (!/^session-[0-9a-f-]{36}$/.test(sessionId))
      throw new Error("INVALID_WORKBENCH_SESSION");
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
    if (!/^session-[0-9a-f-]{36}$/.test(sessionId))
      throw new Error("INVALID_WORKBENCH_SESSION");
    this.visibleWorkbenchContexts.delete(sessionId);
  }

  /** 只返回当前 Agent 会话的页面范围，不重新读取 GEA，也不执行任何写操作。 */
  visibleWorkbenchContext(sessionId: string): string {
    const value = this.visibleWorkbenchContexts.get(sessionId);
    if (!value)
      return JSON.stringify({
        source: "GEA_RENDERED_WORKBENCH",
        coverage: "none",
        authority: "read-only-ui-context",
        availability: "unavailable",
        code: "WORKBENCH_CONTEXT_NOT_SYNCED",
        reason: "当前工作台页面数据仍在同步，请稍后重试",
      });
    return JSON.stringify({
      source: "GEA_RENDERED_WORKBENCH",
      renderedAt: value.receivedAt,
      coverage: "current-visible-page",
      authority: "read-only-ui-context",
      context: value.context,
    });
  }

  /** 首屏查询尚未完成时给浏览器一点时间把当前页快照同步进来。 */
  async waitVisibleWorkbenchContext(sessionId: string, timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.visibleWorkbenchContexts.has(sessionId)) return this.visibleWorkbenchContext(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.visibleWorkbenchContext(sessionId);
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
        const identity = object(await this.get("/sys/user/getUserInfo", auth, AbortSignal.any([signal, this.epoch.signal])));
        const user = object(identity.userInfo);
        if (this.auth !== auth || String(user.id) !== auth.id) return;
        const avatar = avatarUrl(user.avatar, this.base);
        if (avatar) { auth.avatar = avatar; this.notifyIdentity(); }
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
        const result = object(await this.get('/sys/permission/getPermCode', auth,
          AbortSignal.any([signal, this.epoch.signal])));
        if (!Array.isArray(result.codeList) || result.codeList.some(code => typeof code !== 'string'))
          throw new Error('GEA_INVALID_PERMISSION_CODES');
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

  /** 对外状态永远不包含 GEA 凭证。 */
  status() {
    const models = this.modelRoutes.get(this.config.analysisAgentCode)?.models;
    return {
      environment: this.environment,
      environments: Object.keys(this.environments),
      authenticated: Boolean(this.auth),
      resubmitConnected: serviceAccountReady(this.config.serviceAccounts?.[this.environment], this.auth),
      loginState: this.auth
        ? "authenticated"
        : this.loginExpired
          ? "expired"
          : "signed-out",
      permissionCodes: this.auth?.permissionCodes,
      user: this.auth
        ? { name: this.auth.name, tenantId: this.auth.tenantId, id: this.auth.id, username: this.auth.username, avatar: this.auth.avatar }
        : null,
      source: this.base,
      provider:
        this.config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
      model:
        models?.length && !models.includes(this.config.analysisModel)
          ? models[0]
          : this.config.analysisModel,
      discoveredModels: models ?? [],
      mode: this.config.analysisMode,
      runId: this.runId,
    };
  }

  private async get(
    path: string,
    identity: { token: string; tenantId?: string } | undefined,
    signal: AbortSignal,
    includeTenant = true,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (identity)
      Object.assign(headers, {
        "X-Access-Token": identity.token,
        ...(includeTenant && identity.tenantId
          ? { "X-Tenant-Id": identity.tenantId }
          : {}),
        "X-Request-Id": randomUUID(),
      });
    let response: Response;
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    try {
      response = await this.apiLog.fetch(this.base + path, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, timeout]),
      });
    } catch {
      if (signal.aborted) throw new Error("STALE_SELECTION");
      if (timeout.aborted) throw new Error("GEA_REQUEST_TIMEOUT");
      throw new Error("GEA_NETWORK_ERROR");
    }
    if (signal.aborted) throw new Error("STALE_SELECTION");
    if (!response.ok) {
      const error = await geaResponseError(response, [identity?.token]);
      if (response.status === 401 && this.auth?.token === identity?.token)
        this.clearLogin(true);
      throw error;
    }
    let data: Record<string, unknown>;
    try {
      data = object(parseJson(await response.text()));
    } catch {
      if (signal.aborted) throw new Error("STALE_SELECTION");
      if (timeout.aborted) throw new Error("GEA_REQUEST_TIMEOUT");
      throw new Error("GEA_INVALID_JSON");
    }
    if (signal.aborted) throw new Error("STALE_SELECTION");
    if (data.success !== true) {
      if (
        typeof data.errorCode === "string" &&
        /^NOTIFICATION_[A-Z_]+$/.test(data.errorCode)
      ) {
        if (
          data.errorCode === "NOTIFICATION_UNAUTHENTICATED" &&
          this.auth?.token === identity?.token
        )
          this.clearLogin(true);
        throw new Error(data.errorCode);
      }
      throw new Error("GEA_REQUEST_REJECTED");
    }
    return data.result;
  }

  private authenticated(): NonNullable<Business["auth"]> {
    if (!this.auth) throw new Error("LOGIN_REQUIRED");
    return this.auth;
  }

  /** 将服务端最新分配的审批任务匹配到指定销售计划版本。 */
  private async workflowApproval(versionId: string, caller: AbortSignal) {
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    let pageNo = 1;
    while (true) {
      const page = object(await this.get(`/api/v1/notifications?pageNo=${pageNo}&pageSize=100`, auth, signal));
      if (!Array.isArray(page.items)) throw new Error("NOTIFICATION_INVALID_RESPONSE");
      for (const item of page.items) {
        const row = object(item);
        const approval = row.approval == null ? undefined : object(row.approval);
        if (approval?.biz_key !== `sales-plan:version:${versionId}` || approval.actionable !== true) continue;
        const fresh = object(await this.get("/api/v1/notifications/" + encodeURIComponent(text(row.id)), auth, signal));
        const confirmed = fresh.approval == null ? undefined : object(fresh.approval);
        if (fresh.id !== row.id) throw new Error("NOTIFICATION_INVALID_RESPONSE");
        if (confirmed?.biz_key === `sales-plan:version:${versionId}` && confirmed.actionable === true) {
          if (this.auth !== auth) throw new Error("STALE_LOGIN");
          return { versionId, notificationId: text(row.id), instanceId: text(confirmed.instance_id), actionable: true as const };
        }
      }
      const total = integer(page.total, 0);
      if (pageNo * 100 >= total) return undefined;
      if (!page.items.length || pageNo >= 100) throw new Error("NOTIFICATION_SCAN_INCOMPLETE");
      pageNo++;
    }
  }

  /** 持久化私有草稿属于当前登录身份，绝不会调用 GEA 动作。 */
  async salesPlanDraft(payload: Record<string, unknown>, caller: AbortSignal) {
    keys(payload, ['planId', 'versionId', 'draft']);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    const planId = text(payload.planId), versionId = text(payload.versionId);
    const owner = createHash('sha256').update(JSON.stringify([this.base, auth.tenantId, auth.id, planId, versionId])).digest('hex');
    const dir = resolve(this.config.runtimeDir, 'approval-drafts');
    const file = resolve(dir, owner + '.json');
    const detail = await this.workbenchQuery({kind: 'detail', query: {planId}}, signal) as GeaSalesPlanDetail;
    const row = {planId, versionId, status: detail.currentVersion.status, planTypeCode: detail.currentVersion.planTypeCode};
    const sourceSnapshot = salesPlanDraftSnapshot(row, detail);
    if (!sourceSnapshot) throw new Error('STALE_DRAFT_VERSION');
    if (payload.draft !== undefined) {
      const access = salesPlanAccessForRow(row, detail);
      if (!access?.snapshotHash || !access.allowedActions.includes('APPROVE')) throw new Error('GEA_DRAFT_NOT_EDITABLE');
      const draft = payload.draft as SalesPlanLocalDraft;
      if (!salesPlanDraftMatches(draft, row, detail)) throw new Error('STALE_DRAFT');
      const value = {draft, savedAt: new Date().toISOString(), storage: 'host'};
      signal.throwIfAborted();
      await mkdir(dir, {recursive: true, mode: 0o700});
      const temp = resolve(dir, owner + '.' + randomUUID() + '.tmp');
      await writeFile(temp, JSON.stringify(value), {mode: 0o600});
      signal.throwIfAborted();
      await rename(temp, file);
      return value;
    }
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      signal.throwIfAborted();
      if (!salesPlanDraftMatches(stored.draft, row, detail)) return {draft: null, stale: true, sourceSnapshot};
      return {...stored, sourceSnapshot};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {draft: null, sourceSnapshot};
    }
  }

  /** 使用当前 Host 身份读取完整工作流配置。 */
  async workflowConfig(payload: Record<string, unknown>, caller: AbortSignal) {
    keys(payload, []);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    return readSalesPlanWorkflowConfig(this.base, auth.token, this.apiLog.fetch, signal);
  }

  /** 在本次登录生命周期内，将一个幂等键绑定到一份已校验请求。 */
  private resubmissions = new Map<string, { fingerprint: string; body?: string; flight?: Promise<unknown>; receipt?: unknown }>();

  /** 重提前重新读取 GEA 当前版本和 SKU；浏览器只允许改变数量，身份、价格与路由由服务端来源决定。 */
  async salesPlanSubmit(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    keys(payload, ['source', 'request', 'requestId', 'idempotencyKey']);
    const auth = this.authenticated();
    const config = this.config.serviceAccounts?.[this.environment];
    if (!config || !serviceAccountReady(config, auth)) throw new GeaResponseError(403, { message: '当前环境尚未配置当前用户可用的重提服务账号' });
    const source = object(payload.source); keys(source, ['planId', 'versionId']);
    const planId = text(source.planId), versionId = text(source.versionId);
    const request = object(payload.request);
    const requestId = text(payload.requestId), idempotencyKey = text(payload.idempotencyKey);
    if (!/^[A-Za-z0-9:_-]{1,64}$/.test(requestId) || !/^[A-Za-z0-9:_-]{1,128}$/.test(idempotencyKey)) throw new Error('INVALID_PAYLOAD');
    const fingerprint = JSON.stringify(payload);
    let entry = this.resubmissions.get(idempotencyKey);
    if (entry && entry.fingerprint !== fingerprint) throw new GeaResponseError(409, { message: '幂等键已绑定其他重提请求' });
    if (entry?.receipt) return entry.receipt;
    if (entry?.flight) return entry.flight;
    if (!entry) { entry = { fingerprint }; this.resubmissions.set(idempotencyKey, entry); }
    const attempt = entry;
    const signal = AbortSignal.any([caller, this.epoch.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    const run = async () => {
      if (!attempt.body) {
        const detail = await this.workbenchQuery({ kind: 'detail', query: { planId } }, signal) as GeaSalesPlanDetail;
        const version = detail.currentVersion;
        if (version.id !== versionId || !version.effective || ![6, 7, 8, 9].includes(version.status))
          throw new GeaResponseError(409, { message: '计划已变化，请刷新后核对重提版本' });
        const periods = object(await this.workbenchQuery({ kind: 'periods', query: { periodMonth: request.periodMonth, pageSize: this.config.periodPageSize } }, signal));
        const period = (periods.records as GeaSalesPlanPeriod[]).find(row => row.periodId === version.periodId && row.planTypeCode === version.planTypeCode);
        if (!period) throw new GeaResponseError(409, { message: '未找到当前计划对应的周期，请刷新后核对' });
        const skus = await this.workbenchQuery({ kind: 'versionSkus', query: { versionId } }, signal) as GeaSalesPlanSku[];
        if (!Array.isArray(request.items) || request.items.length !== skus.length) throw new Error('INVALID_PAYLOAD');
        const items = request.items.map(object);
        if (new Set(items.map(row => row.skuCode)).size !== skus.length) throw new Error('INVALID_PAYLOAD');
        const edited = skus.map(sku => {
          const item = items.find(row => row.skuCode === sku.skuCode);
          if (!item || typeof item.qty !== 'string') throw new Error('INVALID_PAYLOAD');
          if(version.orderType === 'Z') {
            if(!correctionDecimal(item.qty).eq(correctionDecimal(sku.qty)) || typeof item.adjAddQty !== 'string' || typeof item.adjCutQty !== 'string') throw new Error('INVALID_PAYLOAD');
            return {...sku,adjAddQty:item.adjAddQty,adjCutQty:item.adjCutQty};
          }
          return { ...sku, qty: item.qty };
        });
        const rows = await this.workflowConfig({}, signal);
        const prepared = prepareSalesPlanResubmit({ planId, versionId, detail, period, skus: edited, currentUser: auth }, rows);
        // 浏览器只能改变数量；身份、价格和路由必须来自 GEA。
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(prepared.request)), request)) throw new GeaResponseError(409, { message: '提交数据与当前 GEA 来源不一致，请重新核对' });
        if (this.auth !== auth) throw new Error('STALE_LOGIN');
        signal.throwIfAborted();
        attempt.body = JSON.stringify(prepared.request);
      }
      const receipt = await submitWithServiceAccount(config, this.base, attempt.body, requestId, idempotencyKey, signal, this.apiLog.fetch);
      attempt.receipt = receipt;
      return receipt;
    };
    attempt.flight = run().finally(() => { attempt.flight = undefined; });
    return attempt.flight;
  }

  private correctionRequests = new Map<string, { fingerprint:string; validated:boolean; flight?:Promise<unknown>; receipt?:unknown }>();

  /** 审批动作按幂等键缓存；即使首次响应丢失，重试也只能重放同一已授权意图。 */
  async salesPlanAction(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    this.authenticated();
    if(object(payload.request).adjustmentMode == null && object(payload.request).approvalRole == null)return this.executeSalesPlanAction(payload,caller);
    const key=text(payload.idempotencyKey), fingerprint=JSON.stringify(payload);
    let entry=this.correctionRequests.get(key);
    if(entry && entry.fingerprint !== fingerprint)throw new GeaResponseError(409,{message:'幂等键已绑定另一审批请求'});
    if(entry?.receipt)return entry.receipt;
    if(entry?.flight)return entry.flight;
    if(!entry){entry={fingerprint,validated:false};this.correctionRequests.set(key,entry);}
    const intent=entry;
    intent.flight=this.executeSalesPlanAction(payload,caller,intent.validated,()=>{intent.validated=true;})
      .then(receipt=>{intent.receipt=receipt;return receipt;}).finally(()=>{intent.flight=undefined;});
    return intent.flight;
  }

  /** 执行一次已完成来源、角色和快照校验的 GEA 动作；DMS 写回有意不在此方法内。 */
  private async executeSalesPlanAction(payload: Record<string, unknown>, caller: AbortSignal, validatedCorrection=false, onValidated=()=>{}): Promise<unknown> {
    keys(payload, ["planId", "versionId", "request", "idempotencyKey", "requestId"]);
    const versionId = text(payload.versionId);
    const request = object(payload.request);
    keys(request, ["expectedSnapshot", "action", "expectedStatus", "remark", "adjustments", "adjustmentMode", "approvalRole", "approvalPolicy"]);
    if (!["SAVE", "APPROVE", "REJECT"].includes(text(request.action))) throw new Error("INVALID_ACTION");
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    if (![1,2,3,4,6,7,8,9].includes(request.expectedStatus as number))
      throw new GeaResponseError(400, {message:'未提交、已完成或无效状态不允许写入'});
    if (request.adjustmentMode == null && (request.expectedStatus as number) >= 6 && (request.expectedStatus as number) <= 9)
      throw new GeaResponseError(400, {message:'已退回记录只能通过纠偏重提流程再次提交'});
    if (request.approvalRole == null && request.adjustmentMode == null && request.action !== 'SAVE')
      throw new GeaResponseError(400,{message:'请明确本次审批角色'});
    if (request.approvalPolicy != null && (request.approvalPolicy !== 'role-visible-v1' || !request.approvalRole)) throw new Error('INVALID_PAYLOAD');
    if (request.approvalRole != null && !validatedCorrection) {
      if (!['region','province','area','category'].includes(text(request.approvalRole))) throw new Error('INVALID_PAYLOAD');
      const planId = text(payload.planId);
      const detail = await this.workbenchQuery({kind:'detail',query:{planId}},signal) as GeaSalesPlanDetail;
      await this.refreshPermissions(signal);
      const row = {planId,versionId,status:request.expectedStatus as number,planTypeCode:detail.currentVersion.planTypeCode};
      const role = request.approvalRole as NonNullable<GeaSalesPlanActionRequest['approvalRole']>;
      const workflowRows = await this.workflowConfig({}, signal);
      const access = salesPlanAccessForRow(row, detail, auth.permissionCodes, role, workflowRows);
      if (!access?.allowedActions.includes(request.action as GeaSalesPlanActionRequest['action']))
        throw new GeaResponseError(403,{message:'当前角色不具备该版本的操作权限'});
      if (request.expectedSnapshot !== access.snapshotHash)
        throw new GeaResponseError(409,{message:'审批依据已变化，请刷新后重试'});
      if (request.approvalPolicy === 'role-visible-v1' ? !access.roleContractSupported :
          access.roleContractSupported || salesPlanWorkflow(row.planTypeCode, workflowRows).actor(row.status) !== role)
        throw new GeaResponseError(409,{message:'GEA 尚未支持本次角色审批契约，请升级服务端后重试'});
      validateSalesPlanActionInput({planId,versionId,planTypeCode:row.planTypeCode,request:request as GeaSalesPlanActionRequest}, workflowRows);
      if (this.auth !== auth) throw new Error('STALE_LOGIN');
    }
    if (request.adjustmentMode != null && !validatedCorrection) {
      if (request.adjustmentMode !== 'ABSOLUTE_NET') throw new Error('INVALID_PAYLOAD');
      const planId=text(payload.planId);
      const detail=await this.workbenchQuery({kind:'detail',query:{planId}},signal) as GeaSalesPlanDetail;
      const workflowRows=await this.workflowConfig({},signal);
      const access=correctionAccess(detail,workflowRows,request.approvalRole as GeaSalesPlanActionRequest['approvalRole']);
      if (!access || !access.allowedActions.includes(request.action as GeaSalesPlanActionRequest['action']) || !detail.currentVersion.submitter || detail.currentVersion.submitter === auth.id)
        throw new GeaResponseError(403,{message:'纠偏契约、月初终审或角色权限未获确认'});
      if (detail.currentVersion.id !== versionId || access.status !== request.expectedStatus || access.snapshotHash !== request.expectedSnapshot)
        throw new GeaResponseError(409,{message:'纠偏版本或快照已变化，请刷新'});
      const typed=request as GeaSalesPlanActionRequest;
      validateSalesPlanActionInput({planId,versionId,planTypeCode:detail.currentVersion.planTypeCode,request:typed},workflowRows);
      if (typed.action !== 'REJECT') {
        const edits=Object.fromEntries((typed.adjustments??[]).map(x=>[x.skuCode,x.adjustQty]));
        if (Object.keys(edits).some(code=>!detail.skus.some(sku=>sku.skuCode===code))) throw new Error('INVALID_PAYLOAD');
        const expected=correctionAdjustments(detail,edits,workflowRows,request.approvalRole as GeaSalesPlanActionRequest['approvalRole']);
        if (!isDeepStrictEqual(expected,typed.adjustments)) throw new GeaResponseError(400,{message:'纠偏必须提交完整的本节点绝对调整决定'});
      }
      if (this.auth !== auth) throw new Error('STALE_LOGIN');
      signal.throwIfAborted();
    } else if (request.adjustmentMode == null && request.action === "SAVE" && request.approvalRole == null) {
      if (request.expectedStatus === 5) throw new GeaResponseError(400, { message: "状态 5 不允许保存调整" });
      const planId = text(payload.planId);
      const detail = object(await this.workbenchQuery({ kind: "detail", query: { planId } }, signal));
      const version = object(detail.currentVersion);
      const capability = detail.actionContext == null ? undefined : object(detail.actionContext);
      if (!capability || !Array.isArray(capability.allowedActions) || !capability.allowedActions.includes("SAVE"))
        throw new GeaResponseError(403, { message: "服务端未授予当前版本 SAVE 能力" });
      if (version.id !== versionId || version.planId !== planId || version.effective !== true ||
          version.status !== request.expectedStatus || capability.versionId !== versionId ||
          capability.status !== request.expectedStatus || !/^[a-f0-9]{64}$/.test(String(capability.snapshotHash)) ||
          capability.snapshotHash !== request.expectedSnapshot)
        throw new GeaResponseError(409, { message: "版本或快照已变化，请回读后核对保存结果" });
      if (this.auth !== auth) throw new Error("STALE_LOGIN");
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    onValidated();
    const body = JSON.stringify(request);
    const response = await this.apiLog.fetch(this.base + "/sales-plan/plans/versions/" + encodeURIComponent(versionId) + "/actions", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Access-Token": auth.token, "X-Tenant-Id": auth.tenantId, "X-Request-Id": text(payload.requestId), "Idempotency-Key": text(payload.idempotencyKey) }, body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    });
    if (!response.ok) { if (response.status === 401) this.clearLogin(true); throw await geaResponseError(response, [auth.token]); }
    const data = object(parseJson(await response.text()));
    if (data.success !== true || !data.result) throw new Error("GEA_WRITE_REJECTED");
    if(this.auth !== auth)throw new Error('STALE_LOGIN');
    signal.throwIfAborted();
    return data.result;
  }

  /** 使用当前 Host 身份读取固定通知端点，不改变计划选择。 */
  async notifications(payload: Record<string, unknown>, caller: AbortSignal) {
    keys(payload, ["pageNo", "pageSize", "state", "states", "eventType", "id", "operation", "expectedVersion", "idempotencyKey", "items", "action", "targetUserId", "comment"]);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    const operation = payload.operation === undefined ? undefined : text(payload.operation);
    if (operation !== undefined && !["unread-count", "read", "dismiss", "batch-read", "approval-action"].includes(operation)) throw new Error("INVALID_PAYLOAD");
    if (operation === "unread-count") {
      return { environment: this.environment, fetchedAt: new Date().toISOString(), count: object(await this.get("/api/v1/notifications/unread-count", auth, signal)).count };
    }
    if (operation === "read" || operation === "dismiss") {
      keys(payload, ["operation", "id", "expectedVersion", "idempotencyKey"]);
      const id = text(payload.id);
      const expectedVersion = versionNumber(payload.expectedVersion);
      const idempotencyKey = text(payload.idempotencyKey);
      if (operation === "dismiss") {
        const detail = notificationDetail(await this.get(`/api/v1/notifications/${encodeURIComponent(id)}`, auth, signal), id);
        if (detail.dismissible !== true) throw new Error("NOTIFICATION_NOT_DISMISSIBLE");
      }
      return await this.postJson(`/api/v1/notifications/${encodeURIComponent(id)}/${operation}`, auth, signal, { expectedVersion: String(expectedVersion), idempotencyKey });
    }
    if (operation === "batch-read") {
      keys(payload, ["operation", "items", "idempotencyKey"]);
      if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) throw new Error("INVALID_PAYLOAD");
      const items = payload.items.map((item) => {
        const row = object(item);
        keys(row, ["notificationId", "expectedVersion"]);
        return { notification_id: text(row.notificationId), expected_version: String(versionNumber(row.expectedVersion)) };
      });
      if (new Set(items.map(item => item.notification_id)).size !== items.length) throw new Error("INVALID_PAYLOAD");
      return await this.postJson("/api/v1/notifications/batch-read", auth, signal, { idempotency_key: text(payload.idempotencyKey), items });
    }
    if (operation === "approval-action") {
      keys(payload, ["operation", "id", "action", "targetUserId", "comment", "expectedVersion", "idempotencyKey"]);
      const id = text(payload.id);
      const action = text(payload.action);
      if (!["APPROVE", "REJECT", "TRANSFER"].includes(action)) throw new Error("INVALID_PAYLOAD");
      if (action === "TRANSFER") text(payload.targetUserId);
      if (payload.comment != null && (typeof payload.comment !== "string" || payload.comment.length > 500)) throw new Error("INVALID_PAYLOAD");
      return await this.postJson(`/api/v1/notifications/${encodeURIComponent(id)}/approval-action`, auth, signal, {
        action, target_user_id: payload.targetUserId == null ? null : text(payload.targetUserId),
        comment: payload.comment ?? null,
        expected_version: versionNumber(payload.expectedVersion), idempotency_key: text(payload.idempotencyKey),
      });
    }
    let path = "/api/v1/notifications";
    keys(payload, ["pageNo", "pageSize", "state", "states", "eventType", "id"]);
    if (payload.id !== undefined) {
      if (payload.pageNo !== undefined || payload.state !== undefined || payload.states !== undefined || payload.eventType !== undefined)
        throw new Error("INVALID_PAYLOAD");
      path += "/" + encodeURIComponent(text(payload.id));
    } else {
      const query = new URLSearchParams({
        pageNo: String(integer(payload.pageNo ?? 1, 1, 100000)),
        pageSize: String(integer(payload.pageSize ?? this.config.pageSize, 1, 100)),
      });
      if (payload.state !== undefined && payload.state !== "")
        query.set("state", text(payload.state));
      if (payload.states !== undefined && payload.states !== "") query.set("states", text(payload.states));
      if (payload.eventType !== undefined && payload.eventType !== "") query.set("eventType", text(payload.eventType));
      path += "?" + query;
    }
    const value = await this.get(path, auth, signal);
    signal.throwIfAborted();
    return {
      environment: this.environment,
      fetchedAt: new Date().toISOString(),
      ...(payload.id === undefined
        ? notificationPage(value, integer(payload.pageSize ?? this.config.pageSize, 1, 100))
        : { detail: notificationDetail(value, text(payload.id)) }),
    };
  }

  private async postJson(path: string, identity: { token: string; tenantId?: string }, signal: AbortSignal, body: unknown): Promise<unknown> {
    let response: Response;
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    signal.throwIfAborted();
    try {
      response = await this.apiLog.fetch(this.base + path, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Access-Token": identity.token, ...(identity.tenantId ? { "X-Tenant-Id": identity.tenantId } : {}), "X-Request-Id": randomUUID() }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, timeout]) });
    } catch {
      if (signal.aborted) throw new Error("STALE_SELECTION");
      if (timeout.aborted) throw new Error("GEA_REQUEST_TIMEOUT");
      throw new Error("GEA_NETWORK_ERROR");
    }
    signal.throwIfAborted();
    if (this.auth !== identity) throw new Error("STALE_LOGIN");
    if (!response.ok) { if (response.status === 401) this.clearLogin(true); throw await geaResponseError(response, [identity.token]); }
    const data = object(parseJson(await response.text()));
    signal.throwIfAborted();
    if (data.success !== true) {
      if (typeof data.errorCode === "string" && /^(NOTIFICATION|APPROVAL)_[A-Z_]+$/.test(data.errorCode)) {
        if (data.errorCode === "NOTIFICATION_UNAUTHENTICATED") this.clearLogin(true);
        throw new Error(data.errorCode);
      }
      throw new Error("GEA_REQUEST_REJECTED");
    }
    return data.result;
  }

  /** 解析当前登录用户的 GEA 个人模型路由，但不向浏览器暴露密钥。 */
  async modelRoute(
    signal: AbortSignal,
    agentCode = "sales_forecast",
  ): Promise<GeaModelRoute> {
    const auth = this.authenticated();
    const epoch = this.epoch.signal;
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(agentCode))
      throw new Error("GEA_MODEL_AGENT_INVALID");
    const cached = this.modelRoutes.get(agentCode);
    if (cached) return cached;
    const credentialResult = object(
      await this.get(
        "/aidata/user-agent-credential/my/list?pageNo=1&pageSize=10",
        auth,
        AbortSignal.any([signal, epoch]),
        false,
      ),
    );
    const records = Array.isArray(credentialResult.records)
      ? credentialResult.records
      : [];
    if (records.length > 1) throw new Error("GEA_MODEL_CREDENTIAL_AMBIGUOUS");
    const credential = records[0] ? object(records[0]) : undefined;
    if (!credential) throw new Error("GEA_MODEL_CREDENTIAL_MISSING");
    const status = credential.status;
    if (status === "DISABLED" || status === "REVOKED")
      throw new Error("GEA_MODEL_CREDENTIAL_DISABLED");
    const credentialId = text(credential.credentialId ?? credential.id);
    const claim = await this.post(
      "/aidata/user-agent-credential/my/claim?id=" +
        encodeURIComponent(credentialId),
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
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
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
        signal: AbortSignal.any([
          signal,
          epoch,
          AbortSignal.timeout(this.config.requestTimeoutMs),
        ]),
      });
    } catch {
      throw new Error("GEA_MODEL_NETWORK_ERROR");
    }
    if (!response.ok) {
      if (response.status === 401) this.clearLogin(true);
      throw new Error("GEA_MODEL_HTTP_" + response.status);
    }
    const modelsPayload = object(await response.json());
    if (!Array.isArray(modelsPayload.data))
      throw new Error("GEA_MODEL_INVALID_RESPONSE");
    const models = modelsPayload.data.map((entry) =>
      typeof entry === "string" ? entry : text(object(entry).id),
    );
    if (!models.length) throw new Error("GEA_MODEL_EMPTY");
    const names: Record<string, string> = {};
    for (const id of [...new Set(models)]) {
      const item = modelsPayload.data.find(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          object(entry).id === id,
      );
      let label =
        item && typeof item === "object" ? object(item).name : undefined;
      if (typeof label !== "string" || !label.trim()) {
        try {
          const metadata = object(
            await this.get(
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
    };
    epoch.throwIfAborted();
    signal.throwIfAborted();
    this.modelRoutes.set(agentCode, route);
    return route;
  }

  private async post(
    path: string,
    identity: { token: string; tenantId?: string },
    signal: AbortSignal,
    includeTenant = true,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.apiLog.fetch(this.base + path, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Access-Token": identity.token,
          ...(includeTenant && identity.tenantId
            ? { "X-Tenant-Id": identity.tenantId }
            : {}),
          "X-Request-Id": randomUUID(),
        },
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.requestTimeoutMs),
        ]),
      });
    } catch {
      throw new Error("GEA_NETWORK_ERROR");
    }
    if (!response.ok) {
      if (response.status === 401) this.clearLogin(true);
      throw new Error("GEA_MODEL_HTTP_" + response.status);
    }
    const data = object(parseJson(await response.text()));
    if (data.success !== true) throw new Error("GEA_MODEL_REQUEST_REJECTED");
    return data.result;
  }

  /** 重启二维码登录，并使旧身份留下的所有选择失效。 */
  async loginStart(signal: AbortSignal, payload: Record<string, unknown> = {}) {
    keys(payload, ["environment"]);
    if (payload.environment !== undefined)
      this.selectEnvironment({ environment: payload.environment });
    this.clearLogin();
    const epoch = this.epoch.signal;
    const result = object(
      await this.get(
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
    if (!this.qr || payload.loginId !== this.qr.loginId)
      throw new Error("STALE_LOGIN");
    const qr = this.qr;
    if (Date.now() - qr.createdAt >= 120000) return { status: "expired" };
    const epoch = this.epoch.signal;
    const combined = AbortSignal.any([epoch, signal]);
    const result = object(
      await this.get(
        "/sys/getQrcodeToken?qrcodeId=" + encodeURIComponent(qr.id),
        undefined,
        combined,
      ),
    );
    if (result.token === "-1") return { status: "pending" };
    if (result.token === "-2") return { status: "expired" };
    if (result.success !== true) throw new Error("GEA_INVALID_LOGIN");
    if (
      typeof result.token !== "string" ||
      !result.token.trim() ||
      result.token.length > 16384
    )
      throw new Error("GEA_INVALID_LOGIN");
    const token = result.token;
    const identity = object(
      await this.get("/sys/user/getUserInfo", { token }, combined),
    );
    const user = object(identity.userInfo);
    const tenantId = String(user.loginTenantId ?? user.tenantId ?? "");
    if (!user.id || !/^\d+$/.test(tenantId))
      throw new Error("GEA_IDENTITY_INCOMPLETE");
    const name = text(user.realname || user.username);
    if (epoch.aborted || this.qr !== qr) throw new Error("STALE_LOGIN");
    this.auth = { token, tenantId, name, id: text(user.id), username: text(user.username || user.realname), avatar: avatarUrl(user.avatar, this.base) };
    this.qr = undefined;
    await this.refreshPermissions(combined);
    combined.throwIfAborted();
    this.notifyIdentity();
    return { status: "authenticated", ...this.status() };
  }

  /** 只使用当前进程登录准备 Gateway 传输能力。 */
  async openMcpConnection(consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string }, signal: AbortSignal) {
    const auth = this.authenticated();
    const identity = this.epoch.signal;
    return prepareGatewayMcp(this.base, auth, consumer, AbortSignal.any([signal, identity]), this.config.mcpRequestTimeoutMs ?? 60000, this.apiLog.fetch);
  }

  /** 向模型适配器提供同一套脱敏日志边界，浏览器永远拿不到原始凭证。 */
  fetchExternal(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return this.apiLog.fetch(input, init);
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
  apiLogReplay(payload: Record<string, unknown>, signal: AbortSignal) {
    keys(payload, ["id", "confirmed"]);
    this.authenticated();
    if (payload.confirmed !== true && payload.confirmed !== false)
      throw new Error("INVALID_PAYLOAD");
    return this.apiLog.replay(text(payload.id), payload.confirmed, signal);
  }

  /** 开启新分页查询时立即失效旧选择，后续 detail/version/SKU 只能引用本次页面。 */
  async plans(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Page> {
    this.clearQuery();
    const auth = this.authenticated();
    keys(payload, ["pageNo", "pageSize", "periodId", "planTypeCode", "status"]);
    const current = integer(payload.pageNo ?? 1, 1),
      size = integer(
        payload.pageSize ?? this.config.pageSize,
        1,
        this.config.pageSize,
      );
    const query = new URLSearchParams({
      pageNo: String(current),
      pageSize: String(size),
    });
    for (const key of ["periodId", "planTypeCode", "status"]) {
      if (payload[key] === undefined || payload[key] === "") continue;
      const value = text(payload[key]);
      if (key === "status" && !/^\d+$/.test(value))
        throw new Error("INVALID_QUERY");
      query.set(key, value);
    }
    const epoch = this.queryEpoch.signal;
    const page = object(
      await this.get(
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
    if (!this.page || payload.queryId !== this.page.queryId)
      throw new Error("STALE_SELECTION");
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
  ): Promise<{ records: Row[]; total: number; size: number; current: number; pages: number }> {
    if (query.status != null && query.status !== "")
      throw new Error("INVALID_QUERY: period status was removed; filter visible plans by plan status instead.");
    const auth = this.authenticated();
    const upstreamPageSize = 200;
    const rows: Record<string, unknown>[] = [];
    let pageNo = 1;
    let pageCount = 1;
    let upstreamTotal = 0;
    do {
      const path = `/sales-plan/plans?pageNo=${pageNo}&pageSize=${upstreamPageSize}`;
      const page = object(await this.get(
        path,
        auth,
        AbortSignal.any([signal, this.epoch.signal]),
      ));
      if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_PAGE");
      rows.push(...page.records.map(object));
      upstreamTotal = integer(page.total, rows.length);
      const actualSize = integer(page.size ?? upstreamPageSize, 1);
      pageCount = integer(page.pages ?? Math.ceil(upstreamTotal / actualSize), 0, 1000);
      pageNo += 1;
    } while (pageNo <= pageCount);
    if (rows.length < upstreamTotal) throw new Error("GEA_INCOMPLETE_COLLECTION");

    const discovered = new Map<string, Row>();
    for (const row of rows) {
      const periodId = text(row.periodId);
      const planTypeCode = text(row.planTypeCode);
      const match = /^(\d{4})(0[1-9]|1[0-2])/.exec(periodId);
      const periodMonth = match ? `${match[1]}-${match[2]}` : periodId;
      const orderType = row.orderType == null ? "" : text(row.orderType);
      const planType = orderType === "Z" ? "CORRECTION" : orderType === "M" ? "MONTHLY" : "UNKNOWN";
      discovered.set(`${periodId}\u0000${planTypeCode}`, {
        periodId,
        tenantId: auth.tenantId,
        periodMonth,
        planType,
        planTypeCode,
        status: "UNKNOWN",
      });
    }
    const periodMonth = query.periodMonth == null || query.periodMonth === "" ? undefined : text(query.periodMonth);
    const planType = query.planType == null || query.planType === "" ? undefined : text(query.planType);
    const records = [...discovered.values()]
      .filter((row) => periodMonth == null || row.periodMonth === periodMonth)
      .filter((row) => planType == null || row.planType === planType)
      .toSorted((left, right) =>
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
    const page = Array.isArray(result)
      ? { records: result, total: result.length }
      : object(result);
    if (!Array.isArray(page.records)) throw new Error("GEA_INVALID_PAGE");
    const records = page.records.map((row) => project(row, fields));
    records.forEach((row) => text(row[idKey]));
    if (new Set(records.map((row) => row[idKey])).size !== records.length)
      throw new Error("GEA_DUPLICATE_RECORD");
    const total =
      page.total == null ? null : integer(page.total, records.length);
    return {
      records,
      total,
      returned: records.length,
      coverage:
        total === null
          ? "unknown"
          : total === records.length
            ? "complete"
            : "partial",
      fetchedAt: new Date().toISOString(),
      sourceUrl: this.base + path,
      missingFields: Object.fromEntries(
        records.map((row) => [
          row[idKey],
          expected.filter((key) => row[key] == null),
        ]),
      ),
    };
  }

  private request(key: string, signal: AbortSignal): AbortSignal {
    this.requests.get(key)?.abort();
    const request = new AbortController();
    this.requests.set(key, request);
    this.preview = undefined;
    return AbortSignal.any([
      request.signal,
      this.queryEpoch.signal,
      this.epoch.signal,
      signal,
    ]);
  }

  /** 当前计划详情与历史版本选择分开标记。 */
  async detail(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Detail> {
    const { row } = this.selected(payload);
    const id = text(row.planId),
      path = "/sales-plan/plans/" + encodeURIComponent(id);
    const active = this.request("detail:" + id, signal);
    this.details.delete(id);
    const result = object(await this.get(path, this.authenticated(), active));
    const currentVersion =
      result.currentVersion == null
        ? null
        : project(result.currentVersion, versionFields);
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
  async versions(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Collection> {
    const { row } = this.selected(payload);
    const id = text(row.planId),
      path = "/sales-plan/plans/" + encodeURIComponent(id) + "/versions";
    const active = this.request("versions:" + id, signal);
    this.versionsByPlan.delete(id);
    const result = this.collection(
      await this.get(path, this.authenticated(), active),
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
  async skus(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Collection> {
    const { row } = this.selected(payload);
    const version = this.selectedVersion(text(row.planId), payload.versionId);
    const id = text(version.record.id),
      path = "/sales-plan/plans/versions/" + encodeURIComponent(id) + "/skus";
    const active = this.request("skus:" + id, signal);
    this.skusByVersion.delete(id);
    const result = this.collection(
      await this.get(path, this.authenticated(), active),
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
    this.preview = undefined;
    keys(payload, [
      "queryId",
      "planId",
      "includeDetail",
      "versionId",
      "skuIds",
    ]);
    const { page, row } = this.selected(payload);
    if (
      payload.includeDetail !== undefined &&
      typeof payload.includeDetail !== "boolean"
    )
      throw new Error("INVALID_PAYLOAD");
    const missing: string[] = [];
    const detail = payload.includeDetail
      ? this.details.get(text(row.planId))
      : undefined;
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
        selection:
          chosen.length === loaded.records.length ? "all-returned" : "subset",
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
  async workbenchQuery(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.clearQuery();
    return this.readWorkbenchQuery(payload, signal);
  }

  /** 为模型读取数据，不使浏览器持有的选择或预览失效。
   * @param payload 固定资源类型及已校验的查询字段。
   * @param signal 所属工具执行的取消信号。
   * @returns 带来源、时间和集合覆盖信息的精确 JSON，供 Session 日志记录。
   */
  async agentQuery(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<string> {
    const identity = this.epoch.signal;
    const transport = transportSignal(AbortSignal.any([signal, identity]));
    let value: unknown;
    try {
      value = await this.readWorkbenchQuery(payload, transport.signal);
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
    const result = JSON.stringify({
      source: "GEA_LIVE_READONLY",
      environment: this.environment,
      fetchedAt: new Date().toISOString(),
      query: payload,
      coverage,
      value,
    });
    if (Buffer.byteLength(result, "utf8") > this.config.inputByteBudget)
      throw new Error("SNAPSHOT_TOO_LARGE");
    return result;
  }

  private async readWorkbenchQuery(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    keys(payload, ["kind", "query"]);
    const query = object(payload.query ?? {});
    const kind = text(payload.kind);
    const allowed: Record<string, string[]> = {
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
      ],
      detail: ["planId"],
      versions: ["planId"],
      logs: ["planId", "pageNo", "pageSize"],
      versionSkus: ["versionId", "pageNo", "pageSize"],
      compare: ["planId", "fromVersionId", "toVersionId"],
    };
    if (!Object.hasOwn(allowed, kind)) throw new Error("INVALID_QUERY");
    const unsupported = Object.keys(query).filter(key => !allowed[kind].includes(key));
    if (unsupported.length) {
      const guidance = kind === "list"
        ? " For a month, call kind=periods with periodMonth first, then use the returned periodId with kind=list."
        : "";
      throw new Error(`INVALID_QUERY: kind=${kind} accepts only ${allowed[kind].join(", ")}.${guidance}`);
    }
    if (query.orderType != null && !["M", "Z"].includes(String(query.orderType))) throw new Error("INVALID_QUERY");
    if (kind === "periods") return this.salesPlanPeriodPage(query, signal);
    const id = (key: string) => encodeURIComponent(text(query[key]));
    const paths: Record<string, () => string> = {
      list: () => "/sales-plan/plans",
      detail: () => "/sales-plan/plans/" + id("planId"),
      versions: () => "/sales-plan/plans/" + id("planId") + "/versions",
      logs: () => "/sales-plan/plans/" + id("planId") + "/logs",
      versionSkus: () =>
        "/sales-plan/plans/versions/" + id("versionId") + "/skus",
      compare: () => "/sales-plan/plans/" + id("planId") + "/compare",
    };
    if (kind === "compare") {
      text(query.fromVersionId);
      text(query.toVersionId);
    }
    const paged = kind === "periods" || kind === "list";
    const current = paged ? integer(query.pageNo ?? 1, 1) : 1;
    const size = paged
      ? integer(
          query.pageSize ??
            (kind === "periods"
              ? this.config.periodPageSize
              : this.config.pageSize),
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
      if (
        value == null ||
        value === "" ||
        key === "planId" ||
        key === "versionId"
      )
        continue;
      if (key === "pageNo" || key === "pageSize")
        params.set(
          key,
          String(
            integer(
              value,
              1,
              key === "pageSize" ? 1000 : Number.MAX_SAFE_INTEGER,
            ),
          ),
        );
      else if (key === "status" && kind !== "periods")
        params.set(key, String(integer(value, 0)));
      else params.set(key, text(value));
    }
    const result = await this.get(
      paths[kind]() + (params.size ? "?" + params : ""),
      this.authenticated(),
      AbortSignal.any([signal, this.epoch.signal]),
    );
    // AionUi 工作台消费完整数组；分页得到的 SKU 子集不能声称数据完整。
    const records = (value: unknown): Record<string, unknown>[] => {
      if (Array.isArray(value)) return value.map(object);
      const page = object(value);
      if (!Array.isArray(page.records))
        throw new Error("GEA_INVALID_COLLECTION");
      if (
        (page.total != null &&
          integer(page.total, page.records.length) > page.records.length) ||
        (page.pages != null && integer(page.pages, 0) > 1) ||
        (page.current != null && integer(page.current, 1) > 1)
      )
        throw new Error("GEA_INCOMPLETE_COLLECTION");
      return page.records.map(object);
    };
    const listRecord = (value: unknown) => {
      const { dealer_name, province_name, ...row } = object(value);
      if (row.dealerName == null && dealer_name != null)
        row.dealerName = dealer_name;
      if (row.provinceName == null && province_name != null)
        row.provinceName = province_name;
      return row;
    };
    if (paged) {
      const page = object(result);
      if (!Array.isArray(page.records))
        throw new Error("GEA_INVALID_COLLECTION");
      const total = integer(page.total, page.records.length);
      const pageSize = integer(page.size ?? size, 1);
      return {
        ...page,
        records: page.records.map(kind === "list" ? listRecord : object),
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
      const versionIds = new Set([
        versionId,
        ...versions.map((version) => text(version.id)),
      ]);
      if (
        currentVersion.planId !== query.planId ||
        versions.some((version) => version.planId !== query.planId) ||
        skus.some((sku) => sku.versionId !== versionId) ||
        logs.some(
          (log) =>
            log.planId !== query.planId || !versionIds.has(text(log.versionId)),
        )
      )
        throw new Error("GEA_IDENTITY_MISMATCH");
      let workflowApproval;
      try {
        if (!detail.actionContext && currentVersion.effective === true &&
            [1, 2, 3, 4, 7, 8, 9].includes(Number(currentVersion.status)))
          workflowApproval = await this.workflowApproval(versionId, signal);
      } catch (error) {
        if (signal.aborted || !this.auth) throw error;
        // 通知发现失败时仍保留业务详情可读，但不授予审批能力。
      }
      return { ...detail, currentVersion, skus, versions, logs, workflowApproval };
    }
    const values = records(result);
    if (kind === "versionSkus") this.materialNames.apply(values);
    if (
      (kind === "versions" || kind === "logs") &&
      values.some((row) => row.planId !== query.planId)
    )
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (
      kind === "versionSkus" &&
      values.some((row) => row.versionId !== query.versionId)
    )
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (
      kind === "compare" &&
      values.some((row) => {
        const before = row.before == null ? undefined : object(row.before);
        const after = row.after == null ? undefined : object(row.after);
        return (
          (before &&
            (before.versionId !== query.fromVersionId ||
              before.skuCode !== row.skuCode)) ||
          (after &&
            (after.versionId !== query.toVersionId ||
              after.skuCode !== row.skuCode))
        );
      })
    )
      throw new Error("GEA_IDENTITY_MISMATCH");
    return values;
  }

  /** 工作台提交给原生会话前重新读取所有计划，避免把浏览器旧页面当成事实。 */
  async prepareWorkbench(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Preview> {
    this.clearQuery();
    keys(payload, ["planIds", "scope"]);
    const scope = payload.scope === undefined ? "details" : payload.scope;
    if (scope !== "summary" && scope !== "details")
      throw new Error("INVALID_SELECTION");
    if (
      !Array.isArray(payload.planIds) ||
      payload.planIds.length < 1 ||
      payload.planIds.length > 100
    )
      throw new Error("INVALID_SELECTION");
    const ids = payload.planIds.map(text);
    if (new Set(ids).size !== ids.length) throw new Error("INVALID_SELECTION");
    const active = AbortSignal.any([
      signal,
      this.epoch.signal,
      this.queryEpoch.signal,
    ]);
    const records: unknown[] = [];
    const summaryFields = ["id", ...planFields, "effective", "createdAt"];
    // 两种范围都会重新读取并校验全部资源身份，然后才选择模型可见字段。
    for (const planId of ids) {
      const detail = object(
        await this.readWorkbenchQuery(
          { kind: "detail", query: { planId } },
          active,
        ),
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
          missingFields: summaryFields.filter(
            (key) => currentVersion[key] == null,
          ),
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
        scope === "summary"
          ? "selected-plans-current-summary"
          : "selected-plans-current-detail",
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
    const limitBytes = Math.min(
      this.config.maxSnapshotBytes,
      this.config.inputByteBudget,
    );
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
    if (!/^session-[a-zA-Z0-9-]+$/.test(sessionId))
      throw new Error("INVALID_SESSION");
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
    if (!this.preview || this.preview.previewId !== id)
      throw new Error("STALE_PREVIEW");
    return this.preview;
  }
}

import { correctionAccess, correctionAdjustments, correctionDecimal } from './workbench-original/workbenches/regionalApproval/models/salesPlanCorrectionModel.ts';
import { validateSalesPlanActionInput } from './workbench-original/workbenches/regionalApproval/models/salesPlanActionModel.ts';
import type { GeaSalesPlanActionRequest } from './workbench-original/contracts.ts';
/** Process-local GEA identity, query ownership, and immutable analysis inputs. */
import { prepareGatewayMcp } from "./gateway-mcp.ts";
import { isDeepStrictEqual } from 'node:util';
import { validateServiceAccounts, serviceAccountReady, submitWithServiceAccount, type ServiceAccounts } from './service-account.ts';
import { prepareSalesPlanResubmit } from './workbench-original/workbenches/regionalApproval/models/salesPlanSubmitModel.ts';
import type { GeaSalesPlanDetail, GeaSalesPlanPeriod, GeaSalesPlanSku } from './workbench-original/contracts.ts';
import { readSalesPlanWorkflowConfig } from "./workflow-config.ts";
import { createHash, randomUUID } from "node:crypto";
import { brandString, type Branded } from "@deepseek-ai/dsh-brand";
import QRCode from "qrcode";
import { resolveEnvironments } from "./environments.js";
import { Decimal } from "decimal.js";
import { transportSignal } from "./transport-signal.ts";
import { notificationPage, notificationDetail } from "./notifications.ts";
import { GeaResponseError, geaResponseError } from "./gea-error.js";

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
const exactNumber =
  /Id$|Code$|Qty$|Amount$|^(id|qty|price|amt|amtBase|qtyDelta|amountDelta)$/;

/** Preserve decimal lexemes and opaque identifiers before JavaScript rounding occurs. */
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

/** Admit an object at an external JSON input. */
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
/** Validate source decimals before arithmetic; no invalid record can be skipped. */
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
/** Sum a complete validated SKU collection separately from the GEA version's source fields. */
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

/** Owns credentials and fetched records; callers can select identifiers, never supply business data. */
export class Business {
  private readonly identityListeners = new Set<() => void>();

  /** Observe authenticated identity changes without exposing login credentials. */
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
        // Consumers cannot break login/logout.
      }
    }
  }

  private auth?: { token: string; tenantId: string; name: string; id: string; username: string };
  private qr?: { id: string; loginId: string; createdAt: number };
  private epoch = new AbortController();
  private queryEpoch = new AbortController();
  private page?: Page;
  private preview?: Preview;
  private details = new Map<string, Detail>();
  private versionsByPlan = new Map<string, Collection>();
  private skusByVersion = new Map<string, Collection>();
  private requests = new Map<string, AbortController>();
  private modelRoutes = new Map<string, GeaModelRoute>();
  private loginExpired = false;
  readonly runId = randomUUID();
  private selectedBase: string;
  private environment: "production" | "test";
  private readonly environments: Record<string, string>;
  get base(): string {
    return this.selectedBase;
  }

  /** Abort inference and queries when the signed-in environment changes. */
  identitySignal(): AbortSignal {
    return this.epoch.signal;
  }

  /** Select a configured environment and discard credentials, QR and previews immediately. */
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

  /** End the current GEA login and invalidate all pending identity-bound work. */
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
  }

  /** Release outstanding requests and erase process-local authentication. */
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
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
  }
  private clearLogin(expired = false): void {
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

  /** Mark the current GEA identity expired after a model gateway rejects it. */
  expireModelLogin(): void {
    if (this.auth) this.clearLogin(true);
  }

  /** Public status never contains GEA credentials. */
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
      user: this.auth
        ? { name: this.auth.name, tenantId: this.auth.tenantId, id: this.auth.id, username: this.auth.username }
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
      response = await fetch(this.base + path, {
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

  /** Match a fresh server-assigned approval task to this exact sales-plan version. */
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

  /** Read the complete workflow configuration using this Host's current identity. */
  async workflowConfig(payload: Record<string, unknown>, caller: AbortSignal) {
    keys(payload, []);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]);
    return readSalesPlanWorkflowConfig(this.base, auth.token, fetch, signal);
  }

  /** Bind an idempotency key to one validated request for the lifetime of this login. */
  private resubmissions = new Map<string, { fingerprint: string; body?: string; flight?: Promise<unknown>; receipt?: unknown }>();

  /** Rebuild a returned plan from current user-visible data before using service credentials. */
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
        // The browser may change quantities only; identity, prices and routing come from GEA.
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(prepared.request)), request)) throw new GeaResponseError(409, { message: '提交数据与当前 GEA 来源不一致，请重新核对' });
        if (this.auth !== auth) throw new Error('STALE_LOGIN');
        signal.throwIfAborted();
        attempt.body = JSON.stringify(prepared.request);
      }
      const receipt = await submitWithServiceAccount(config, this.base, attempt.body, requestId, idempotencyKey, signal);
      attempt.receipt = receipt;
      return receipt;
    };
    attempt.flight = run().finally(() => { attempt.flight = undefined; });
    return attempt.flight;
  }

  private correctionRequests = new Map<string, { fingerprint:string; validated:boolean; flight?:Promise<unknown>; receipt?:unknown }>();

  /** A correction retry replays the same authorized intent, even when its first response was lost. */
  async salesPlanAction(payload: Record<string, unknown>, caller: AbortSignal): Promise<unknown> {
    this.authenticated();
    if(object(payload.request).adjustmentMode == null)return this.executeSalesPlanAction(payload,caller);
    const key=text(payload.idempotencyKey), fingerprint=JSON.stringify(payload);
    let entry=this.correctionRequests.get(key);
    if(entry && entry.fingerprint !== fingerprint)throw new GeaResponseError(409,{message:'幂等键已绑定另一纠偏请求'});
    if(entry?.receipt)return entry.receipt;
    if(entry?.flight)return entry.flight;
    if(!entry){entry={fingerprint,validated:false};this.correctionRequests.set(key,entry);}
    const intent=entry;
    intent.flight=this.executeSalesPlanAction(payload,caller,intent.validated,()=>{intent.validated=true;})
      .then(receipt=>{intent.receipt=receipt;return receipt;}).finally(()=>{intent.flight=undefined;});
    return intent.flight;
  }

  /** Execute one authorized GEA sales-plan action; DMS is intentionally outside this method. */
  private async executeSalesPlanAction(payload: Record<string, unknown>, caller: AbortSignal, validatedCorrection=false, onValidated=()=>{}): Promise<unknown> {
    keys(payload, ["planId", "versionId", "request", "idempotencyKey", "requestId"]);
    const versionId = text(payload.versionId);
    const request = object(payload.request);
    keys(request, ["expectedSnapshot", "action", "expectedStatus", "remark", "adjustments", "adjustmentMode"]);
    if (!["SAVE", "APPROVE", "REJECT"].includes(text(request.action))) throw new Error("INVALID_ACTION");
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    if (request.adjustmentMode != null && !validatedCorrection) {
      if (request.adjustmentMode !== 'ABSOLUTE_NET') throw new Error('INVALID_PAYLOAD');
      const planId=text(payload.planId);
      const detail=await this.workbenchQuery({kind:'detail',query:{planId}},signal) as GeaSalesPlanDetail;
      const workflowRows=await this.workflowConfig({},signal);
      const access=correctionAccess(detail,workflowRows);
      if (!access || !access.allowedActions.includes(request.action as GeaSalesPlanActionRequest['action']) || !detail.currentVersion.submitter || detail.currentVersion.submitter === auth.id)
        throw new GeaResponseError(403,{message:'纠偏契约、月初终审、审批窗口或节点权限未获确认'});
      if (detail.currentVersion.id !== versionId || access.status !== request.expectedStatus || access.snapshotHash !== request.expectedSnapshot)
        throw new GeaResponseError(409,{message:'纠偏版本或快照已变化，请刷新'});
      const typed=request as GeaSalesPlanActionRequest;
      validateSalesPlanActionInput({planId,versionId,planTypeCode:detail.currentVersion.planTypeCode,request:typed},workflowRows);
      if (typed.action !== 'REJECT') {
        const edits=Object.fromEntries((typed.adjustments??[]).map(x=>[x.skuCode,x.adjustQty]));
        if (Object.keys(edits).some(code=>!detail.skus.some(sku=>sku.skuCode===code))) throw new Error('INVALID_PAYLOAD');
        const expected=correctionAdjustments(detail,edits,workflowRows);
        if (!isDeepStrictEqual(expected,typed.adjustments)) throw new GeaResponseError(400,{message:'纠偏必须提交完整的本节点绝对调整决定'});
      }
      if (this.auth !== auth) throw new Error('STALE_LOGIN');
      signal.throwIfAborted();
    } else if (request.adjustmentMode == null && request.action === "SAVE") {
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
    const response = await fetch(this.base + "/sales-plan/plans/versions/" + encodeURIComponent(versionId) + "/actions", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "X-Access-Token": auth.token, "X-Tenant-Id": auth.tenantId, "X-Request-Id": text(payload.requestId), "Idempotency-Key": text(payload.idempotencyKey) }, body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    });
    if (!response.ok) { if (response.status === 401) this.clearLogin(true); throw await geaResponseError(response, [auth.token]); }
    const data = object(parseJson(await response.text()));
    if (data.success !== true || !data.result) throw new Error("GEA_WRITE_REJECTED");
    if(this.auth !== auth)throw new Error('STALE_LOGIN');
    signal.throwIfAborted();
    return data.result;
  }

  /** Read fixed notification endpoints under the current Host identity without changing plan selection. */
  async notifications(payload: Record<string, unknown>, caller: AbortSignal) {
    keys(payload, ["pageNo", "state", "id"]);
    const auth = this.authenticated();
    const signal = AbortSignal.any([caller, this.epoch.signal]);
    let path = "/api/v1/notifications";
    if (payload.id !== undefined) {
      if (payload.pageNo !== undefined || payload.state !== undefined)
        throw new Error("INVALID_PAYLOAD");
      path += "/" + encodeURIComponent(text(payload.id));
    } else {
      const query = new URLSearchParams({
        pageNo: String(integer(payload.pageNo ?? 1, 1, 100000)),
        pageSize: String(this.config.pageSize),
      });
      if (payload.state !== undefined && payload.state !== "")
        query.set("state", text(payload.state));
      path += "?" + query;
    }
    const value = await this.get(path, auth, signal);
    signal.throwIfAborted();
    return {
      environment: this.environment,
      fetchedAt: new Date().toISOString(),
      ...(payload.id === undefined
        ? notificationPage(value, this.config.pageSize)
        : { detail: notificationDetail(value, text(payload.id)) }),
    };
  }

  /** Resolve the logged-in user's GEA personal model route without exposing its secret to the browser. */
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
      response = await fetch(baseUrl + "/models", {
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
          // A forbidden or unavailable display-name lookup must not disable an authorized model route.
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
      response = await fetch(this.base + path, {
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

  /** Restart QR login and invalidate every selection from the previous identity. */
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

  /** Admit identity only if the same QR login is still current when both requests finish. */
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
    this.auth = { token, tenantId, name, id: text(user.id), username: text(user.username || user.realname) };
    this.qr = undefined;
    this.notifyIdentity();
    return { status: "authenticated", ...this.status() };
  }

  /** Prepare a gateway transport capability using only the current process login. */
  async openMcpConnection(consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string }, signal: AbortSignal) {
    const auth = this.authenticated();
    const identity = this.epoch.signal;
    return prepareGatewayMcp(this.base, auth, consumer, AbortSignal.any([signal, identity]), this.config.requestTimeoutMs);
  }

  /** Fetch one explicitly paged query, invalidating all previous query inputs immediately. */
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

  /** Return the actual period fields and retain the period page's coverage. */
  async periods(signal: AbortSignal): Promise<Collection> {
    const path = `/sales-plan/periods?pageNo=1&pageSize=${this.config.periodPageSize}`;
    const result = await this.get(
      path,
      this.authenticated(),
      AbortSignal.any([signal, this.epoch.signal]),
    );
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
      ["periodId", "periodMonth", "status"],
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

  /** Current plan detail is labeled separately from historical version selection. */
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

  /** List versions whose upstream plan identity matches the selected plan. */
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

  /** Fetch only a version proven to belong to the current queried plan. */
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
    if (result.records.some((record) => record.versionId !== id))
      throw new Error("GEA_IDENTITY_MISMATCH");
    if (active.aborted) throw new Error("STALE_SELECTION");
    this.skusByVersion.set(id, result);
    return result;
  }

  /** Freeze exactly the selected Host-owned records and report the full serialized input size. */
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

  /** Read the original workbench's fixed GEA endpoints using the current server-owned identity. */
  async workbenchQuery(
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.clearQuery();
    return this.readWorkbenchQuery(payload, signal);
  }

  /** Read for the model without invalidating a browser-owned selection or preview.
   * @param payload - Fixed resource kind and validated query fields.
   * @param signal - The owning tool execution cancellation.
   * @returns Exact JSON with source, time and collection coverage for the Session log.
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
      periods: ["periodMonth", "planType", "status", "pageNo", "pageSize"],
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
    keys(query, allowed[kind]);
    if (query.orderType != null && !["M", "Z"].includes(String(query.orderType))) throw new Error("INVALID_QUERY");
    const id = (key: string) => encodeURIComponent(text(query[key]));
    const paths: Record<string, () => string> = {
      periods: () => "/sales-plan/periods",
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
    // AionUi's workbench consumes complete arrays; a paged SKU subset cannot claim completeness.
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
        if (!detail.actionContext && Number(currentVersion.status) >= 1 && Number(currentVersion.status) <= 4)
          workflowApproval = await this.workflowApproval(versionId, signal);
      } catch (error) {
        if (signal.aborted || !this.auth) throw error;
        // Notification discovery failures keep the business detail readable, with no approval grant.
      }
      return { ...detail, currentVersion, skus, versions, logs, workflowApproval };
    }
    const values = records(result);
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

  /** Re-read selected plans from GEA before constructing an immutable native-conversation input. */
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
    // Both scopes re-read and validate all resource identities before selecting model-visible fields.
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

  private recordPreview(snapshot: object): Preview {
    const json = JSON.stringify(snapshot, null, 2);
    const snapshotHash = createHash("sha256").update(json).digest("hex");
    const task =
      this.config.analysisMode === "receipt"
        ? "本次是本地传递验证，不是 AI 分析。请核对以下快照已进入会话。"
        : "请依据以下只读快照分析销售计划数量和金额差异。分别列出源数据、精确计算、推测与缺失依据。不得执行审批或写回。";
    const prompt = `${task}\nGEA_SNAPSHOT_SHA256=${snapshotHash}\n\n${json}`;
    const bytes = Buffer.byteLength(prompt);
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

  /** Cancel pending admission when the caller, login, query, or Host expires. */
  admissionSignal(caller: AbortSignal): AbortSignal {
    return AbortSignal.any([caller, this.epoch.signal, this.queryEpoch.signal]);
  }

  /** Return only a still-current preview for standard Session submission. */
  prepared(id: unknown): Preview {
    this.authenticated();
    if (!this.preview || this.preview.previewId !== id)
      throw new Error("STALE_PREVIEW");
    return this.preview;
  }
}

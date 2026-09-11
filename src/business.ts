/** Process-local GEA identity, query ownership, and immutable analysis inputs. */
import { createHash, randomUUID } from "node:crypto";
import { brandString, type Branded } from "@deepseek-ai/dsh-brand";
import QRCode from "qrcode";
import { Decimal } from "decimal.js";
import { geaResponseError } from "./gea-error.js";

export type QueryId = Branded<"gea-query">;
export type PreviewId = Branded<"gea-preview">;
export type Row = Record<string, string | number | boolean>;
export interface Deployment {
  geaBaseUrl: string;
  pageSize: number;
  periodPageSize: number;
  requestTimeoutMs: number;
  maxSnapshotBytes: number;
  runtimeDir: string;
  analysisMode: "receipt" | "model";
  analysisModel: string;
  analysisAgentCode: string;
  analysisSource: "gea" | "aionui" | "direct" | "receipt";
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
const exactNumber = /Id$|Code$|Qty$|Amount$|^(id|qty|price|amt|amtBase)$/;

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
function difference(row: Row, target: string, current: string) {
  const values = [row[target], row[current]];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        !/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ||
        value.length > 1024,
    )
  )
    return { basis: [target, current], missing: "decimal-source-unavailable" };
  const Exact = Decimal.clone({ precision: 4096 });
  const left = new Exact(String(values[0])),
    right = new Exact(String(values[1]));
  if (
    !left.isFinite() ||
    !right.isFinite() ||
    Math.abs(left.e) > 1024 ||
    Math.abs(right.e) > 1024
  )
    return { basis: [target, current], missing: "decimal-range-exceeded" };
  return {
    basis: [target, current],
    operation: "target-minus-current",
    value: left.minus(right).toFixed(),
  };
}

/** Owns credentials and fetched records; callers can select identifiers, never supply business data. */
export class Business {
  private auth?: { token: string; tenantId: string; name: string };
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
  readonly base: string;

  constructor(readonly config: Deployment) {
    const base = new URL(config.geaBaseUrl);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("INVALID_GEA_BASE_URL");
    this.base = base.href.replace(/\/$/, "");
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
    this.qr = undefined;
    this.loginExpired = expired;
    this.clearQuery();
  }

  /** Mark the current GEA identity expired after a model gateway rejects it. */
  expireModelLogin(): void {
    if (this.auth) this.clearLogin(true);
  }

  /** Public status never contains GEA credentials. */
  status() {
    return {
      authenticated: Boolean(this.auth),
      loginState: this.auth
        ? "authenticated"
        : this.loginExpired
          ? "expired"
          : "signed-out",
      user: this.auth
        ? { name: this.auth.name, tenantId: this.auth.tenantId }
        : null,
      source: this.base,
      provider:
        this.config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
      model: this.config.analysisModel,
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
        ...(includeTenant && identity.tenantId ? { "X-Tenant-Id": identity.tenantId } : {}),
        "X-Request-Id": randomUUID(),
      });
    let response: Response;
    try {
      response = await fetch(this.base + path, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(this.config.requestTimeoutMs),
        ]),
      });
    } catch {
      if (signal.aborted) throw new Error("STALE_SELECTION");
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
      throw new Error("GEA_INVALID_JSON");
    }
    if (signal.aborted) throw new Error("STALE_SELECTION");
    if (data.success !== true) throw new Error("GEA_REQUEST_REJECTED");
    return data.result;
  }

  private authenticated(): NonNullable<Business["auth"]> {
    if (!this.auth) throw new Error("LOGIN_REQUIRED");
    return this.auth;
  }

  /** Resolve the logged-in user's GEA personal model route without exposing its secret to the browser. */
  async modelRoute(signal: AbortSignal, agentCode = "sales_forecast"): Promise<GeaModelRoute> {
    const auth = this.authenticated();
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(agentCode)) throw new Error("GEA_MODEL_AGENT_INVALID");
    const cached = this.modelRoutes.get(agentCode);
    if (cached) return cached;
    const credentialResult = object(
      await this.get(
        "/aidata/user-agent-credential/my/list?pageNo=1&pageSize=10",
        auth,
        AbortSignal.any([signal, this.epoch.signal]),
        false,
      ),
    );
    const records = Array.isArray(credentialResult.records) ? credentialResult.records : [];
    if (records.length > 1) throw new Error("GEA_MODEL_CREDENTIAL_AMBIGUOUS");
    const credential = records[0] ? object(records[0]) : undefined;
    if (!credential) throw new Error("GEA_MODEL_CREDENTIAL_MISSING");
    const status = credential.status;
    if (status === "DISABLED" || status === "REVOKED") throw new Error("GEA_MODEL_CREDENTIAL_DISABLED");
    const credentialId = text(credential.credentialId ?? credential.id);
    const claim = await this.post(
      "/aidata/user-agent-credential/my/claim?id=" + encodeURIComponent(credentialId),
      auth,
      AbortSignal.any([signal, this.epoch.signal]),
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
      response = await fetch(baseUrl + "/models", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + secret,
          "X-GEA-Agent-Code": agentCode,
        },
        redirect: "error",
        signal: AbortSignal.any([signal, this.epoch.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
      });
    } catch {
      throw new Error("GEA_MODEL_NETWORK_ERROR");
    }
    if (!response.ok) {
      if (response.status === 401) this.clearLogin(true);
      throw new Error("GEA_MODEL_HTTP_" + response.status);
    }
    const modelsPayload = object(await response.json());
    if (!Array.isArray(modelsPayload.data)) throw new Error("GEA_MODEL_INVALID_RESPONSE");
    const models = modelsPayload.data.map((entry) =>
      typeof entry === "string" ? entry : text(object(entry).id),
    );
    if (!models.length) throw new Error("GEA_MODEL_EMPTY");
    const route = { baseUrl, secret, agentCode, models: [...new Set(models)] };
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
          ...(includeTenant && identity.tenantId ? { "X-Tenant-Id": identity.tenantId } : {}),
          "X-Request-Id": randomUUID(),
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.requestTimeoutMs)]),
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
  async loginStart(signal: AbortSignal) {
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
    this.auth = { token, tenantId, name };
    this.qr = undefined;
    return { status: "authenticated", ...this.status() };
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

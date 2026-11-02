import { validateServiceAccounts as validateServiceAccountReferences } from "../shared/service-accounts.js";
import { GeaResponseError, geaResponseError } from "../shared/gea-error.js";

export type ServiceAccountConfig = {
  clientIdEnv: string;
  clientSecretEnv: string;
  keychainService?: string;
  tenantId: string;
};
export type ServiceAccounts = Partial<Record<"production" | "test", ServiceAccountConfig>>;

export function validateServiceAccounts(
  value: unknown,
): asserts value is ServiceAccounts | undefined {
  validateServiceAccountReferences(value);
}

export type ResubmitUnavailableReason = "signed-out" | "configuration" | "tenant" | "credential";

export function serviceAccountUnavailableReason(
  config: ServiceAccountConfig | undefined,
  user: { id: string; tenantId: string } | undefined,
): ResubmitUnavailableReason | undefined {
  if (!user) return "signed-out";
  if (!config) return "configuration";
  if (config.tenantId !== user.tenantId) return "tenant";
  if (!process.env[config.clientIdEnv]?.trim() || !process.env[config.clientSecretEnv]?.trim())
    return "credential";
  return undefined;
}

export function serviceAccountReady(
  config: ServiceAccountConfig | undefined,
  user: { id: string; tenantId: string } | undefined,
): boolean {
  return serviceAccountUnavailableReason(config, user) === undefined;
}

export function serviceAccountUnavailableError(reason: ResubmitUnavailableReason) {
  const messages: Record<ResubmitUnavailableReason, string> = {
    "signed-out": "请先登录后再修改重提销售计划",
    configuration: "当前环境尚未配置销售计划重提服务，请联系管理员",
    tenant: "当前登录租户与销售计划重提服务配置不一致，请联系管理员",
    credential: "Host 缺少销售计划重提服务凭据，请联系管理员配置",
  };
  const error = new GeaResponseError(reason === "signed-out" ? 401 : 503, {
    message: messages[reason],
  });
  error.details.resubmitUnavailableReason = reason;
  return error;
}

function unknownSubmission() {
  const error = new GeaResponseError(502, {
    message: "重提结果暂时未知，请使用原幂等键重试或回读状态",
  });
  error.details.retrySameIntent = true;
  return error;
}

export class ServiceAccountSession {
  private token?: {
    base: string;
    tenantId: string;
    clientId: string;
    secret: string;
    value: string;
    expiresAt: number;
  };
  private generation = 0;

  clear(): void {
    this.token = undefined;
    this.generation += 1;
  }

  async submit(
    config: ServiceAccountConfig,
    base: string,
    body: string,
    requestId: string,
    idempotencyKey: string,
    signal: AbortSignal,
    fetchImpl: typeof fetch = fetch,
  ): Promise<unknown> {
    const clientId = process.env[config.clientIdEnv];
    const secret = process.env[config.clientSecretEnv];
    if (!clientId || !secret) throw new Error("GEA_SERVICE_CREDENTIAL_MISSING");
    const generation = this.generation;
    const acquire = async () => {
      const cached = this.token;
      if (
        cached &&
        cached.base === base &&
        cached.tenantId === config.tenantId &&
        cached.clientId === clientId &&
        cached.secret === secret &&
        Date.now() < cached.expiresAt
      )
        return cached.value;
      this.token = undefined;
      const issuedAt = Date.now();
      const auth = await fetchImpl(base + "/api/v1/internal/auth/token", {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Trace-Id": requestId },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: secret,
          scope: "sales-plan:write",
        }),
      });
      if (!auth.ok) {
        const error = await geaResponseError(auth, [clientId, secret]);
        error.details.authentication = "service";
        throw error;
      }
      const reply = await auth.json();
      const token = reply?.result?.access_token;
      if (
        reply?.success !== true ||
        typeof token !== "string" ||
        !token ||
        reply.result.token_type !== "Bearer" ||
        !Number.isFinite(reply.result.expires_in) ||
        reply.result.expires_in <= 0 ||
        typeof reply.result.scope !== "string" ||
        !reply.result.scope.split(/\s+/).includes("sales-plan:write")
      )
        throw new Error("GEA_SERVICE_TOKEN_INVALID");
      const expiresAt = issuedAt + reply.result.expires_in * 1000;
      if (!Number.isFinite(expiresAt)) throw new Error("GEA_SERVICE_TOKEN_INVALID");
      signal.throwIfAborted();
      if (generation === this.generation)
        this.token = {
          base,
          tenantId: config.tenantId,
          clientId,
          secret,
          value: token,
          expiresAt,
        };
      return token;
    };
    let response: Response | undefined;
    let token = "";
    for (let refresh = 0; refresh <= 1; refresh++) {
      token = await acquire();
      signal.throwIfAborted();
      try {
        response = await fetchImpl(base + "/api/v1/internal/sales-plans", {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Request-Id": requestId,
            "Idempotency-Key": idempotencyKey,
          },
          body,
        });
      } catch {
        throw unknownSubmission();
      }
      if (response.status !== 401) break;
      this.token = undefined;
      if (refresh === 0) await response.body?.cancel();
    }
    if (!response) throw unknownSubmission();
    if (!response.ok) {
      const error = await geaResponseError(response, [clientId, secret, token]);
      if (response.status === 401) error.details.authentication = "service";
      if (response.status >= 500 && error.details.retryable !== false)
        error.details.retrySameIntent = true;
      throw error;
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw unknownSubmission();
    }
    if (result?.success !== true || !result.result) {
      const status =
        result?.code === 510
          ? 403
          : Number.isInteger(result?.code) && result.code >= 400 && result.code <= 599
            ? result.code
            : 502;
      const error = new GeaResponseError(status, result, [clientId, secret, token]);
      if (status === 401) error.details.authentication = "service";
      throw error;
    }
    const receipt = result.result;
    if (
      typeof receipt.planId !== "string" ||
      !receipt.planId.trim() ||
      typeof receipt.versionId !== "string" ||
      !receipt.versionId.trim() ||
      !Number.isSafeInteger(receipt.seq) ||
      receipt.seq <= 0 ||
      !Number.isSafeInteger(receipt.status) ||
      receipt.status < 0 ||
      receipt.status > 10 ||
      typeof receipt.replayed !== "boolean" ||
      receipt.requestId !== requestId ||
      typeof receipt.traceId !== "string" ||
      !receipt.traceId.trim() ||
      (receipt.auditId != null && typeof receipt.auditId !== "string")
    )
      throw unknownSubmission();
    return {
      planId: receipt.planId,
      versionId: receipt.versionId,
      seq: receipt.seq,
      status: receipt.status,
      replayed: receipt.replayed,
      requestId: receipt.requestId,
      traceId: receipt.traceId,
      auditId: receipt.auditId ?? null,
    };
  }
}

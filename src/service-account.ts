/** Host-only OAuth credentials and sales-plan submission transport. */
import { GeaResponseError, geaResponseError } from './gea-error.js';

export type ServiceAccountConfig = {
  clientIdEnv: string;
  clientSecretEnv: string;
  keychainService?: string;
  tenantId: string;
  allowedUserIds: string[];
};
export type ServiceAccounts = Partial<Record<'production' | 'test', ServiceAccountConfig>>;

/** Validate references only; no credential value belongs in deployment JSON. */
export function validateServiceAccounts(value: unknown): asserts value is ServiceAccounts | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SERVICE_ACCOUNTS');
  for (const [environment, raw] of Object.entries(value)) {
    if (!['production', 'test'].includes(environment) || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_SERVICE_ACCOUNTS');
    const config = raw as Record<string, unknown>;
    if (Object.keys(config).some(key => !['clientIdEnv', 'clientSecretEnv', 'keychainService', 'tenantId', 'allowedUserIds'].includes(key)) ||
      !/^GEA_[A-Z0-9_]+$/.test(String(config.clientIdEnv ?? '')) ||
      !/^GEA_[A-Z0-9_]+$/.test(String(config.clientSecretEnv ?? '')) || config.clientIdEnv === config.clientSecretEnv ||
      (config.keychainService !== undefined && (typeof config.keychainService !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(config.keychainService))) ||
      typeof config.tenantId !== 'string' || !/^\d+$/.test(config.tenantId) ||
      !Array.isArray(config.allowedUserIds) || !config.allowedUserIds.length ||
      config.allowedUserIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('INVALID_SERVICE_ACCOUNTS');
  }
}

/** Read credential availability without exposing values. */
export function serviceAccountReady(config: ServiceAccountConfig | undefined, user: { id: string; tenantId: string } | undefined): boolean {
  return Boolean(config && user && config.tenantId === user.tenantId && config.allowedUserIds.includes(user.id) &&
    process.env[config.clientIdEnv]?.trim() && process.env[config.clientSecretEnv]?.trim());
}

function unknownSubmission() {
  const error = new GeaResponseError(502, { message: '重提结果暂时未知，请使用原幂等键重试或回读状态' });
  error.details.retrySameIntent = true;
  return error;
}

/** Exchange credentials per attempt, then send exactly one idempotent business request. */
export async function submitWithServiceAccount(
  config: ServiceAccountConfig, base: string, body: string, requestId: string, idempotencyKey: string,
  signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const clientId = process.env[config.clientIdEnv];
  const secret = process.env[config.clientSecretEnv];
  if (!clientId || !secret) throw new Error('GEA_SERVICE_CREDENTIAL_MISSING');
  const auth = await fetchImpl(base + '/api/v1/internal/auth/token', {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Trace-Id': requestId },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, scope: 'sales-plan:write' }),
  });
  if (!auth.ok) throw await geaResponseError(auth, [clientId, secret]);
  const tokenReply = await auth.json();
  const token = tokenReply?.result?.access_token;
  if (tokenReply?.success !== true || typeof token !== 'string' || !token || tokenReply.result.token_type !== 'Bearer' ||
    !Number.isFinite(tokenReply.result.expires_in) || tokenReply.result.expires_in <= 0 ||
    typeof tokenReply.result.scope !== 'string' || !tokenReply.result.scope.split(/\s+/).includes('sales-plan:write'))
    throw new Error('GEA_SERVICE_TOKEN_INVALID');
  signal.throwIfAborted();
  let response: Response;
  try { response = await fetchImpl(base + '/api/v1/internal/sales-plans', {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Request-Id': requestId, 'Idempotency-Key': idempotencyKey }, body,
  });
  } catch { throw unknownSubmission(); }
  if (!response.ok) {
    const error = await geaResponseError(response, [clientId, secret, token]);
    if (response.status >= 500) error.details.retrySameIntent = true;
    throw error;
  }
  let result;
  try { result = await response.json(); } catch { throw unknownSubmission(); }
  if (result?.success !== true || !result.result)
    throw new GeaResponseError(result?.code === 510 ? 403 : 502, { message: 'GEA 重提未返回成功回执' });
  // Return only public receipt fields, never arbitrary upstream data or credentials.
  const receipt = result.result;
  if (typeof receipt.planId !== 'string' || typeof receipt.versionId !== 'string' || !Number.isSafeInteger(receipt.seq) ||
    !Number.isSafeInteger(receipt.status) || typeof receipt.replayed !== 'boolean' || receipt.requestId !== requestId ||
    typeof receipt.traceId !== 'string' || !receipt.traceId || typeof receipt.auditId !== 'string' || !receipt.auditId)
    throw unknownSubmission();
  return { planId: receipt.planId, versionId: receipt.versionId, seq: receipt.seq, status: receipt.status, replayed: receipt.replayed,
    requestId: receipt.requestId, traceId: receipt.traceId, auditId: receipt.auditId };
}

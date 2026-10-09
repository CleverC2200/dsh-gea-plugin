/** GEA 导航协议的安全投影；只依赖当前用户的固定接口调用。 */
export interface NavigationInput { navigationReference: string; schemaVersion: number }
export interface NavigationTarget {
  intentId: string;
  panel: 'gea-proof' | 'gea-inbox';
  expiresAt: number;
  notificationId?: string;
  interactionRequestId?: string;
}
export type NavigationRequest = (path: string, body?: unknown) => Promise<unknown>;

/** 禁止客户端内部参数被扩展为任意 URL、身份或版本。 */
export function validateNavigationInput(value: NavigationInput): void {
  if (!value || Object.keys(value).some(key => !['navigationReference', 'schemaVersion'].includes(key)) ||
      ![1, 2].includes(value.schemaVersion) || typeof value.navigationReference !== 'string' || !/^[A-Za-z0-9._-]{1,512}$/.test(value.navigationReference))
    throw Error('NAVIGATION_REQUEST_INVALID');
}
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('NAVIGATION_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw Error('NAVIGATION_INVALID_RESPONSE');
  return value;
}

/** 解析受控目标；V2 有界分页按真实关系定位，并回读详情防止关系漂移。 */
export async function resolveNavigationTarget(request: NavigationRequest, input: NavigationInput, analysisAgentCode: string): Promise<NavigationTarget> {
  validateNavigationInput(input);
  const data = row(await request('/ai/gateway/client-navigation-intents/resolve', input));
  const target = row(data.target);
  const intentId = identifier(data.navigationIntentId);
  if (data.schemaVersion !== input.schemaVersion ||
      target.type !== (input.schemaVersion === 1 ? 'AGENT' : 'INTERACTION_REQUEST')) throw Error('NAVIGATION_INVALID_RESPONSE');
  if (typeof data.expiresAt !== 'number' && typeof data.expiresAt !== 'string') throw Error('NAVIGATION_INVALID_RESPONSE');
  const expiresAt = new Date(data.expiresAt).getTime();
  if (!Number.isFinite(expiresAt)) throw Error('NAVIGATION_INVALID_RESPONSE');
  if (expiresAt <= Date.now()) throw Error('NAVIGATION_REFERENCE_EXPIRED');
  const agentCode = identifier(target.agentCode);
  if (input.schemaVersion === 1) {
    if (agentCode !== analysisAgentCode) throw Error('NAVIGATION_TARGET_UNSUPPORTED');
    return {intentId, panel: 'gea-proof', expiresAt};
  }
  const interactionRequestId = identifier(target.interactionRequestId);
  for (let pageNo = 1; pageNo <= 50; pageNo++) {
    const page = row(await request(`/api/v1/notifications?pageNo=${pageNo}&pageSize=100`));
    if (!Array.isArray(page.items) || page.items.length > 100 || !Number.isSafeInteger(page.total) || Number(page.total) < 0)
      throw Error('NAVIGATION_INVALID_RESPONSE');
    for (const value of page.items) {
      const item = row(value);
      if (item.interaction_request_id !== interactionRequestId) continue;
      const notificationId = identifier(item.id);
      const detail = row(await request('/api/v1/notifications/' + encodeURIComponent(notificationId)));
      if (detail.id !== notificationId || detail.interaction_request_id !== interactionRequestId) throw Error('NAVIGATION_TARGET_UNAVAILABLE');
      return {intentId, panel: 'gea-inbox', notificationId, interactionRequestId, expiresAt};
    }
    if (pageNo * 100 >= Number(page.total)) throw Error('NAVIGATION_TARGET_UNAVAILABLE');
    if (!page.items.length) throw Error('NAVIGATION_LOOKUP_INCOMPLETE');
  }
  throw Error('NAVIGATION_LOOKUP_INCOMPLETE');
}

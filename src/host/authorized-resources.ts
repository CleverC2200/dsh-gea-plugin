/** Resource discovery is an authorization snapshot, not a business-data result. */
export type AuthorizedResource = {
  capabilityCode: string; resourceCode: string; resourceName: string; resourceType: string;
  queryTarget: string; version: string; maxRows: number | null; maxBytes: number | null;
};
export type AuthorizedResources = { resources: AuthorizedResource[]; fetchedAt: string };
export type ResourceReader = (toolName: string, signal: AbortSignal) => Promise<AuthorizedResources>;

export function parseAuthorizedResources(value: unknown, capabilityCode: string): AuthorizedResources {
  const body = value as Record<string, unknown> | null;
  if (!body || body.success !== true || !Array.isArray(body.resources)) {
    const code = typeof body?.code === 'string' && /^[A-Z0-9_]+$/.test(body.code) ? body.code : 'INVALID_RESPONSE';
    const category = typeof body?.category === 'string' && /^[A-Z0-9_]+$/.test(body.category) ? body.category : undefined;
    throw Object.assign(new Error(`GEA_RESOURCE_DISCOVERY_FAILED: ${code}${category ? ' ['+category+']' : ''}。未取得授权资源快照，不能使用公开 inspect 代替授权。`), {code, category});
  }
  const resources = body.resources.map((raw: unknown): AuthorizedResource => {
    const item = raw as Record<string, unknown> | null;
    const text = (key: string) => typeof item?.[key] === 'string' && (item[key] as string).trim() ? item[key] as string : undefined;
    const limit = (key: string): number | null => {
      const value = item?.[key];
      if (value === null || value === undefined) return null;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw Error('GEA_RESOURCE_DISCOVERY_INVALID_LIMIT');
      return value;
    };
    if (!item || text('capabilityCode') !== capabilityCode || !text('resourceCode') || !text('resourceType') || !text('queryTarget') || !text('version')) throw Error('GEA_RESOURCE_DISCOVERY_INVALID_RESOURCE');
    return {capabilityCode, resourceCode: text('resourceCode')!, resourceName: text('resourceName') ?? text('resourceCode')!, resourceType: text('resourceType')!, queryTarget: text('queryTarget')!, version: text('version')!, maxRows: limit('maxRows'), maxBytes: limit('maxBytes')};
  });
  return {resources, fetchedAt: new Date().toISOString()};
}
export const cubeResources = (snapshot: AuthorizedResources) => snapshot.resources.filter(resource => resource.resourceType === 'EXTERNAL_MCP');
export function authorizedCatalog(payload: unknown, snapshot: AuthorizedResources): unknown {
  const root = payload as {semanticModel?: Array<{name?: string}>};
  const names = new Set(cubeResources(snapshot).map(resource => resource.queryTarget));
  return {...root, semanticModel: Array.isArray(root?.semanticModel) ? root.semanticModel.filter(model => names.has(model.name ?? '')) : []};
}

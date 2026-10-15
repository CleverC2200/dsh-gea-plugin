/** Resource discovery is an authorization snapshot, not a business-data result. */
export type AuthorizedResource = {
  capabilityCode: string;
  resourceCode: string;
  resourceName: string;
  resourceType: string;
  queryTarget: string;
  version: string;
  maxRows: number | null;
  maxBytes: number | null;
};
export type AuthorizedResources = { resources: AuthorizedResource[]; fetchedAt: string };
export type ResourceReader = (
  toolName: string,
  signal: AbortSignal,
) => Promise<AuthorizedResources>;

export function parseAuthorizedResources(
  value: unknown,
  capabilityCode: string,
): AuthorizedResources {
  const body = value as Record<string, unknown> | null;
  if (!body || body.success !== true || !Array.isArray(body.resources)) {
    const code =
      typeof body?.code === "string" && /^[A-Z0-9_]+$/.test(body.code)
        ? body.code
        : "INVALID_RESPONSE";
    const category =
      typeof body?.category === "string" && /^[A-Z0-9_]+$/.test(body.category)
        ? body.category
        : undefined;
    throw Object.assign(
      new Error(
        `GEA_RESOURCE_DISCOVERY_FAILED: ${code}${category ? " [" + category + "]" : ""}。未取得授权资源快照，不能使用公开 inspect 代替授权。`,
      ),
      { code, category },
    );
  }
  const resources = body.resources.map((raw: unknown): AuthorizedResource => {
    const item = raw as Record<string, unknown> | null;
    const text = (key: string) =>
      typeof item?.[key] === "string" && (item[key] as string).trim()
        ? (item[key] as string)
        : undefined;
    const limit = (key: string): number | null => {
      const value = item?.[key];
      if (value === null || value === undefined) return null;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw Error("GEA_RESOURCE_DISCOVERY_INVALID_LIMIT");
      return value;
    };
    if (
      !item ||
      text("capabilityCode") !== capabilityCode ||
      !text("resourceCode") ||
      !text("resourceType") ||
      !text("queryTarget") ||
      !text("version")
    )
      throw Error("GEA_RESOURCE_DISCOVERY_INVALID_RESOURCE");
    return {
      capabilityCode,
      resourceCode: text("resourceCode")!,
      resourceName: text("resourceName") ?? text("resourceCode")!,
      resourceType: text("resourceType")!,
      queryTarget: text("queryTarget")!,
      version: text("version")!,
      maxRows: limit("maxRows"),
      maxBytes: limit("maxBytes"),
    };
  });
  return { resources, fetchedAt: new Date().toISOString() };
}
export const cubeResources = (snapshot: AuthorizedResources) =>
  snapshot.resources.filter((resource) => resource.resourceType === "EXTERNAL_MCP");
export function authorizedCatalog(payload: unknown, snapshot: AuthorizedResources): unknown {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const root = record(payload) ?? {};
  const models = Array.isArray(root.semanticModel)
    ? root.semanticModel
        .map(record)
        .filter((model): model is Record<string, unknown> => model !== undefined)
    : [];
  const names = new Set(cubeResources(snapshot).map((resource) => resource.queryTarget));
  const direct = models.filter(
    (model) => model.type !== "view" && typeof model.name === "string" && names.has(model.name),
  );
  const directNames = new Set(direct.map((model) => model.name));
  type Projection = Record<string, unknown> & {
    name: string;
    sourceView: string;
    dimensions: Record<string, unknown>[];
    measures: Record<string, unknown>[];
    segments: Record<string, unknown>[];
  };
  const projected = new Map<string, Projection>();
  for (const view of models) {
    if (view.type !== "view" || typeof view.name !== "string") continue;
    for (const key of ["dimensions", "measures", "segments"] as const) {
      const members = view[key];
      if (!Array.isArray(members)) continue;
      for (const raw of members) {
        const member = record(raw);
        if (
          typeof member?.name !== "string" ||
          !member.name.startsWith(view.name + ".") ||
          typeof member.aliasMember !== "string"
        )
          continue;
        const alias = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(
          member.aliasMember,
        );
        if (!alias || !names.has(alias[1]) || directNames.has(alias[1])) continue;
        let model = projected.get(alias[1]);
        if (!model) {
          model = {
            ...view,
            name: alias[1],
            sourceView: view.name,
            dimensions: [],
            measures: [],
            segments: [],
          };
          projected.set(alias[1], model);
        }
        if (!model[key].some((existing) => existing.name === member.aliasMember))
          model[key].push({ ...member, name: member.aliasMember });
      }
    }
  }
  return { ...root, semanticModel: [...direct, ...projected.values()] };
}

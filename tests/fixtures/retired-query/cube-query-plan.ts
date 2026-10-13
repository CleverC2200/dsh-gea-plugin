import {
  cubeQueryModels,
  normalizeCubeOrderArguments,
  preflightCubeArguments,
} from "./cube-preflight.ts";
import {
  cubeResources,
  type AuthorizedResources,
  type AuthorizedResource,
} from "../../../src/host/authorized-resources.ts";
import type { ModelMembers } from "./member-index.ts";
type Parameters = Record<string, unknown>;
export type CubeQueryGroup = {
  model: string;
  resource: AuthorizedResource;
  parameters: Parameters;
  names: string[];
};
export function planCubeQuery(
  parameters: Parameters,
  snapshot: AuthorizedResources,
  index?: ReadonlyMap<string, ModelMembers>,
) {
  const input = normalizeCubeOrderArguments(parameters);
  const failure = preflightCubeArguments(input, undefined, { allowMultipleModels: true });
  if (failure) throw Error(failure);
  if (input.action !== "query" || !Array.isArray(input.queries))
    throw Error("GEA_CUBE_QUERY_REQUIRED");
  const groups = new Map<string, CubeQueryGroup>();
  const rejected: Array<{ names: string[]; code: string; message: string }> = [];
  for (const raw of input.queries) {
    const item = raw as { name: string; query: Parameters };
    const single = { ...input, queries: [item] };
    const invalid = preflightCubeArguments(single);
    if (invalid) {
      rejected.push({ names: [item.name], code: "GEA_CUBE_PREFLIGHT_BLOCKED", message: invalid });
      continue;
    }
    const models = cubeQueryModels([item]);
    if (models.length !== 1) {
      rejected.push({
        names: [item.name],
        code: "GEA_CUBE_MODEL_REQUIRED",
        message: "每条查询必须明确且只包含一个模型。",
      });
      continue;
    }
    const model = models[0];
    const matches = cubeResources(snapshot).filter((resource) => resource.queryTarget === model);
    if (matches.length !== 1) {
      rejected.push({
        names: [item.name],
        code: matches.length ? "GEA_RESOURCE_AMBIGUOUS" : "GEA_RESOURCE_NOT_AUTHORIZED",
        message: matches.length
          ? "当前授权快照内模型资源匹配不唯一，需要平台核对绑定。"
          : "当前 Agent 的授权快照没有该查询目标，不能使用 inspect 目录代替授权，也不要换身份试探。",
      });
      continue;
    }
    const memberError = preflightCubeArguments(single, index);
    if (memberError) {
      rejected.push({
        names: [item.name],
        code: "GEA_CUBE_PREFLIGHT_BLOCKED",
        message: memberError,
      });
      continue;
    }
    const resource = matches[0];
    const maximum = Math.min(200, resource.maxRows ?? 200);
    const requested = item.query.limit;
    if (typeof requested === "number" && requested > maximum) {
      rejected.push({
        names: [item.name],
        code: "GEA_RESOURCE_ROW_LIMIT",
        message: `本次单项查询最多 ${maximum} 行；请明确缩小查询范围或使用聚合。`,
      });
      continue;
    }
    const query = { ...item, query: { ...item.query, limit: requested ?? Math.min(50, maximum) } };
    let group = groups.get(model);
    if (!group) {
      group = { model, resource, parameters: { ...input, queries: [] }, names: [] };
      groups.set(model, group);
    }
    (group.parameters.queries as unknown[]).push(query);
    group.names.push(item.name);
  }
  return { groups: [...groups.values()], rejected };
}

import { cubeResources, type AuthorizedResources } from "../../../src/host/authorized-resources.ts";

/** Derived only from this call's trusted snapshot. There is no global model-to-Agent cache. */
export function resourceConsumers(
  snapshot: AuthorizedResources,
  consumerCode: string,
): ReadonlyMap<string, string> {
  return new Map(cubeResources(snapshot).map((resource) => [resource.queryTarget, consumerCode]));
}

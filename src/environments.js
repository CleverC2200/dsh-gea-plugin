/** Resolve deployment-owned GEA endpoints; browser requests may select names only. */
export function resolveEnvironments(config) {
  const environment = config.environment ?? "production";
  if (!["production", "test"].includes(environment))
    throw new Error("INVALID_GEA_ENVIRONMENT");
  const urls = config.geaEnvironments ?? { [environment]: config.geaBaseUrl };
  if (!urls || typeof urls !== "object" || Array.isArray(urls))
    throw new Error("INVALID_GEA_ENVIRONMENTS");
  if (
    config.geaEnvironments &&
    (Object.keys(urls).length !== 2 || !urls.production || !urls.test)
  )
    throw new Error("INVALID_GEA_ENVIRONMENTS");
  /** @type {Record<string, string>} */
  const environments = {};
  for (const [name, value] of Object.entries(urls)) {
    if (!["production", "test"].includes(name))
      throw new Error("INVALID_GEA_ENVIRONMENT");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("INVALID_GEA_BASE_URL");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("INVALID_GEA_BASE_URL");
    environments[name] = url.href.replace(/\/$/, "");
  }
  return { environment, environments, baseUrl: environments[environment] };
}

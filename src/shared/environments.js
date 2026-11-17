export function resolveEnvironments(config) {
  const environment = config.environment ?? "production";
  if (!["production", "test"].includes(environment)) throw new Error("INVALID_GEA_ENVIRONMENT");
  const urls = config.geaEnvironments ?? { [environment]: config.geaBaseUrl };
  if (!urls || typeof urls !== "object" || Array.isArray(urls))
    throw new Error("INVALID_GEA_ENVIRONMENTS");
  if (config.geaEnvironments && (Object.keys(urls).length !== 2 || !urls.production || !urls.test))
    throw new Error("INVALID_GEA_ENVIRONMENTS");

  const environments = {};
  for (const [name, value] of Object.entries(urls)) {
    if (!["production", "test"].includes(name)) throw new Error("INVALID_GEA_ENVIRONMENT");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("INVALID_GEA_BASE_URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      throw new Error("INVALID_GEA_BASE_URL");
    environments[name] = url.href.replace(/\/$/, "");
  }
  if (!environments[environment]) throw new Error("INVALID_GEA_ENVIRONMENTS");
  if (environments.production && environments.production === environments.test)
    throw new Error("GEA_ENVIRONMENTS_NOT_DISTINCT");
  if (
    environments.production &&
    environments.test &&
    (environments.production.startsWith(environments.test + "/") ||
      environments.test.startsWith(environments.production + "/"))
  )
    throw new Error("GEA_ENVIRONMENTS_OVERLAP");
  if (
    environments.production === "https://gea.synear.cn:4443/gea-boot" ||
    environments.test === "https://gea.synear.cn/gea-boot"
  )
    throw new Error("GEA_ENVIRONMENT_TARGET_MISMATCH");
  return { environment, environments, baseUrl: environments[environment] };
}

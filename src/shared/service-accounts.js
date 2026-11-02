export function validateServiceAccounts(value) {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_SERVICE_ACCOUNTS");
  for (const [environment, raw] of Object.entries(value)) {
    if (
      !["production", "test"].includes(environment) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    )
      throw new Error("INVALID_SERVICE_ACCOUNTS");
    delete raw.allowedUserIds;
    const config = raw;
    if (
      Object.keys(config).some(
        (key) => !["clientIdEnv", "clientSecretEnv", "keychainService", "tenantId"].includes(key),
      ) ||
      !/^GEA_[A-Z0-9_]+$/.test(String(config.clientIdEnv ?? "")) ||
      !/^GEA_[A-Z0-9_]+$/.test(String(config.clientSecretEnv ?? "")) ||
      config.clientIdEnv === config.clientSecretEnv ||
      (config.keychainService !== undefined &&
        (typeof config.keychainService !== "string" ||
          !/^[a-zA-Z0-9._-]+$/.test(config.keychainService))) ||
      typeof config.tenantId !== "string" ||
      !/^\d+$/.test(config.tenantId)
    )
      throw new Error("INVALID_SERVICE_ACCOUNTS");
  }
}

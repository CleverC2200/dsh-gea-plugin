import { execFileSync } from "node:child_process";

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
    const config = raw;
    if (
      Object.keys(config).some(
        (key) =>
          ![
            "clientIdEnv",
            "clientSecretEnv",
            "keychainService",
            "tenantId",
            "allowedUserIds",
          ].includes(key),
      ) ||
      !/^GEA_[A-Z0-9_]+$/.test(String(config.clientIdEnv ?? "")) ||
      !/^GEA_[A-Z0-9_]+$/.test(String(config.clientSecretEnv ?? "")) ||
      config.clientIdEnv === config.clientSecretEnv ||
      (config.keychainService !== undefined &&
        (typeof config.keychainService !== "string" ||
          !/^[a-zA-Z0-9._-]+$/.test(config.keychainService))) ||
      typeof config.tenantId !== "string" ||
      !/^\d+$/.test(config.tenantId) ||
      !Array.isArray(config.allowedUserIds) ||
      !config.allowedUserIds.length ||
      config.allowedUserIds.some((id) => typeof id !== "string" || !id.trim())
    )
      throw new Error("INVALID_SERVICE_ACCOUNTS");
  }
}

function readServiceAccountKeychain(service) {
  try {
    return JSON.parse(
      execFileSync(
        "/usr/bin/security",
        ["find-generic-password", "-a", "service-account", "-s", service, "-w"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 },
      ),
    );
  } catch {
    throw new Error("GEA_KEYCHAIN_CREDENTIAL_MISSING");
  }
}

export async function loadServiceAccountCredentials(
  serviceAccounts,
  {
    credentialEnv = process.env,
    platform = process.platform,
    readKeychain = readServiceAccountKeychain,
    resolveCredentials = true,
  } = {},
) {
  validateServiceAccounts(serviceAccounts);
  const credentials = {};
  for (const account of Object.values(serviceAccounts ?? {})) {
    if (!account.keychainService || !resolveCredentials) continue;
    if (platform !== "darwin") throw new Error("GEA_KEYCHAIN_UNAVAILABLE");
    let loaded;
    try {
      loaded = await readKeychain(account.keychainService);
    } catch {
      throw new Error("GEA_KEYCHAIN_CREDENTIAL_MISSING");
    }
    if (
      typeof loaded?.clientId !== "string" ||
      !loaded.clientId.trim() ||
      typeof loaded?.secret !== "string" ||
      !loaded.secret.trim()
    )
      throw new Error("GEA_KEYCHAIN_CREDENTIAL_INVALID");
    credentials[account.clientIdEnv] = loaded.clientId;
    credentials[account.clientSecretEnv] = loaded.secret;
  }
  Object.assign(credentialEnv, credentials);
}

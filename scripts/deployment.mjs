/** Validate deployment inputs before creating a profile or reading credentials. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Parse an HTTPS endpoint and reject credentials or URL routing metadata. */
function httpsEndpoint(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(code);
  return url;
}

/** Read the selected AionUi proxy through its local API; never claim or decrypt an upstream secret. */
async function resolveAionUi(analysis) {
  const backend = new URL(analysis.backendUrl);
  if (
    backend.protocol !== "http:" ||
    backend.hostname !== "127.0.0.1" ||
    backend.username ||
    backend.password ||
    backend.search ||
    backend.hash ||
    backend.pathname !== "/"
  )
    throw new Error("AIONUI_BACKEND_MUST_BE_LOOPBACK");
  if (
    typeof analysis.providerId !== "string" ||
    !analysis.providerId.startsWith("gea-personal-")
  )
    throw new Error("AIONUI_PROVIDER_REQUIRED");
  let result;
  try {
    const response = await fetch(new URL("/api/providers", backend), {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch {
    throw new Error("AIONUI_BACKEND_UNAVAILABLE");
  }
  const providers = Array.isArray(result.data)
    ? result.data.filter(
        (p) => p.id === analysis.providerId && p.enabled === true,
      )
    : [];
  if (providers.length !== 1) throw new Error("AIONUI_PROVIDER_UNAVAILABLE");
  const provider = providers[0];
  const proxy = new URL(provider.base_url);
  if (
    proxy.protocol !== "http:" ||
    proxy.hostname !== "127.0.0.1" ||
    proxy.username ||
    proxy.password ||
    proxy.search ||
    proxy.hash ||
    proxy.pathname !== "/personal/" + provider.id
  )
    throw new Error("AIONUI_PROXY_MUST_BE_LOOPBACK");
  if (
    provider.platform !== "openai" ||
    !Array.isArray(provider.models) ||
    !provider.models.includes(analysis.model) ||
    provider.model_enabled?.[analysis.model] === false
  )
    throw new Error("AIONUI_MODEL_UNAVAILABLE");
  if (typeof provider.api_key !== "string" || !provider.api_key.trim())
    throw new Error("AIONUI_PROXY_CREDENTIAL_MISSING");
  let models;
  try {
    const response = await fetch(proxy.href + "/models", {
      headers: { Authorization: "Bearer " + provider.api_key },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error();
    models = await response.json();
  } catch {
    throw new Error("AIONUI_PROXY_UNAVAILABLE");
  }
  if (
    !Array.isArray(models.data) ||
    !models.data.some((model) => model.id === analysis.model)
  )
    throw new Error("AIONUI_MODEL_UNAVAILABLE");
  return {
    ...analysis,
    baseUrl: proxy.href,
    apiKeyEnv: "GEA_AIONUI_PROXY_KEY",
    credential: provider.api_key,
  };
}

export async function readDeployment(path) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(
      "GEA_CONFIG_FILE: provide a readable JSON deployment with --config",
    );
  }
  if (!config || Array.isArray(config) || typeof config !== "object")
    throw new Error("GEA_CONFIG_INVALID");
  const url = httpsEndpoint(config.geaBaseUrl, "INVALID_GEA_BASE_URL");
  if (config.modelRequestTimeoutMs === undefined)
    config.modelRequestTimeoutMs = 120000;
  for (const [name, low, high] of [
    ["pageSize", 1, 100],
    ["periodPageSize", 1, 1000],
    ["requestTimeoutMs", 1000, 120000],
    ["modelRequestTimeoutMs", 1000, 600000],
    ["maxSnapshotBytes", 1000, 5000000],
  ]) {
    if (
      !Number.isSafeInteger(config[name]) ||
      config[name] < low ||
      config[name] > high
    )
      throw new Error("INVALID_" + name);
  }
  if (!config.analysis || !["receipt", "model"].includes(config.analysis.mode))
    throw new Error("ANALYSIS_MODE_REQUIRED");
  if (config.analysis.mode === "model") {
    let a = config.analysis;
    if (typeof a.model !== "string" || !a.model.trim())
      throw new Error("ANALYSIS_CONFIG_INCOMPLETE");
    if (
      !Number.isSafeInteger(a.contextWindow) ||
      !Number.isSafeInteger(a.maxTokens) ||
      a.maxTokens < 1 ||
      a.contextWindow <= a.maxTokens + 1000
    )
      throw new Error("ANALYSIS_TOKEN_BUDGET_INVALID");
    if (a.source === "aionui") a = await resolveAionUi(a);
    else if (a.source === "gea") {
      if (
        typeof a.agentCode !== "string" ||
        !/^[A-Za-z0-9._:-]{1,100}$/.test(a.agentCode)
      )
        throw new Error("ANALYSIS_AGENT_CODE_INVALID");
    } else {
      if (a.source !== undefined && a.source !== "direct")
        throw new Error("ANALYSIS_SOURCE_INVALID");
      httpsEndpoint(a.baseUrl, "INVALID_ANALYSIS_BASE_URL");
      if (!/^[A-Z][A-Z0-9_]*$/.test(a.apiKeyEnv ?? ""))
        throw new Error("ANALYSIS_CONFIG_INCOMPLETE");
      if (!process.env[a.apiKeyEnv]?.trim())
        throw new Error("ANALYSIS_CREDENTIAL_MISSING");
    }
    config.analysis = a;
  }
  return { ...config, geaBaseUrl: url.href.replace(/\/$/, "") };
}

/** Build ordinary patch rows for the supported dsh profile launcher. */
export function deploymentPatch(config, root, runtime) {
  const model = config.analysis.mode === "model";
  const analysis = config.analysis;
  const rows = [
    { id: "session-title-llm", disabled: true },
    {
      id: "agent-default-model",
      config: {
        provider: model ? "gea-analysis" : "gea-proof",
        model: model ? analysis.model : "receipt",
      },
    },
    {
      id: "agent-presets",
      config: {
        default: "gea-readonly",
        includeShippedRoot: false,
        includeUserRoot: false,
        roots: [{ path: resolve(root, "presets"), trust: "system" }],
      },
    },
    {
      insert: [
        {
          id: "gea-proof",
          name: resolve(root, "lib/host.js"),
          config: {
            geaBaseUrl: config.geaBaseUrl,
            pageSize: config.pageSize,
            periodPageSize: config.periodPageSize,
            requestTimeoutMs: config.requestTimeoutMs,
            modelRequestTimeoutMs: config.modelRequestTimeoutMs,
            maxSnapshotBytes: config.maxSnapshotBytes,
            runtimeDir: runtime,
            analysisMode: analysis.mode,
            analysisModel: model ? analysis.model : "receipt",
            analysisAgentCode: model
              ? (analysis.agentCode ?? "sales_forecast")
              : "sales_forecast",
            analysisSource: model ? (analysis.source ?? "direct") : "receipt",
            inputByteBudget: model
              ? Math.min(
                  config.maxSnapshotBytes,
                  analysis.contextWindow - analysis.maxTokens - 1000,
                )
              : config.maxSnapshotBytes,
          },
        },
      ],
    },
  ];
  if (model && analysis.source !== "gea")
    rows.push({
      id: "llm-pi-ai",
      config: {
        providers: {
          "gea-analysis": {
            displayName: "GEA analysis",
            api: "openai-completions",
            baseURL: analysis.baseUrl,
            apiKeyEnv: analysis.apiKeyEnv,
            retryPolicy: { mode: "normal", maxRetries: 0 },
            models: [
              {
                id: analysis.model,
                name: analysis.model,
                contextWindow: analysis.contextWindow,
                maxTokens: analysis.maxTokens,
                reasoningEfforts: false,
              },
            ],
          },
        },
      },
    });
  return rows;
}

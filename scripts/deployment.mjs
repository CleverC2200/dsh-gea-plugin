import { resolveEnvironments } from "../src/environments.js";
/** Validate deployment inputs before creating a profile or reading credentials. */
import {
  readFile,
  mkdir,
  symlink,
  realpath,
  lstat,
  unlink,
} from "node:fs/promises";
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
  const selected = resolveEnvironments(config);
  config.environment = selected.environment;
  const url = httpsEndpoint(selected.baseUrl, "INVALID_GEA_BASE_URL");
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
    const a = config.analysis;
    if (typeof a.model !== "string" || !a.model.trim())
      throw new Error("ANALYSIS_CONFIG_INCOMPLETE");
    if (
      !Number.isSafeInteger(a.contextWindow) ||
      !Number.isSafeInteger(a.maxTokens) ||
      a.maxTokens < 1 ||
      a.contextWindow <= a.maxTokens + 1000
    )
      throw new Error("ANALYSIS_TOKEN_BUDGET_INVALID");
    if (a.source === "aionui")
      throw new Error(
        "AIONUI_RUNTIME_REMOVED: use analysis.source=gea with the GEA login",
      );
    if (a.source === "gea") {
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
        default: "standard",
        includeShippedRoot: false,
        includeUserRoot: false,
        roots: [
          { path: resolve(runtime, "native-presets"), trust: "system" },
          { path: resolve(root, "presets"), trust: "system" },
        ],
      },
    },
    {
      insert: [
        {
          id: "gea-proof",
          name: resolve(root, "lib/host.js"),
          config: {
            geaBaseUrl: config.geaBaseUrl,
            serviceAccounts: config.serviceAccounts,
            environment: config.environment,
            geaEnvironments: config.geaEnvironments,
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

/** Expose only the original standard preset, without copying or modifying DSH's composition. */
export async function prepareNativePreset(runtime, dshSource) {
  const parent = resolve(runtime, "native-presets");
  const target = resolve(
    dshSource,
    "packages/preset/agent-presets/presets/standard",
  );
  await readFile(resolve(target, "agent.cordis.yml"), "utf8");
  await mkdir(parent, { recursive: true });
  const directory = resolve(parent, "standard");
  // Upgrade the earlier directory-link layout: discovery only scans real directories.
  try {
    if ((await lstat(directory)).isSymbolicLink()) {
      if ((await realpath(directory)) !== (await realpath(target)))
        throw new Error("NATIVE_PRESET_CONFLICT");
      await unlink(directory);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  for (const name of ["agent.cordis.yml", "preset.yml"]) {
    const link = resolve(directory, name);
    const source = resolve(target, name);
    try {
      await symlink(source, link, "file");
    } catch (error) {
      if (
        error.code !== "EEXIST" ||
        (await realpath(link)) !== (await realpath(source))
      )
        throw error;
    }
  }
}

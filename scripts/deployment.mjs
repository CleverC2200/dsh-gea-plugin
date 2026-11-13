import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { validateServiceAccounts } from "../src/shared/service-accounts.js";
import { resolveEnvironments } from "../src/shared/environments.js";
import {
  DEFAULT_MEMORY_GATEWAY_URL,
  resolveMemoryGatewayUrl,
} from "../src/shared/memory-gateway.js";
import { validateSqlReadLimit } from "../src/shared/sql-read-limit.js";
import { validateSalesReadonly } from "../src/shared/sales-readonly.js";

import { readFile, mkdir, rm, symlink, realpath, lstat, unlink, writeFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

function httpsEndpoint(value, code) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(code);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(code);
  return url;
}

export async function readDeployment(
  path,
  { credentialEnv = process.env, checkDirectCredential = true } = {},
) {
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("GEA_CONFIG_FILE: provide a readable JSON deployment with --config");
  }
  if (!config || Array.isArray(config) || typeof config !== "object")
    throw new Error("GEA_CONFIG_INVALID");
  if (config.memoryGatewayAllowPrivateHttp === undefined)
    config.memoryGatewayAllowPrivateHttp = false;
  config.memoryGatewayUrl =
    resolveMemoryGatewayUrl(
      config.memoryGatewayUrl === undefined ? DEFAULT_MEMORY_GATEWAY_URL : config.memoryGatewayUrl,
      config.memoryGatewayAllowPrivateHttp,
    ) ?? "";
  validateSqlReadLimit(config.sqlReadLimit);
  if (
    config.workbenchCapability !== undefined &&
    (!config.workbenchCapability ||
      Array.isArray(config.workbenchCapability) ||
      typeof config.workbenchCapability !== "object" ||
      Object.keys(config.workbenchCapability).some(
        (key) => !["enabled", "readonlyValidation"].includes(key),
      ) ||
      (config.workbenchCapability.enabled !== undefined &&
        typeof config.workbenchCapability.enabled !== "boolean"))
  )
    throw new Error("INVALID_WORKBENCH_CAPABILITY");
  validateSalesReadonly(config.workbenchCapability?.readonlyValidation);
  if (config.mcpRequestTimeoutMs === undefined) config.mcpRequestTimeoutMs = 60000;
  if (config.mcpMaxResponseBytes === undefined) config.mcpMaxResponseBytes = 320 * 1024 * 1024;
  const selected = resolveEnvironments(config);
  config.environment = selected.environment;
  const url = httpsEndpoint(selected.baseUrl, "INVALID_GEA_BASE_URL");
  if (config.modelRequestTimeoutMs === undefined) config.modelRequestTimeoutMs = 300000;
  for (const [name, low, high] of [
    ["pageSize", 1, 100],
    ["periodPageSize", 1, 1000],
    ["requestTimeoutMs", 1000, 120000],
    ["mcpRequestTimeoutMs", 1000, 120000],
    ["mcpMaxResponseBytes", 1024, 1024 * 1024 * 1024],
    ["modelRequestTimeoutMs", 1000, 600000],
    ["maxSnapshotBytes", 1000, 5000000],
  ]) {
    if (!Number.isSafeInteger(config[name]) || config[name] < low || config[name] > high)
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
      throw new Error("AIONUI_RUNTIME_REMOVED: use analysis.source=gea with the GEA login");
    if (a.source === "gea") {
      if (typeof a.agentCode !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(a.agentCode))
        throw new Error("ANALYSIS_AGENT_CODE_INVALID");
    } else {
      if (a.source !== undefined && a.source !== "direct")
        throw new Error("ANALYSIS_SOURCE_INVALID");
      httpsEndpoint(a.baseUrl, "INVALID_ANALYSIS_BASE_URL");
      if (!/^[A-Z][A-Z0-9_]*$/.test(a.apiKeyEnv ?? ""))
        throw new Error("ANALYSIS_CONFIG_INCOMPLETE");
      if (checkDirectCredential && !credentialEnv[a.apiKeyEnv]?.trim())
        throw new Error("ANALYSIS_CREDENTIAL_MISSING");
    }
    config.analysis = a;
  }
  validateServiceAccounts(config.serviceAccounts);
  return { ...config, geaBaseUrl: url.href.replace(/\/$/, "") };
}

export function resolveWorkbench(anchor = import.meta.url) {
  try {
    const dependency = createRequire(anchor);
    const manifest = JSON.parse(
      readFileSync(dependency.resolve("@cleverc2200/dsh-agent-workbench/package.json"), "utf8"),
    );
    if (!/^0\.1\.\d+$/.test(manifest.version))
      throw new Error("WORKBENCH_INCOMPATIBLE: expected 0.1.x");
    return dependency.resolve("@cleverc2200/dsh-agent-workbench");
  } catch (error) {
    if (error.message.startsWith("WORKBENCH_INCOMPATIBLE")) throw error;
    throw new Error("WORKBENCH_MISSING: install the pinned independent workbench dependency");
  }
}

export function resolveBuiltinPlugins(anchor = import.meta.url) {
  const dependency = createRequire(anchor);
  const entry = (specifier, id) => {
    const manifest = JSON.parse(
      readFileSync(dependency.resolve(`${specifier}/package.json`), "utf8"),
    );
    if (!/^0\.\d+\.\d+/.test(manifest.version))
      throw new Error(`BUILTIN_PLUGIN_INCOMPATIBLE: ${manifest.name}@${manifest.version}`);
    return { id, name: dependency.resolve(manifest.name) };
  };
  try {
    return [
      {
        ...entry("@changfenhuang/dsh-genui", "genui"),

        config: { fenceFeedback: true },
      },
      entry("dsh-better-sidebar", "better-sidebar"),
    ];
  } catch (error) {
    if (error.message.startsWith("BUILTIN_PLUGIN_INCOMPATIBLE")) throw error;
    throw new Error(
      `BUILTIN_PLUGIN_MISSING: install the bundled genui and better-sidebar dependencies (${error.message})`,
    );
  }
}

export function businessDeploymentPatch(
  config,
  root,
  runtime,
  { bundle = false, workspace, workbenchConfig = {} } = {},
) {
  if (workspace !== undefined && (typeof workspace !== "string" || !isAbsolute(workspace)))
    throw new Error("WORKBENCH_WORKSPACE_ABSOLUTE_REQUIRED");
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
      insert: [
        {
          id: "gea-proof",
          name: resolve(root, "lib/host.js"),
          config: {
            geaBaseUrl: config.geaBaseUrl,
            memoryGatewayUrl: config.memoryGatewayUrl,
            memoryGatewayAllowPrivateHttp: config.memoryGatewayAllowPrivateHttp,
            serviceAccounts: config.serviceAccounts,
            dms: config.dms,
            orderFulfillmentConfirmation: config.orderFulfillmentConfirmation,
            fcStorage: config.fcStorage,
            environment: config.environment,
            geaEnvironments: config.geaEnvironments,
            pageSize: config.pageSize,
            periodPageSize: config.periodPageSize,
            requestTimeoutMs: config.requestTimeoutMs,
            mcpRequestTimeoutMs: config.mcpRequestTimeoutMs,
            mcpMaxResponseBytes: config.mcpMaxResponseBytes,
            cubeMcpCodes: config.cubeMcpCodes,
            modelRequestTimeoutMs: config.modelRequestTimeoutMs,
            maxSnapshotBytes: config.maxSnapshotBytes,
            runtimeDir: runtime,
            analysisMode: analysis.mode,
            analysisModel: model ? analysis.model : "receipt",
            analysisAgentCode: model ? (analysis.agentCode ?? "sales_forecast") : "sales_forecast",
            analysisSource: model ? (analysis.source ?? "direct") : "receipt",
            inputByteBudget: model
              ? Math.min(
                  config.maxSnapshotBytes,
                  analysis.contextWindow - analysis.maxTokens - 1000,
                )
              : config.maxSnapshotBytes,

            agentSqlRead: config.agentSqlRead === true,
            workbenchCapability: config.workbenchCapability,
            sqlReadLimit: config.sqlReadLimit,
            visibleContextSubagent: config.visibleContextSubagent ?? true,
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
  if (workspace !== undefined)
    rows.push({ id: "agent-workbench", config: { ...workbenchConfig, cwd: workspace } });
  if (bundle)
    return rows.flatMap((row) => {
      if (row.id === "ui-layout") return [];
      if (row.insert?.some((entry) => entry.id === "gea-proof"))
        return row.insert.map(({ name: _name, ...entry }) => entry);
      return [row];
    });
  return rows;
}

export function deploymentPatch(config, root, runtime, { bundle = false } = {}) {
  const [title, model, ...business] = businessDeploymentPatch(config, root, runtime);
  const rows = [
    {
      insert: [
        {
          id: "agent-workbench",
          name: resolveWorkbench(),
          config: { cwd: resolve(runtime, "workspace") },
        },
      ],
    },
    { insert: resolveBuiltinPlugins() },
    title,
    model,
    {
      id: "agent-presets",
      config: {
        default: DEFAULT_PRESET_ID,
        includeShippedRoot: false,
        includeUserRoot: false,
        roots: [
          { path: resolve(runtime, "native-presets"), trust: "system" },
          ...presetRoots(root),
        ],
      },
    },

    ...(process.env.GEA_BROWSER_MCP === "1"
      ? [
          {
            insert: [
              {
                id: "mcp-browser",
                name: "@deepseek-ai/dsh-mcp-client",
                config: {
                  serverName: "browser",
                  transport: "stdio",
                  command: "npx",
                  args: ["-y", "@playwright/mcp@0.0.82", "--browser", "chrome"],
                },
              },
            ],
          },
        ]
      : []),
    ...business,
  ];
  if (bundle)
    return rows.flatMap((row) => {
      if (
        row.insert?.some((entry) =>
          ["agent-workbench", "genui", "better-sidebar", "gea-proof"].includes(entry.id),
        )
      )
        return row.insert.map(({ name: _name, ...entry }) => entry);
      return [row];
    });
  return rows;
}

export const DEFAULT_PRESET_ID = "auto-negotiation";
export const DEFAULT_PRESET_NAME = "智能编排";

function presetRoots(root) {
  return [
    resolve(root, "node_modules/@cleverc2200/gea-dsh-prototype/default-presets"),
    resolve(root, "default-presets"),
    resolve(root, "presets"),
  ]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, trust: "system" }));
}

async function placeCompositionFile(link, source, createLink) {
  const content = await readFile(source);
  let entry = null;
  try {
    entry = await lstat(link);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (entry?.isSymbolicLink()) {
    let current = null;
    try {
      current = await realpath(link);
    } catch {
      current = null;
    }
    if (current === (await realpath(source))) return;
    await unlink(link);
    entry = null;
  }
  if (entry) {
    const existing = await readFile(link).catch(() => null);
    if (existing?.equals(content)) return;

    await writeFile(link, content, { mode: 0o600 });
    return;
  }
  try {
    await createLink(source, link, "file");
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    await writeFile(link, content, { mode: 0o600 });
  }
}

export async function prepareNativePreset(runtime, target, { createLink = symlink } = {}) {
  const parent = resolve(runtime, "native-presets");
  await readFile(resolve(target, "agent.cordis.yml"), "utf8");
  await mkdir(parent, { recursive: true });

  const legacy = resolve(parent, "standard");
  try {
    const entry = await lstat(legacy);
    if (entry.isSymbolicLink()) await unlink(legacy);
    else await rm(legacy, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = resolve(parent, DEFAULT_PRESET_ID);

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

  await placeCompositionFile(
    resolve(directory, "agent.cordis.yml"),
    resolve(target, "agent.cordis.yml"),
    createLink,
  );

  const preset = await readFile(resolve(target, "preset.yml"), "utf8");
  const renamed = preset.replace(/^name:.*$/m, `name: ${DEFAULT_PRESET_NAME}`);
  const presetPath = resolve(directory, "preset.yml");
  await rm(presetPath, { force: true });
  await writeFile(presetPath, renamed, { mode: 0o600 });
}

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveEnvironments } from "../src/shared/environments.js";
/** Validate deployment inputs before creating a profile or reading credentials. */
import {
  readFile,
  mkdir,
  rm,
  symlink,
  realpath,
  lstat,
  unlink,
  writeFile,
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
  if (config.mcpRequestTimeoutMs === undefined) config.mcpRequestTimeoutMs = 60000;
  const selected = resolveEnvironments(config);
  config.environment = selected.environment;
  const url = httpsEndpoint(selected.baseUrl, "INVALID_GEA_BASE_URL");
  if (config.modelRequestTimeoutMs === undefined)
    config.modelRequestTimeoutMs = 120000;
  for (const [name, low, high] of [
    ["pageSize", 1, 100],
    ["periodPageSize", 1, 1000],
    ["requestTimeoutMs", 1000, 120000],
    ["mcpRequestTimeoutMs", 1000, 120000],
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

/** Resolve the supported public workbench API before writing runtime state. */
export function resolveWorkbench(anchor = import.meta.url) {
  try {
    const dependency = createRequire(anchor);
    const manifest = JSON.parse(readFileSync(dependency.resolve("@cleverc2200/dsh-agent-workbench/package.json"), "utf8"));
    if (!/^0\.1\.\d+$/.test(manifest.version)) throw new Error("WORKBENCH_INCOMPATIBLE: expected 0.1.x");
    return dependency.resolve("@cleverc2200/dsh-agent-workbench");
  } catch (error) {
    if (error.message.startsWith("WORKBENCH_INCOMPATIBLE")) throw error;
    throw new Error("WORKBENCH_MISSING: install the pinned independent workbench dependency");
  }
}

/**
 * Resolve the built-in content plugins every GEA composition mounts.
 *
 * genui renders model-authored inline UI; better-sidebar adds the right-Sidebar
 * explorer/editor/terminal/git/browser tab types. Both are ordinary
 * dependencies of this package, so a release install resolves them from its own
 * node_modules; a source checkout resolves them from the development install.
 * The rows carry an absolute entry path in non-bundle compositions and lose it
 * in bundle compositions, where the package's own `cordis.patch.yml` mounts the
 * same ids by package name.
 */
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
        // 围栏渲染失败时把逐节点诊断送回同一轮，让模型重发修正版。
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

/** Build ordinary patch rows for the supported dsh profile launcher. */
export function deploymentPatch(config, root, runtime, { bundle = false } = {}) {
  const model = config.analysis.mode === "model";
  const analysis = config.analysis;
  const rows = [
    { id: "ui-layout", disabled: true },
    { insert: [{ id: "agent-workbench", name: resolveWorkbench(), config: { cwd: resolve(runtime, "workspace") } }] },
    { insert: resolveBuiltinPlugins() },
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
        default: DEFAULT_PRESET_ID,
        includeShippedRoot: false,
        includeUserRoot: false,
        // 默认预设随插件包分发（default-presets/）：客户端只更新插件、外壳还是旧的时候，
        // 也必须能解析到 auto-negotiation，否则默认预设会找不到。
        roots: [
          { path: resolve(runtime, "native-presets"), trust: "system" },
          ...presetRoots(root),
        ],
      },
    },
    // 默认助手（标准模式）要能操作浏览器：挂 Playwright MCP，工具名形如 mcp__browser__browser_navigate。
    // 本机文件与 Shell 由标准模式自带的 fs/bash 工具承担；这里只补浏览器这一块。
    // 每次启动都会拉起一个 npx 进程 + 浏览器，测试和批量启动的场合用 GEA_BROWSER_MCP=0 关掉。
    ...(process.env.GEA_BROWSER_MCP === "0"
      ? []
      : [
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
        ]),
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
            mcpRequestTimeoutMs: config.mcpRequestTimeoutMs,
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
  if (config.workbenchExample === true) rows.push({ insert: [{ id: "workbench-example", name: resolve(root, "packages/workbench-example/lib/host.js") }] });
  if (bundle) return rows.flatMap(row => {
    if (row.id === "ui-layout") return [];
    if (row.insert?.some(entry => ["agent-workbench", "genui", "better-sidebar"].includes(entry.id))) return row.insert.map(({ name, ...entry }) => entry);
    if (row.insert?.some(entry => entry.id === "gea-proof")) return row.insert.map(({ name, ...entry }) => entry);
    return [row];
  });
  return rows;
}

/**
 * 默认 preset 沿用 DSH 标准组合，但走我们自己的 id：
 * DSH 对内置 id `standard` 会强行用它自带的显示名（标准模式），换个 id 才能改显示名。
 */
export const DEFAULT_PRESET_ID = "auto-negotiation";
export const DEFAULT_PRESET_NAME = "流程编排Agent";

/**
 * 预设发现目录：先找插件包内的 default-presets（桌面端整包安装后的布局），
 * 再找仓库根的 default-presets / presets（源码与开发态）。不存在的目录不登记。
 */
function presetRoots(root) {
  return [
    resolve(root, "node_modules/@cleverc2200/gea-dsh-prototype/default-presets"),
    resolve(root, "default-presets"),
    resolve(root, "presets"),
  ]
    .filter((path) => existsSync(path))
    .map((path) => ({ path, trust: "system" }));
}

/**
 * 把组合文件放进 native-presets：优先软链 DSH 原始文件，保证能力集不被改动。
 *
 * Windows 创建文件软链需要 SeCreateSymbolicLinkPrivilege（开发者模式或管理员），
 * 普通账户只会拿到 EPERM；目录还能退到 junction，文件没有等价物，所以这里退回写一份
 * 内容逐字节相同的副本 —— native-presets 是启动器每次启动重建的派生目录，副本同样会在
 * 下一次启动被刷新，能力集不变。
 */
async function placeCompositionFile(link, source, createLink) {
  const content = await readFile(source);
  let entry = null;
  try {
    entry = await lstat(link);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (entry?.isSymbolicLink()) {
    // 切换已准备版本后这里仍指向上一版组合目录。只替换软链本身。
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
    // 真实文件：内容一致就是旧版复制布局留下的副本，原样沿用。
    const existing = await readFile(link).catch(() => null);
    if (existing?.equals(content)) return;
    // 内容落后于当前 DSH 包：重写。这里和同目录的 preset.yml 一样，是启动器自己的派生目录。
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

/** Expose only the original standard preset, without copying or modifying DSH's composition. */
export async function prepareNativePreset(runtime, target, { createLink = symlink } = {}) {
  const parent = resolve(runtime, "native-presets");
  await readFile(resolve(target, "agent.cordis.yml"), "utf8");
  await mkdir(parent, { recursive: true });
  // 旧版本发布的是 native-presets/standard：可能是目录，也可能是指向 DSH 包目录的软链。
  // 软链只删链接本身，别顺着链接把 DSH 包里的预设删了。
  const legacy = resolve(parent, "standard");
  try {
    const entry = await lstat(legacy);
    if (entry.isSymbolicLink()) await unlink(legacy);
    else await rm(legacy, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = resolve(parent, DEFAULT_PRESET_ID);
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
  // 组合文件继续软链 DSH 原始文件，保证能力集不被改动；没有软链权限的机器退回副本。
  await placeCompositionFile(
    resolve(directory, "agent.cordis.yml"),
    resolve(target, "agent.cordis.yml"),
    createLink,
  );
  // 只有显示名不一样：写自己的一份 preset.yml。
  // 老版本在这里留的是指向 DSH 包内的软链，必须先删掉，否则会顺着链接改到包里。
  const preset = await readFile(resolve(target, "preset.yml"), "utf8");
  const renamed = preset.replace(/^name:.*$/m, `name: ${DEFAULT_PRESET_NAME}`);
  const presetPath = resolve(directory, "preset.yml");
  await rm(presetPath, { force: true });
  await writeFile(presetPath, renamed, { mode: 0o600 });
}

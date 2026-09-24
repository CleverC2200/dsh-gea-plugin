import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { fileURLToPath, pathToFileURL } from "node:url";

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

function readServiceAccountKeychain(service) {
  try {
    return JSON.parse(execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-a", "service-account", "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 },
    ));
  } catch {
    throw new Error("GEA_KEYCHAIN_CREDENTIAL_MISSING");
  }
}

/** The desktop launcher imports this function from the installed GEA plugin before spawning its Host. */
export async function readDeployment(path, {
  credentialEnv = process.env,
  platform = process.platform,
  readKeychain = readServiceAccountKeychain,
} = {}) {
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
  const serviceAccounts = config.serviceAccounts;
  if (serviceAccounts !== undefined && (!serviceAccounts || typeof serviceAccounts !== "object" || Array.isArray(serviceAccounts)))
    throw new Error("INVALID_SERVICE_ACCOUNTS");
  const credentials = {};
  for (const [environment, account] of Object.entries(serviceAccounts ?? {})) {
    if (!["production", "test"].includes(environment) || !account || typeof account !== "object" || Array.isArray(account) ||
        Object.keys(account).some((key) => !["clientIdEnv", "clientSecretEnv", "keychainService", "tenantId", "allowedUserIds"].includes(key)) ||
        ![account.clientIdEnv, account.clientSecretEnv].every((name) => /^GEA_[A-Z0-9_]+$/.test(name ?? "")) ||
        account.clientIdEnv === account.clientSecretEnv || typeof account.tenantId !== "string" ||
        !/^\d+$/.test(account.tenantId) || !Array.isArray(account.allowedUserIds) ||
        !account.allowedUserIds.length || account.allowedUserIds.some((id) => typeof id !== "string" || !id.trim()) ||
        (account.keychainService !== undefined && (typeof account.keychainService !== "string" ||
          !/^[a-zA-Z0-9._-]+$/.test(account.keychainService)))) throw new Error("INVALID_SERVICE_ACCOUNTS");
    if (!account.keychainService) continue;
    if (platform !== "darwin") throw new Error("GEA_KEYCHAIN_UNAVAILABLE");
    let loaded;
    try { loaded = await readKeychain(account.keychainService); }
    catch { throw new Error("GEA_KEYCHAIN_CREDENTIAL_MISSING"); }
    if (typeof loaded?.clientId !== "string" || !loaded.clientId.trim() ||
        typeof loaded?.secret !== "string" || !loaded.secret.trim()) throw new Error("GEA_KEYCHAIN_CREDENTIAL_INVALID");
    credentials[account.clientIdEnv] = loaded.clientId;
    credentials[account.clientSecretEnv] = loaded.secret;
  }
  Object.assign(credentialEnv, credentials);
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
    // 浏览器 MCP（Playwright）**默认不挂**：它一次注入 25 个 mcp__browser__* 工具，实测
    // 合计 18,498 字符，占工具清单 2/3（整块从 12.2k 推到 27.7k）——业务问答用不到它，
    // 却每次请求都付这份上下文；每次启动还会拉起一个 npx 进程 + 浏览器。
    // 需要浏览器自动化的场合显式打开：GEA_BROWSER_MCP=1。
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
            // 问答侧默认关掉"模型自己写 SQL"：取数只走模块 MCP + 页面证据。
            // 需要临时打开时在部署配置里写 agentSqlRead: true。
            agentSqlRead: config.agentSqlRead === true,
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
export const DEFAULT_PRESET_NAME = "智能编排";

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

/** Prepare the renamed DSH standard preset and the ordered sales-plan preset. */
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

  // 销售计划原本位于后面的插件包预设根，无法排在产销协同与库存之间。
  // 以相同 id 放进第一个派生根；发现时先根获胜，旧会话仍使用 gea-readonly。
  const businessSource = fileURLToPath(new URL("../presets/gea-readonly/", import.meta.url));
  const businessDirectory = resolve(parent, "gea-readonly");
  await mkdir(businessDirectory, { recursive: true });
  // 搬到 runtime 后，相对模块名会按新目录解析；改为包内文件 URL，避免会话创建失败。
  const sourceComposition = await readFile(resolve(businessSource, "agent.cordis.yml"), "utf8");
  const relativeSkillReference = "name: '../../lib/skill-reference.js'";
  if (!sourceComposition.includes(relativeSkillReference))
    throw new Error("GEA_BUSINESS_PRESET_REFERENCE_CHANGED");
  const skillReferenceUrl = pathToFileURL(
    fileURLToPath(new URL("../lib/skill-reference.js", import.meta.url)),
  ).href;
  const businessCompositionPath = resolve(businessDirectory, "agent.cordis.yml");
  await rm(businessCompositionPath, { force: true });
  await writeFile(
    businessCompositionPath,
    sourceComposition.replace(relativeSkillReference, `name: '${skillReferenceUrl}'`),
    { mode: 0o600 },
  );
  const orderConfig = JSON.parse(
    await readFile(new URL("../presets/agent-presets.json", import.meta.url), "utf8"),
  );
  const businessOrder = orderConfig.order?.indexOf("gea-readonly") + 1;
  if (!Number.isInteger(businessOrder) || businessOrder < 1)
    throw new Error("GEA_PRESET_ORDER_INVALID");
  const businessMetadata = (await readFile(resolve(businessSource, "preset.yml"), "utf8"))
    .replace(/^order:.*(?:\r?\n|$)/m, "")
    .trimEnd();
  const businessPresetPath = resolve(businessDirectory, "preset.yml");
  await rm(businessPresetPath, { force: true });
  await writeFile(businessPresetPath, `${businessMetadata}\norder: ${businessOrder}\n`, { mode: 0o600 });
}

import { loadServiceAccountCredentials } from "./shared/service-accounts.js";
import type { ServiceAccounts } from "./host/service-account.ts";
import { GeaModelAdapter, geaKeptReasoningEffort } from "./host/gea-model.ts";
import { mountPluginUpdates } from "./host/plugin-updates.ts";
import type {} from "./shared/message-source.ts";
import { attachDesktopLogin } from "./host/desktop-login.ts";
import { createDesktopNavigation } from "./host/desktop-navigation.ts";
import { attachWebLogin } from "./host/web-login.ts";
/** GEA 外部 Fetch 能力和显式本地回执提供者的 DSH 插件入口。 */
import { appendFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import companyDefaults from "../desktop/company.config.json" with { type: "json" };
import type {} from "@deepseek-ai/dsh-app-boot";
import { createHash, randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@cleverc2200/dsh-agent-workbench";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { Business, object, type Deployment } from "./host/business.ts";
import { errorEnvelope } from "./host/error-envelope.ts";
import { lastUserQuestion } from "./host/turn-anchor.ts";
import { profileFor } from "./host/prompt-policy.ts";
import {
  assertBusinessResourceAvailable,
  assertSessionResourceAvailable,
  businessIdentityKey,
  sessionConsumer,
} from "./host/business-identity.ts";
import { mountBusinessPrompts } from "./host/prompt-runtime.ts";
import { mountSidebarToolVisibility } from "./host/sidebar-tool-visibility.ts";
import { registerHtmlPlugins } from "./html-plugins.ts";
import { registerGeaTools } from "./host/agent-tools.ts";
import { createGatewayMcpService } from "./host/gateway-mcp-service.ts";
import {
  sharedAgentCapability,
  WORKBENCH_AGENT_CODE,
  WORKBENCH_SOURCE_REF,
} from "./host/shared-agent.ts";
import { DEFAULT_MCP_RESPONSE_BYTES } from "./host/mcp-response.ts";
import { createCapabilityRegistry } from "./capability/registry.ts";
import { workbenchContract } from "./capability/contract.ts";
const WORKBENCH_SURFACE = "gea-workbench";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "dsh-agent-manage/business-resources";
import { fileURLToPath } from "node:url";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-agent-default-model";
export { pluginPackageVersion } from "./plugin-package-version.ts";

export const inject = [
  "profileContext",
  "workbenchPages",
  "agentResources",
  "userAgents",
  "agents",
  "connection",
  "tools",
  "skills",
  "llm",
  "sessionController",
  "sessionProjections",
  "agentDefaultModel",
  "agentPresets",
];
const environmentSchema = z.union(["production", "test"]);
export const Config = z.object({
  geaBaseUrl: z.string().default(companyDefaults.geaBaseUrl),
  serviceAccounts: z.any<ServiceAccounts>(),
  environment: environmentSchema.default(
    z.resolve(companyDefaults.environment, environmentSchema, {})[0],
  ),
  geaEnvironments: z.union([
    z.object({
      production: z.string().required(),
      test: z.string().required(),
    }),
  ]),
  pageSize: z.natural().min(1).max(100).default(companyDefaults.pageSize),
  periodPageSize: z.natural().min(1).max(1000).default(companyDefaults.periodPageSize),
  requestTimeoutMs: z.natural().min(1000).max(120000).default(companyDefaults.requestTimeoutMs),
  mcpRequestTimeoutMs: z.natural().min(1000).max(600000).default(300000),
  mcpMaxResponseBytes: z
    .natural()
    .min(1024)
    .max(1024 * 1024 * 1024)
    .default(DEFAULT_MCP_RESPONSE_BYTES),
  cubeMcpCodes: z
    .object({ production: z.string(), test: z.string() })
    .default(companyDefaults.cubeMcpCodes),
  modelRequestTimeoutMs: z.natural().min(1000).max(600000).default(300000),
  maxSnapshotBytes: z.natural().min(1000).max(5000000).default(companyDefaults.maxSnapshotBytes),
  runtimeDir: z.string(),
  // The feature validates this optional deployment input and stays blocked on incomplete configuration.
  pluginUpdates: z.any<unknown>(),
  analysisMode: z.union(["receipt", "model"]).default("model"),
  analysisModel: z.string().default(companyDefaults.analysis.model),
  analysisSource: z.union(["gea", "direct", "receipt"]).default("gea"),
  analysisAgentCode: z.string().default(companyDefaults.analysis.agentCode),
  inputByteBudget: z
    .natural()
    .min(1)
    .default(
      Math.min(
        companyDefaults.maxSnapshotBytes,
        companyDefaults.analysis.contextWindow - companyDefaults.analysis.maxTokens - 1000,
      ),
    ),
  /**
   * 问答侧是否允许调用受管只读 SQL（`/ai/gateway/sql/execute`）。
   * 默认关闭：问答取数只走模块 MCP + 页面证据，模型不再自己写 SQL。
   */
  agentSqlRead: z.boolean().default(false),
  workbenchCapability: z
    .object({
      enabled: z.boolean(),
      readonlyValidation: z.union([
        z.object({
          maxRequests: z.natural().required(),
          periods: z.natural().required(),
          list: z.natural().required(),
          detail: z.natural().required(),
          versionSkus: z.natural().required(),
          workflowSql: z.natural().required(),
          maxWorkflowRows: z.natural().min(1).required(),
          metadata: z.natural().required(),
        }),
      ]),
    })
    .default({}),
  sqlReadLimit: z.union([
    z.object({
      consumerCode: z.string().required(),
      maxRequests: z.natural().required(),
      maxPagesPerQuery: z.natural().min(1).required(),
      maxRowsPerQuery: z.natural().min(1).required(),
    }),
  ]),
});

/** 执行标准模型调用，但不发起外部推理请求。 */
class ReceiptAdapter extends LlmAdapter {
  constructor(
    private readonly config: Deployment,
    private readonly runId: string,
    private readonly business: Business,
  ) {
    super();
  }
  override providerInfo(id: string) {
    return { id, name: "GEA local receipt (no AI)" };
  }
  override async listModels(provider: string) {
    return [{ provider, id: "receipt", name: "Local receipt / 本地验证回执" }];
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.business.assertModelAllowed();
    options.signal?.throwIfAborted();
    const request = JSON.stringify(options.messages);
    const text =
      "本地验证回执（非 AI 分析）：业务资料已进入会话。\n\n这是数据传递验证，不构成审批意见。";
    await mkdir(this.config.runtimeDir, { recursive: true, mode: 0o700 });
    await appendFile(
      resolve(this.config.runtimeDir, "receipts.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        runId: this.runId,
        requestHash: createHash("sha256").update(request).digest("hex"),
        provider: options.provider,
        model: options.model,
      }) + "\n",
      { mode: 0o600 },
    );
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

/** 注册需要身份验证的 Web 路由；浏览器授权由标准 DSH connection 负责。 */
export async function apply(
  ctx: Context,
  input: Omit<Deployment, "runtimeDir"> & { runtimeDir?: string; pluginUpdates?: unknown },
): Promise<void> {
  const runtimeDir = input.runtimeDir ?? resolve(ctx.profileContext.dir, "gea");
  if (!isAbsolute(runtimeDir)) throw Error("INVALID_GEA_RUNTIME_DIR: absolute directory required");
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const config: Deployment = {
    ...input,
    runtimeDir,
    geaEnvironments:
      input.geaEnvironments ??
      (input.geaBaseUrl === companyDefaults.geaBaseUrl
        ? companyDefaults.geaEnvironments
        : undefined),
  };
  await loadServiceAccountCredentials(config.serviceAccounts);
  ctx.effect(() => mountPluginUpdates(ctx, input.pluginUpdates, config));
  const business = new Business(config);
  const desktopLogin = await attachDesktopLogin(business);
  const webLogin = await attachWebLogin(business);
  // 只装载 Workbench 已登记的 v2 HTML 包；缺少分离声明由装载校验拒绝。
  const htmlPackages = ctx.workbenchPages
    .packages()
    .filter((item) => item.manifest.gea?.contract === "gea-html-v2");
  const releaseOriginalResources = await ctx.agentResources.register([
    {
      id: WORKBENCH_SOURCE_REF,
      cube: true,
      label: sharedAgentCapability.label,
      root: fileURLToPath(new URL("../", import.meta.url)),
      profile: {
        label: sharedAgentCapability.label,
        consumerCode: WORKBENCH_AGENT_CODE,
        skills: [],
      },
    },
    {
      id: "gea-readonly",
      cube: true,
      enabled: config.workbenchCapability?.enabled !== false,
      label: profileFor("gea-readonly")!.label,
      presetName: profileFor("gea-readonly")!.presetName,
      description: profileFor("gea-readonly")!.description,
      root: fileURLToPath(new URL("../", import.meta.url)),
      prompt: "presets/prompt-policy.json",
      publishPreset: true,
      profileKey: "gea-readonly",
      profile: profileFor("gea-readonly")!,
    },
  ]);
  ctx.effect(() => releaseOriginalResources);
  const htmlPlugins = await registerHtmlPlugins(ctx, business, htmlPackages);
  // 能力契约注册表：页面白名单、草稿白名单、只读模块清单全部由它产出，宿主不再按模块写分支。
  const capability = createCapabilityRegistry([
    sharedAgentCapability,
    ...htmlPlugins.capabilityContracts,
    workbenchContract({
      ...config.workbenchCapability,
      surface: WORKBENCH_SURFACE,
      pageIds: [WORKBENCH_SURFACE],
      keywords: ["区域计划", "审批", "销售计划", "计划量"],
    }),
  ]);
  // 受管只读的模块白名单也来自契约：不再在业务代码里维护一份模块清单。
  business.setCapabilities(capability);
  // The official stream seam also covers retained direct-provider selections.
  ctx.effect(() =>
    ctx.on("llm/stream", async function* (options, next) {
      business.assertModelAllowed();
      const agent = options.sessionId ? ctx.agents.get(options.sessionId as SessionId) : undefined;
      const preset = agent
        ? ctx.sessionProjections.stateOf(agent.session, "agentPreset")
        : undefined;
      if (
        options.provider !== "gea-proof" &&
        (options.provider === "gea-analysis" || profileFor(preset ?? undefined))
      ) {
        await assertSessionResourceAvailable(ctx, options.sessionId, options.signal);
        business.assertExecutionAllowed(
          sessionConsumer(ctx, business, options.sessionId),
          "view",
          options.sessionId,
        );
      }
      yield* next();
    }),
  );
  ctx.effect(() =>
    ctx.workbenchPages.registerBusinessPage(
      {
        id: "gea-proof",
        kind: "native",
        label: "销售计划",
        resourceId: "gea-readonly",
        catalog: { surface: WORKBENCH_SURFACE, tool: "gea_workbench_apply" },
      },
      async (sessionId, resourceId, signal) => {
        business.assertExecutionAllowed(config.analysisAgentCode);
        if (!business.status().authenticated || !business.pageSessionScope())
          throw Error("PAGE_REFERENCE_LOGIN_REQUIRED");
        const referenceScope = businessIdentityKey(business);
        if (!referenceScope) throw Error("GEA_IDENTITY_INCOMPLETE");
        const agent = ctx.agents.get(sessionId as SessionId);
        if (!agent || ctx.sessionProjections.stateOf(agent.session, "agentPreset") !== resourceId)
          throw Error("PAGE_AGENT_SESSION_MISMATCH");
        signal.throwIfAborted();
        const surface = business.setSurface(sessionId, { menu: "gea-proof", title: "销售计划" });
        const identity = business.identitySignal();
        const pageIdentity = {
          pluginId: "gea-proof",
          consumerCode: config.analysisAgentCode,
          label: "销售计划",
          pageTool: "gea_workbench_apply",
        };
        business.touchPageIdentity(sessionId, pageIdentity);
        let projection = business.currentPageIdentity(sessionId);
        return {
          signal: identity,
          access: { authenticated: true },
          referenceScope,
          allowsEffect: (effect) => capability.allows(WORKBENCH_SURFACE, effect),
          snapshot: () => business.workbenchStateSnapshot(sessionId),
          observe: (context) => {
            identity.throwIfAborted();
            if (business.surfaceFor(sessionId) !== surface) throw Error("PAGE_OWNER_RELEASED");
            business.touchPageIdentity(sessionId, pageIdentity);
            projection = business.currentPageIdentity(sessionId);
            business.updateVisibleWorkbenchContext(sessionId, context);
          },
          release: () => {
            if (business.currentPageIdentity(sessionId) === projection)
              business.clearPageIdentity(sessionId, pageIdentity.pluginId);
            if (business.surfaceFor(sessionId) !== surface) return;
            business.clearVisibleWorkbenchContext(sessionId);
            business.clearSurface(sessionId, surface.menu);
          },
        };
      },
    ),
  );
  // Sidebar 工具遵循其公开 Document 条件；业务 profile 不再整体屏蔽官方通用能力。
  ctx.effect(() => mountSidebarToolVisibility(ctx, business));
  const desktopNavigation = createDesktopNavigation(business);
  ctx.effect(() => () => desktopNavigation.dispose());
  ctx.provide("geaMcp", createGatewayMcpService(ctx, business));
  registerGeaTools(ctx, business, capability, htmlPackages);
  ctx.effect(() => mountBusinessPrompts(ctx, business, capability));
  const resetReadTurn = (scope: string) => {
    business.clearTurnReplays(scope);
    business.clearTurnStops(scope);
  };
  // native pre-step.messages 是本步新领取的消息，不是全历史。领取新问题时（提示组装前）清理，
  // 不能只按消息数组里的用户条数判断换轮；同一句重问也有新的领取事件。
  ctx.effect(() =>
    ctx.on("agent/inbox/claimed", ({ agent, message }) => {
      if (message.source.kind !== "user") return;
      const question = lastUserQuestion([message]);
      if (question) resetReadTurn(agent.id);
    }),
  );
  ctx.effect(() => async () => {
    await desktopLogin.dispose();
    await webLogin.dispose();
    business.dispose();
  });
  if (config.analysisMode === "receipt")
    ctx.effect(() =>
      ctx.llm.registerAdapter(["gea-proof"], new ReceiptAdapter(config, business.runId, business)),
    );
  if (config.analysisMode === "model" && config.analysisSource === "gea")
    ctx.effect(() => {
      const registration = ctx.llm.registerAdapter(
        ["gea-analysis"],
        new GeaModelAdapter(business, htmlPlugins.modelAccessForSession),
      );
      let identity = business.identitySignal();
      let authenticated = business.status().authenticated;
      if (!authenticated) registration.replace([]);
      // 官方模型菜单通过路由变更刷新目录。只观察 Host 身份代际和有效性，
      // 头像等展示变化不能重新发现模型，也不改 Session 的模型选择。
      const unwatch = business.watchIdentity(() => {
        const nextIdentity = business.identitySignal();
        const nextAuthenticated = business.status().authenticated;
        if (identity === nextIdentity && authenticated === nextAuthenticated) return;
        registration.replace(nextAuthenticated ? ["gea-analysis"] : []);
        identity = nextIdentity;
        authenticated = nextAuthenticated;
      });
      return () => {
        unwatch();
        registration();
      };
    });
  let submission:
    | {
        id: string;
        sessionId: SessionId;
        result?: Promise<{ sessionId: SessionId }>;
      }
    | undefined;
  function submit(payload: Record<string, unknown>, requestSignal: AbortSignal) {
    business.assertExecutionAllowed(config.analysisAgentCode);
    if (Object.keys(payload).some((key) => key !== "previewId" && key !== "workbenchContext"))
      throw new Error("INVALID_PAYLOAD");
    const preview = business.prepared(payload.previewId);
    const workbenchContext =
      payload.workbenchContext === undefined ? undefined : object(payload.workbenchContext);
    requestSignal.throwIfAborted();
    if (submission?.id !== preview.previewId)
      submission = {
        id: preview.previewId,
        sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      };
    const attempt = submission;
    if (workbenchContext)
      business.updateVisibleWorkbenchContext(attempt.sessionId, workbenchContext);
    if (attempt.result) return attempt.result;
    const signal = business.admissionSignal(requestSignal);
    attempt.result = (async () => {
      signal.throwIfAborted();
      let selectedModel = config.analysisModel;
      if (config.analysisMode === "model" && config.analysisSource === "gea") {
        const route = await business.modelRoute(signal, config.analysisAgentCode);
        selectedModel = route.models.includes(config.analysisModel)
          ? config.analysisModel
          : route.models[0]!;
      }
      const cwd = resolve(config.runtimeDir, "workspace");
      const resource = await ctx.agentResources.select("gea-readonly", signal, cwd);
      signal.throwIfAborted();
      const session = await ctx.sessionController.create({
        sessionId: attempt.sessionId,
        cwd,
        agentPreset: resource.preset,
      });
      signal.throwIfAborted();
      business.prepared(preview.previewId);
      // selectModel 同样是整体覆盖，不带上档位会把它清掉。
      const keptEffort =
        config.analysisMode === "model" && config.analysisSource === "gea"
          ? geaKeptReasoningEffort(ctx.agentDefaultModel.currentSelection())
          : undefined;
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider: config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
        model: selectedModel,
        ...(keptEffort === undefined ? {} : { reasoningEffort: keptEffort }),
      });
      signal.throwIfAborted();
      business.prepared(preview.previewId);
      await business.archivePreview(session.sessionId, preview);
      signal.throwIfAborted();
      business.prepared(preview.previewId);
      const agent = ctx.agents.get(session.sessionId);
      if (!agent) throw new Error("SESSION_NOT_FOUND");
      agent.followup(
        createUserMessage({
          source: {
            kind: "gea-proof",
            form: "notice",
            summary:
              config.analysisMode === "receipt"
                ? "已提交只读快照，正在验证数据传递"
                : "已提交只读分析：对比所选计划的数量和金额差异",
          },
          content: [{ type: "text", text: preview.prompt }],
        }),
      );
      return session;
    })().catch((error: unknown) => {
      // admission 可能已在失败前成功，因此保留已生成的身份标识。
      attempt.result = undefined;
      throw error;
    });
    return attempt.result;
  }
  const endpoints = [
    "navigation/catalog",
    "navigation/poll",
    "navigation/finish",
    "navigation/retry",
    "status",
    "notifications",
    "workflow/config",
    // 界面刷新时重新解析账号角色（管理员刚改完权限不必重新登录）。
    "approval/roles",
    "sales-plan/action",
    "sales-plan/draft",
    "sales-plan/submit",
    "environment/select",
    "model/discover",
    "model/advice",
    "logout",
    "login/start",
    "login/poll",
    "periods",
    "plans",
    "detail",
    "versions",
    "skus",
    "prepare",
    "submit",
    "workbench/query",
    "plugin/sql",
    "workbench/prepare",
    // 前端上报"这个对话现在停在哪一页菜单"（默认主对话，点菜单时带菜单名）。
    "api-log/snapshot",
    "api-log/replay",
    "api-log/clear",
    "api-log/batch/start",
    "api-log/batch/read",
    "api-log/batch/stop",
    // 只在显式打开调试开关时注册：逐个模块真跑一遍 MCP，并把原始报文带回来。
    ...(process.env.GEA_DEBUG_PROBE === "1" ? ["debug/mcp-probe"] : []),
  ];
  for (const endpoint of endpoints)
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: "/api/gea-proof/" + endpoint,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request: Request) => {
          try {
            business.assertOperation(endpoint);
            const payload = object(await request.json());
            let value: unknown;
            switch (endpoint) {
              case "navigation/catalog":
                value = await business.navigationCatalog(payload, request.signal);
                break;
              case "navigation/poll":
              case "navigation/retry":
                if (Object.keys(payload).length) throw Error("NAVIGATION_REQUEST_INVALID");
                value =
                  endpoint === "navigation/poll"
                    ? await desktopNavigation.poll()
                    : await desktopNavigation.retry();
                break;
              case "navigation/finish":
                value = await desktopNavigation.finish(payload);
                break;
              case "api-log/snapshot":
                value = business.apiLogSnapshot(payload);
                break;
              case "api-log/replay":
                value = await business.apiLogReplay(payload, request.signal);
                break;
              case "api-log/clear":
                value = business.apiLogClear(payload);
                break;
              case "api-log/batch/start":
                value = business.apiLogBatchStart(payload, request.signal);
                break;
              case "api-log/batch/read":
                value = business.apiLogBatchRead(payload);
                break;
              case "api-log/batch/stop":
                value = business.apiLogBatchStop(payload);
                break;
              case "debug/mcp-probe":
                value = await business.debugProbeModuleMcp(
                  String(payload.consumerCode ?? ""),
                  request.signal,
                );
                break;
              case "workbench/query":
                value = await business.workbenchQuery(payload, request.signal);
                break;
              case "plugin/sql":
                value = await business.pluginSql(payload, request.signal);
                break;
              case "workbench/prepare":
                value = await business.prepareWorkbench(payload, request.signal);
                break;
              case "sales-plan/submit":
                value = await business.salesPlanSubmit(payload, request.signal);
                break;
              case "sales-plan/draft":
                value = await business.salesPlanDraft(payload, request.signal);
                break;
              case "sales-plan/action":
                value = await business.salesPlanAction(payload, request.signal);
                break;
              case "workflow/config":
                value = await business.workflowConfig(payload, request.signal);
                break;
              // 界面上的「刷新」会走这里：重新解析当前账号角色，管理员刚改完权限的人也
              // 不用重新登录就能看到新的可审批节点。
              case "approval/roles":
                business.assertExecutionAllowed(config.analysisAgentCode);
                await business.refreshApprovalRoles(request.signal, { force: true });
                value = { roles: business.status().roles ?? [] };
                break;
              case "notifications":
                value = await business.notifications(payload, request.signal);
                break;
              case "status":
                if (!business.status().readonlyValidation) {
                  await Promise.all([
                    business.refreshMissingAvatar(request.signal),
                    business.refreshPermissions(request.signal),
                    business.refreshApprovalRoles(request.signal),
                  ]);
                }
                // 前端不写死"哪个页面属于哪个模块"：模块索引由能力契约产出。
                value = {
                  ...business.status(),
                  htmlPlugins: htmlPackages.length > 0,
                  modules: capability.modules(),
                };
                break;
              case "model/advice": {
                business.assertExecutionAllowed(config.analysisAgentCode);
                if (!business.status().authenticated) throw new Error("LOGIN_REQUIRED");
                if (config.analysisMode !== "model") throw new Error("GEA_ADVICE_MODEL_REQUIRED");
                if (
                  typeof payload.question !== "string" ||
                  !payload.question.trim() ||
                  Buffer.byteLength(payload.question) > config.inputByteBudget
                )
                  throw new Error("INVALID_ADVICE_INPUT");
                const signal = AbortSignal.any([request.signal, business.identitySignal()]);
                let model = config.analysisModel;
                if (config.analysisSource === "gea") {
                  const route = await business.modelRoute(signal, config.analysisAgentCode);
                  model = route.models.includes(model) ? model : route.models[0]!;
                }
                let answer = "";
                let finished = false;
                for await (const chunk of ctx.llm.stream({
                  provider: "gea-analysis",
                  model,
                  messages: [
                    createUserMessage({
                      source: { kind: "user" },
                      content: [{ type: "text", text: payload.question }],
                    }),
                  ],
                  maxTokens: 4096,
                  signal,
                })) {
                  signal.throwIfAborted();
                  if (chunk.type === "text-delta") answer += chunk.text;
                  if (Buffer.byteLength(answer) > config.maxSnapshotBytes)
                    throw new Error("GEA_ADVICE_TOO_LARGE");
                  if (chunk.type === "finish") finished = chunk.reason.kind === "stop";
                }
                signal.throwIfAborted();
                if (!finished) throw new Error("GEA_ADVICE_INCOMPLETE");
                value = {
                  status: answer.trim() ? "ok" : "noAnswer",
                  provider_id: "gea-analysis",
                  model,
                  answer,
                };
                break;
              }
              case "model/discover": {
                if (!business.status().authenticated) throw new Error("LOGIN_REQUIRED");
                const requestedPreset = payload.agentPreset;
                if (
                  requestedPreset !== undefined &&
                  (typeof requestedPreset !== "string" || !profileFor(requestedPreset))
                )
                  throw Error("GEA_AGENT_PRESET_UNSUPPORTED");
                await assertBusinessResourceAvailable(
                  ctx,
                  typeof requestedPreset === "string" ? requestedPreset : undefined,
                  request.signal,
                );
                const discoveryConsumer =
                  typeof requestedPreset === "string" && requestedPreset !== "gea-readonly"
                    ? profileFor(requestedPreset)!.consumerCode
                    : config.analysisAgentCode;
                const route =
                  config.analysisSource === "direct"
                    ? {
                        models: [config.analysisModel],
                        names: { [config.analysisModel]: config.analysisModel },
                      }
                    : await business.modelRoute(request.signal, discoveryConsumer);
                const selected = route.models.includes(config.analysisModel)
                  ? config.analysisModel
                  : route.models[0]!;
                request.signal.throwIfAborted();
                // saveSelection 是整体覆盖：不带上已选档位就会把用户的档位选择清掉。
                const kept = geaKeptReasoningEffort(ctx.agentDefaultModel.currentSelection());
                if (requestedPreset === undefined)
                  await ctx.agentDefaultModel.saveSelection({
                    provider: "gea-analysis",
                    model: selected,
                    ...(kept === undefined ? {} : { reasoningEffort: kept }),
                  });
                value = {
                  ...(requestedPreset === undefined ? {} : { consumerCode: discoveryConsumer }),
                  models: route.models,
                  selected,
                  names: route.names,
                  selectedName: route.names[selected],
                };
                break;
              }
              case "environment/select":
                value = business.selectEnvironment(payload);
                break;
              case "logout":
                value = business.logout(payload);
                break;
              case "login/start":
                value = await business.loginStart(request.signal, payload);
                break;
              case "login/poll":
                value = await business.loginPoll(payload, request.signal);
                break;
              case "plans":
                value = await business.plans(payload, request.signal);
                break;
              case "periods":
                value = await business.periods(request.signal);
                break;
              case "detail":
                value = await business.detail(payload, request.signal);
                break;
              case "versions":
                value = await business.versions(payload, request.signal);
                break;
              case "skus":
                value = await business.skus(payload, request.signal);
                break;
              case "prepare":
                value = business.prepare(payload);
                break;
              case "submit":
                value = await submit(payload, request.signal);
                break;
              default:
                throw new Error("UNKNOWN_ENDPOINT");
            }
            await desktopLogin.flush();
            await webLogin.flush();
            return Response.json({ ok: true, value }, { headers: { "Cache-Control": "no-store" } });
          } catch (caughtError) {
            let error = caughtError;
            // 业务操作失败时也可能同时发现登录过期并清除身份。
            try {
              await desktopLogin.flush();
              await webLogin.flush();
            } catch (storageError) {
              error = storageError;
            }
            return Response.json(
              { ok: false, error: errorEnvelope(error) },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        },
      }),
    );
}

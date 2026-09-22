import { attachDesktopLogin } from "./host/desktop-login.ts";
import { attachWebLogin } from "./host/web-login.ts";
import { resolveWorkbench } from "../scripts/deployment.mjs";
/** GEA 外部 Fetch 能力和显式本地回执提供者的 DSH 插件入口。 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import {
  LlmAdapter,
  ReasoningEffortId,
  createUserMessage,
  type GenerateOptions,
  type LlmReasoningEffortInfo,
  type StreamChunk,
  attributionHeaders,
  type ContentBlock,
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { Business, object, type Deployment } from "./host/business.ts";
import { GeaResponseError } from "./shared/gea-error.js";
import { registerHtmlPlugins } from "./html-plugins.ts";
import { registerGeaTools } from "./host/agent-tools.ts";
import {
  createPageBridge,
  createPageToolRegistry,
} from "./page-bridge/index.ts";
import { transportSignal } from "./shared/transport-signal.ts";
import { geaTextStream } from "./shared/gea-stream.ts";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-agent-default-model";

export const inject = [
  "agents",
  "connection",
  "tools",
  "llm",
  "sessionController",
  "agentDefaultModel",
];
export const Config = z.object({
  geaBaseUrl: z.string().required(),
  pageSize: z.natural().min(1).max(100).required(),
  periodPageSize: z.natural().min(1).max(1000).required(),
  requestTimeoutMs: z.natural().min(1000).max(120000).required(),
  mcpRequestTimeoutMs: z.natural().min(1000).max(120000).default(60000),
  modelRequestTimeoutMs: z.natural().min(1000).max(600000).default(120000),
  maxSnapshotBytes: z.natural().min(1000).max(5000000).required(),
  runtimeDir: z.string().required(),
  analysisMode: z.union(["receipt", "model"]).required(),
  analysisModel: z.string().required(),
  inputByteBudget: z.natural().min(1).required(),
});

/** 执行标准模型调用，但不发起外部推理请求。 */
class ReceiptAdapter extends LlmAdapter {
  constructor(
    private readonly config: Deployment,
    private readonly runId: string,
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

/**
 * 可选推理档位。GEA 个人模型网关把 `extra_params` 的顶层键覆盖到模型配置的默认
 * extraParams，再由上游 provider 解析 `reasoning_effort`；平台本身不定义档位名，
 * 所以档位由客户端给出。上游只认接入手册里给过的那两个取值（`high` / `max`），
 * 因此这里只暴露这两档，默认 `high`；`off` 是 DSH 内部的 thinking 开关，不在
 * wire 协议里，不能透传。
 */
const GEA_REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  {
    id: ReasoningEffortId("high"),
    name: "高",
    description: "默认档，适合大多数业务问题。",
  },
  {
    id: ReasoningEffortId("max"),
    name: "最高",
    description: "复核、对比与难取数任务，耗时更长。",
  },
];

/** 用户未选档位时materialize的默认档位。 */
const GEA_DEFAULT_REASONING_EFFORT = ReasoningEffortId("high");

/** 网关只接受非空字符串，且单次覆盖的键值有长度上限；不合法就保持改造前行为。 */
const GEA_EFFORT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 把所选档位映射成网关契约里的 `extra_params`。取值不合法时返回 undefined，
 * 请求体不带该字段，服务端保持模型配置默认参数。未显式选择时，DSH 会先按模型声明的
 * `defaultEffort` 补上默认档位再调用，所以正常路径下这里总能拿到一个档位。
 */
function geaExtraParams(
  options: GenerateOptions,
): Record<string, string> | undefined {
  const effort = options.reasoningEffort;
  if (effort === undefined) return undefined;
  const value = String(effort);
  if (!GEA_EFFORT_PATTERN.test(value)) return undefined;
  return { reasoning_effort: value };
}

/**
 * `selectModel` 与 `saveSelection` 都是整体覆盖：不显式带上已选档位就会把它清掉。
 * 档位只存在默认选择里，这里读回来并在仍是本适配器声明的档位时沿用。
 */
function geaKeptReasoningEffort(current: {
  provider?: string;
  reasoningEffort?: ReasoningEffortId;
}): ReasoningEffortId | undefined {
  const effort = current.reasoningEffort;
  if (current.provider !== "gea-analysis" || effort === undefined)
    return undefined;
  return GEA_REASONING_EFFORTS.some((item) => String(item.id) === String(effort))
    ? effort
    : undefined;
}

/** 直接调用当前登录用户的 GEA 个人模型路由，不经过 AionUi 代理。 */
class GeaModelAdapter extends LlmAdapter {
  constructor(private readonly business: Business, private readonly htmlConsumer: (session?: string) => string | undefined = () => undefined) {
    super();
  }
  override providerInfo(id: string) {
    return { id, name: "GEA personal model" };
  }
  async listModels(provider: string) {
    const route = await this.business.modelRoute(
      new AbortController().signal,
      this.business.config.analysisAgentCode,
    );
    return route.models.map((id) => ({ provider, id, name: route.names[id] }));
  }
  async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const route = await this.business.modelRoute(
      signal ?? new AbortController().signal,
      this.business.config.analysisAgentCode,
    );
    return {
      provider,
      id: model,
      name: route.names[model] ?? "GEA 模型（名称未提供）",
      // 声明默认档位：用户没显式选档位时，DSH 会补上它并按 extra_params 发给网关。
      reasoning: {
        efforts: GEA_REASONING_EFFORTS,
        defaultEffort: GEA_DEFAULT_REASONING_EFFORT,
      },
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const transport = transportSignal(
      AbortSignal.any([
        options.signal ?? new AbortController().signal,
        this.business.identitySignal(),
        AbortSignal.timeout(this.business.config.modelRequestTimeoutMs),
      ]),
    );
    const signal = transport.signal;
    try {
      const route = await this.business.modelRoute(
        signal,
        this.htmlConsumer(options.sessionId) ?? this.business.config.analysisAgentCode,
      );
      if (!route.models.includes(options.model))
        throw new Error("GEA_MODEL_NOT_FOUND");
      const requestBody = toGeaRequest(options);
      const response = await this.business.fetchExternal(route.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...attributionHeaders(),
          Authorization: "Bearer " + route.secret,
          "X-GEA-Agent-Code": route.agentCode,
        },
        body: JSON.stringify(requestBody),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        if (response.status === 401) this.business.expireModelLogin();
        throw new Error("GEA_MODEL_HTTP_" + response.status);
      }
      if (!response.body) throw new Error("GEA_MODEL_HTTP_NO_BODY");
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("text/event-stream")
      )
        throw new Error("GEA_MODEL_NOT_SSE");
      yield* geaTextStream(response.body, signal, {
        names: options.tools?.map((tool) => tool.name) ?? [],
        maxBytes: this.business.config.maxSnapshotBytes,
      });
    } finally {
      transport.dispose();
    }
  }
}

type GeaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function textContent(content: ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function toGeaMessages(options: GenerateOptions): GeaMessage[] {
  const messages: GeaMessage[] = [];
  if (options.system !== undefined)
    messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    if (message.role === "system") {
      const content = textContent(message.content);
      if (content) messages.push({ role: "system", content });
      continue;
    }
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool-result" }> =>
        block.type === "tool-result",
    );
    if (toolResults.length > 0) {
      for (const result of toolResults)
        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: textContent(result.content) || "(no output)",
        });
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.content
        .filter(
          (block): block is Extract<ContentBlock, { type: "tool-call" }> =>
            block.type === "tool-call",
        )
        .map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));
      messages.push({
        role: "assistant",
        content: textContent(message.content) || undefined,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    messages.push({ role: "user", content: textContent(message.content) });
  }
  return messages;
}

function toGeaRequest(options: GenerateOptions) {
  const extraParams = geaExtraParams(options);
  return {
    model: options.model,
    messages: toGeaMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    ...(extraParams === undefined ? {} : { extra_params: extraParams }),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: tool,
          })),
        }
      : {}),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  };
}

/** 注册需要身份验证的 Web 路由；浏览器授权由标准 DSH connection 负责。 */
export async function apply(ctx: Context, config: Deployment): Promise<void> {
  resolveWorkbench(import.meta.url);
  const htmlPluginRoots: Record<string, string> = (() => {
    try { const value = JSON.parse(process.env.GEA_HTML_PLUGIN_ROOTS ?? "{}"); return value && typeof value === "object" ? value : {}; }
    catch { return {}; }
  })();
  for (const [id, root] of Object.entries(htmlPluginRoots)) {
    if (!/^[a-z0-9-]+$/.test(id) || typeof root !== "string") continue;
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/gea-html-plugin/${id}`, methods: ["GET"], requestBody: "buffered",
      fetch: async () => new Response(new Uint8Array(await readFile(resolve(root, "index.html"))), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'self'" },
      }),
    }));
  }
  const workbenchHtml =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GEA</title><link rel="stylesheet" href="/api/gea-proof/workbench.css"><style>html,body,#gea-workbench{height:100%;margin:0}</style></head><body><div id="gea-workbench"></div><script type="module" src="/api/gea-proof/workbench.js"></script></body></html>';
  for (const [path, type, content] of [
    [
      "workbench",
      "text/html; charset=utf-8",
      () => Promise.resolve(workbenchHtml),
    ],
    [
      "workbench.css",
      "text/css; charset=utf-8",
      () => readFile(new URL("./workbench.css", import.meta.url), "utf8"),
    ],
    [
      "workbench.js",
      "text/javascript; charset=utf-8",
      () => readFile(new URL("./workbench.js", import.meta.url), "utf8"),
    ],
  ] as const)
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: "/api/gea-proof/" + path,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async () =>
          new Response(await content(), {
            headers: {
              "Content-Type": type,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "frame-ancestors 'self'",
            },
          }),
      }),
    );
  const pageBridge = createPageBridge();
  const business = new Business(config, pageBridge);
  // 页面自述能力 -> 该会话专属的模型工具（页面关闭即注销）。
  const pageTools = createPageToolRegistry(ctx, pageBridge, {
    stateSnapshot: (sessionId) => business.workbenchStateSnapshot(sessionId),
    // 只允许"业务工作台页面"被对话改动；其它页面声明一律不接。
    allowSurfaces: ["gea-workbench"],
    // 只有业务工作台可以暴露"改草稿"的动作（例如确认计划量）。
    dataActionSurfaces: ["gea-workbench"],
    // 工作台会话里不让它用浏览器/MCP 去扒页面数据（普通对话不受影响）。
    denyGlobalToolsInWorkbench: [
      "mcp__browser__browser_find",
      "mcp__browser__browser_evaluate",
      "mcp__browser__browser_navigate",
      "mcp__browser__browser_snapshot",
    ],
  });
  // 身份变化后旧会话的页面工具一律注销；页面下一轮声明会重新注册。
  ctx.effect(() => business.watchIdentity(() => pageTools.disposeAll()));
  const desktopLogin = await attachDesktopLogin(business);
  const webLogin = await attachWebLogin(business);
  const htmlRootConfig=JSON.parse(process.env.GEA_HTML_PLUGIN_ROOTS || "[]");
  const htmlRoots=Array.isArray(htmlRootConfig) ? htmlRootConfig : (htmlRootConfig && typeof htmlRootConfig === "object" ? Object.values(htmlRootConfig) : []);
  if(htmlRoots.some(root=>typeof root!=="string"))throw Error("INVALID_HTML_PLUGIN_ROOTS");
  const htmlPlugins=await registerHtmlPlugins(ctx,business,htmlRoots);
  ctx.provide("geaMcp", {
    version: 1 as const,
    defaultConsumer: { consumerType: "AGENT" as const, consumerCode: config.analysisAgentCode },
    authenticated: () => business.status().authenticated,
    watch: (listener: () => void) => business.watchIdentity(listener),
    open: (consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string }, signal: AbortSignal) => business.openMcpConnection(consumer, signal),
  });
  registerGeaTools(ctx, business);
  // 登记 37：客户端所有 agent（含默认预设）都要能取到工作台之外的数据。
  // 网关 MCP 的工具描述由 GEA 侧给出，模型容易猜错调用形状（实测报
  // "queries.query 必须是 Cube 查询对象"、"成员未唯一匹配数据目录资源"、"Resource URI 不合法"），
  // 这里在系统提示里补一份最小取数协议，全局生效、不依赖某个预设。
  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: "gea:gateway-mcp-protocol",
      order: 120,
      text: [
        "GEA 网关 MCP 取数协议（只有工作台页面上看不到的数据才用它）：",
        "- 计划事实（提报状态、版本、明细、变更记录）优先用 gea_sales_plan_read；历史发货、经销商/分仓库存、货龄、补货周期、政策、节令、把握度，以及知识库类问题，用当前已加载的 GEA 网关 MCP 工具。",
        "- 先取语义模型目录再查询：调用 gea_gateway_catalog（需要看某个模型时带 model=模型名），拿到模型名与成员名；成员名照抄，不要凭业务名猜。目录里的成员名形如 模型.字段，就是查询时要用的成员。",
        '- 不要自己去读 inspect 的原始产物：它约 33 万字符，宿主只会内联前 30KB，剩下的存成本机文件，你没有读文件的工具。目录工具已经把它压到可一次读完的大小。',
        '- 再查询：action="query"，queries 放 1 到 8 个具名 Cube 查询对象，每项形如 {"name":"<别名>","query":{…}}，其中 query 必须是 Cube 查询对象（不能写成字符串或自然语言）；response_mode 默认 "resource"，只有需要直接看行时才用 "inline_complete"。',
        "- 一次只查一个模型：同一次调用的成员必须属于同一个 dataAssetCode，跨模型要分开调用；报“成员未唯一匹配数据目录资源”就是这条没满足。",
        '- 结果返回资源链接时，用 dsh_read_resource 原样传入服务给出的完整 URI（形如 data-artifact://gateway/…）：不要自己拼 URI，也不要把它当 HTTP 链接去抓。',
        "- 报错先按错误文本改参数再试一次；同一错误不要连续重试，更不要改用编造的数据或改写用户的问题。",
      ].join("\n"),
    });
  });
  ctx.effect(() => async () => { await desktopLogin.dispose(); await webLogin.dispose(); business.dispose(); });
  if (config.analysisMode === "receipt")
    ctx.effect(() =>
      ctx.llm.registerAdapter(
        ["gea-proof"],
        new ReceiptAdapter(config, business.runId),
      ),
    );
  if (config.analysisMode === "model" && config.analysisSource === "gea")
    ctx.effect(() =>
      ctx.llm.registerAdapter(["gea-analysis"], new GeaModelAdapter(business, htmlPlugins.consumerForSession)),
    );
  let submission:
    | {
        id: string;
        sessionId: SessionId;
        result?: Promise<{ sessionId: SessionId }>;
      }
    | undefined;
  function submit(payload: Record<string, unknown>, requestSignal: AbortSignal) {
    if (
      Object.keys(payload).some(
        (key) => key !== "previewId" && key !== "workbenchContext",
      )
    )
      throw new Error("INVALID_PAYLOAD");
    const preview = business.prepared(payload.previewId);
    const workbenchContext =
      payload.workbenchContext === undefined
        ? undefined
        : object(payload.workbenchContext);
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
        const route = await business.modelRoute(
          signal,
          config.analysisAgentCode,
        );
        selectedModel = route.models.includes(config.analysisModel)
          ? config.analysisModel
          : route.models[0]!;
      }
      const session = await ctx.sessionController.create({
        sessionId: attempt.sessionId,
        cwd: resolve(config.runtimeDir, "workspace"),
        agentPreset: "gea-readonly",
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
        provider:
          config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
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
            kind: "plugin",
            plugin: "gea-proof",
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
    "status",
    "notifications",
    "workflow/config",
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
    "workbench/context",
    "agui/workbench",
    "api-log/snapshot",
    "api-log/replay",
    "api-log/clear",
  ];
  for (const endpoint of endpoints)
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: "/api/gea-proof/" + endpoint,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request: Request) => {
          try {
            const payload = object(await request.json());
            let value: unknown;
            switch (endpoint) {
              case "api-log/snapshot":
                value = business.apiLogSnapshot(payload);
                break;
              case "api-log/replay":
                value = await business.apiLogReplay(payload, request.signal);
                break;
              case "api-log/clear":
                value = business.apiLogClear(payload);
                break;
              case "workbench/query":
                value = await business.workbenchQuery(payload, request.signal);
                break;
              case "plugin/sql":
                value = await business.pluginSql(payload, request.signal);
                break;
              case "workbench/prepare":
                value = await business.prepareWorkbench(
                  payload,
                  request.signal,
                );
                break;
              case "agui/workbench": {
                if (
                  Object.keys(payload).some(
                    (key) =>
                      key !== "sessionId" &&
                      key !== "toolMessages" &&
                      key !== "catalog",
                  )
                )
                  throw new Error("INVALID_AGUI_REQUEST");
                if (typeof payload.sessionId !== "string")
                  throw new Error("INVALID_WORKBENCH_SESSION");
                try {
                  pageTools.declare(payload.sessionId, payload.catalog);
                } catch (error) {
                  // 页面声明无效（例如说明超长）会让工具注册不上，页面侧又是静默重试，
                  // 必须留一条日志，避免"功能突然不可用但没有任何线索"。
                  console.log(
                    `[page-bridge] declare rejected session=${payload.sessionId} code=${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
                value = business.pullPageBridgeEvents(
                  payload.sessionId,
                  payload.toolMessages,
                );
                break;
              }
              case "workbench/context": {
                if (
                  Object.keys(payload).some(
                    (key) => key !== "sessionId" && key !== "context",
                  )
                )
                  throw new Error("INVALID_WORKBENCH_CONTEXT");
                if (typeof payload.sessionId !== "string")
                  throw new Error("INVALID_WORKBENCH_SESSION");
                const sessionId = payload.sessionId;
                if (payload.context === null) {
                  business.clearVisibleWorkbenchContext(sessionId);
                  value = { synced: false };
                } else {
                  business.updateVisibleWorkbenchContext(sessionId, object(payload.context));
                  value = { synced: true };
                }
                break;
              }
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
              case "notifications":
                value = await business.notifications(payload, request.signal);
                break;
              case "status":
                await Promise.all([business.refreshMissingAvatar(request.signal), business.refreshPermissions(request.signal)]);
                value = {...business.status(),htmlPlugins:htmlRoots.length>0};
                break;
              case "model/advice": {
                if (!business.status().authenticated) throw new Error("LOGIN_REQUIRED");
                if (config.analysisMode !== "model") throw new Error("GEA_ADVICE_MODEL_REQUIRED");
                if (typeof payload.question !== "string" || !payload.question.trim() || Buffer.byteLength(payload.question) > config.inputByteBudget)
                  throw new Error("INVALID_ADVICE_INPUT");
                const signal = AbortSignal.any([request.signal, business.identitySignal(), AbortSignal.timeout(config.modelRequestTimeoutMs)]);
                let model = config.analysisModel;
                if (config.analysisSource === "gea") {
                  const route = await business.modelRoute(signal, config.analysisAgentCode);
                  model = route.models.includes(model) ? model : route.models[0]!;
                }
                let answer = "";
                let finished = false;
                for await (const chunk of ctx.llm.stream({ provider: "gea-analysis", model,
                  messages: [createUserMessage({ source: {kind: "user"}, content: [{ type: "text", text: payload.question }] })],
                  maxTokens: 4096, signal })) {
                  signal.throwIfAborted();
                  if (chunk.type === "text-delta") answer += chunk.text;
                  if (Buffer.byteLength(answer) > config.maxSnapshotBytes) throw new Error("GEA_ADVICE_TOO_LARGE");
                  if (chunk.type === "finish") finished = chunk.reason.kind === "stop";
                }
                signal.throwIfAborted();
                if (!finished) throw new Error("GEA_ADVICE_INCOMPLETE");
                value = {status: answer.trim() ? "ok" : "noAnswer", provider_id: "gea-analysis", model, answer};
                break;
              }
              case "model/discover": {
                if (!business.status().authenticated) throw new Error('LOGIN_REQUIRED');
                const route = config.analysisSource === 'direct' ? {models:[config.analysisModel],names:{[config.analysisModel]:config.analysisModel}} : await business.modelRoute(
                  request.signal,
                  config.analysisAgentCode,
                );
                const selected = route.models.includes(config.analysisModel)
                  ? config.analysisModel
                  : route.models[0]!;
                request.signal.throwIfAborted();
                // saveSelection 是整体覆盖：不带上已选档位就会把用户的档位选择清掉。
                const kept = geaKeptReasoningEffort(
                  ctx.agentDefaultModel.currentSelection(),
                );
                await ctx.agentDefaultModel.saveSelection({
                  provider: "gea-analysis",
                  model: selected,
                  ...(kept === undefined ? {} : { reasoningEffort: kept }),
                });
                value = {
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
            await desktopLogin.flush(); await webLogin.flush();
            return Response.json(
              { ok: true, value },
              { headers: { "Cache-Control": "no-store" } },
            );
          } catch (error) {
            // 业务操作失败时也可能同时发现登录过期并清除身份。
            try { await desktopLogin.flush(); await webLogin.flush(); } catch (storageError) { error = storageError; }
            const code =
              error instanceof Error && /^[A-Z][A-Z_0-9]+$/.test(error.message)
                ? error.message
                : "GEA_REQUEST_FAILED";
            return Response.json(
              {
                ok: false,
                error:
                  error instanceof GeaResponseError
                    ? {
                        code: error.code,
                        message: error.message,
                        details: error.details,
                      }
                    : { code, message: code },
              },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        },
      }),
    );
}

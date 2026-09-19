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
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  attributionHeaders,
  type ContentBlock,
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { Business, object, type Deployment } from "./host/business.ts";
import { GeaResponseError } from "./shared/gea-error.js";
import { registerHtmlPlugins } from "./html-plugins.ts";
import { registerGeaTools } from "./host/agent-tools.ts";
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
      const response = await this.business.fetchExternal(route.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...attributionHeaders(),
          Authorization: "Bearer " + route.secret,
          "X-GEA-Agent-Code": route.agentCode,
        },
        body: JSON.stringify(toGeaRequest(options)),
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
  return {
    model: options.model,
    messages: toGeaMessages(options),
    stream: true,
    stream_options: { include_usage: true },
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
  const business = new Business(config);
  const desktopLogin = await attachDesktopLogin(business);
  const webLogin = await attachWebLogin(business);
  const htmlRoots=JSON.parse(process.env.GEA_HTML_PLUGIN_ROOTS || "[]");
  if(!Array.isArray(htmlRoots)||htmlRoots.some(root=>typeof root!=="string"))throw Error("INVALID_HTML_PLUGIN_ROOTS");
  const htmlPlugins=await registerHtmlPlugins(ctx,business,htmlRoots);
  ctx.provide("geaMcp", {
    version: 1 as const,
    defaultConsumer: { consumerType: "AGENT" as const, consumerCode: config.analysisAgentCode },
    authenticated: () => business.status().authenticated,
    watch: (listener: () => void) => business.watchIdentity(listener),
    open: (consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string }, signal: AbortSignal) => business.openMcpConnection(consumer, signal),
  });
  registerGeaTools(ctx, business);
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
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider:
          config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
        model: selectedModel,
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
                await ctx.agentDefaultModel.saveSelection({
                  provider: "gea-analysis",
                  model: selected,
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

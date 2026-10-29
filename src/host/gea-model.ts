import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ProviderRequestId,
  attributionHeaders,
  type GenerateOptions,
  type LlmReasoningEffortInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import type { Business } from "./business.ts";
import { toGeaMessages } from "./gea-messages.ts";
import { networkError } from "../shared/net-error.ts";
import { modelHttpError } from "../shared/model-http-error.ts";
import { transportSignal } from "../shared/transport-signal.ts";
import { geaTextStream } from "../shared/gea-stream.ts";

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
function geaExtraParams(options: GenerateOptions): Record<string, string> | undefined {
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
export function geaKeptReasoningEffort(current: {
  provider?: string;
  reasoningEffort?: ReasoningEffortId;
}): ReasoningEffortId | undefined {
  const effort = current.reasoningEffort;
  if (current.provider !== "gea-analysis" || effort === undefined) return undefined;
  return GEA_REASONING_EFFORTS.some((item) => String(item.id) === String(effort))
    ? effort
    : undefined;
}

export async function initializeGeaDefaultModel(
  business: Business,
  defaults: Pick<Context["agentDefaultModel"], "currentSelection" | "saveSelection">,
  signal: AbortSignal,
): Promise<void> {
  let route: Awaited<ReturnType<Business["modelRoute"]>>;
  try {
    route = await business.modelRoute(signal, business.config.analysisAgentCode);
  } catch (error) {
    signal.throwIfAborted();
    if (defaults.currentSelection().provider !== "gea-analysis")
      await defaults.saveSelection({
        provider: "gea-analysis",
        model: business.config.analysisModel,
      });
    throw error;
  }
  signal.throwIfAborted();
  const current = defaults.currentSelection();
  if (current.provider === "gea-analysis" && route.models.includes(current.model)) return;
  const model = route.models.includes(business.config.analysisModel)
    ? business.config.analysisModel
    : route.models[0]!;
  const effort = geaKeptReasoningEffort(current);
  await defaults.saveSelection({
    provider: "gea-analysis",
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  });
}

/** 直接调用当前登录用户的 GEA 个人模型路由，不经过 AionUi 代理。 */
export class GeaModelAdapter extends LlmAdapter {
  constructor(
    private readonly business: Business,
    private readonly htmlAccess: (
      session?: string,
      signal?: AbortSignal,
    ) => Promise<{ consumerCode: string; signal: AbortSignal } | undefined> = async () => undefined,
  ) {
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
      ...(route.contextWindows?.[model]
        ? { context: { contextWindow: route.contextWindows[model] } }
        : {}),
      name: route.names[model] ?? "GEA 模型（名称未提供）",
      // 声明默认档位：用户没显式选档位时，DSH 会补上它并按 extra_params 发给网关。
      reasoning: {
        efforts: GEA_REASONING_EFFORTS,
        defaultEffort: GEA_DEFAULT_REASONING_EFFORT,
      },
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const startedAt = Date.now();
    const requestId = randomUUID();
    let responseReceivedMs: number | null = null;
    let textChars = 0;
    const cancellation = new AbortController();
    let releaseSource: (() => void) | undefined;
    using watchdog = idleWatchdog(
      AbortSignal.any([
        cancellation.signal,
        ...(options.signal ? [options.signal] : []),
        this.business.identitySignal(),
      ]),
      this.business.config.modelRequestTimeoutMs,
      "GEA_MODEL_IDLE",
    );
    const transport = transportSignal(watchdog.signal);
    const signal = transport.signal;
    // 只在"连接阶段"和"流式阶段"区分，好在报错里说清断在哪一步。
    let stage = "连接";
    const modelHost = "GEA 模型网关";
    const business = this.business;
    const htmlAccess = this.htmlAccess;
    const request = async function* (): AsyncGenerator<StreamChunk> {
      const access = await htmlAccess(options.sessionId, signal);
      if (access) {
        const abort = () => cancellation.abort(access.signal.reason);
        access.signal.addEventListener("abort", abort, { once: true });
        releaseSource = () => access.signal.removeEventListener("abort", abort);
        access.signal.throwIfAborted();
      }
      const consumer = access?.consumerCode;
      business.assertExecutionAllowed(
        consumer ?? business.config.analysisAgentCode,
        "view",
        options.sessionId,
      );
      const route = await business.modelRoute(
        signal,
        consumer ?? business.config.analysisAgentCode,
        options.sessionId,
      );
      if (!route.models.includes(options.model))
        throw new LlmError(
          "GEA_MODEL_NOT_FOUND: 当前Agent不支持所选模型，请按当前Agent重新发现并选择模型；不能借用其它Agent的模型身份。",
          "MODEL_NOT_FOUND",
        );
      const requestBody = toGeaRequest(options);
      console.info(
        JSON.stringify({
          event: "GEA_MODEL_REQUEST",
          requestId,
          sessionId: options.sessionId,
          consumerCode: route.agentCode,
          model: options.model,
          messageChars: JSON.stringify(requestBody.messages).length,
          toolSchemaChars: JSON.stringify(requestBody.tools ?? []).length,
          messageBreakdown: ["system", "user", "assistant", "tool"].map((role) => ({
            role,
            count: requestBody.messages.filter((m) => m.role === role).length,
            chars: JSON.stringify(requestBody.messages.filter((m) => m.role === role)).length,
          })),
        }),
      );
      const response = await business.fetchExternal(route.baseUrl + "/chat/completions", {
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
      responseReceivedMs = Date.now() - startedAt;
      if (!response.ok) {
        if (response.status === 401) business.expireModelLogin();
        throw await modelHttpError(response, route.agentCode, "模型推理", [route.secret]);
      }
      if (!response.body) throw new Error("GEA_MODEL_HTTP_NO_BODY");
      stage = "流式读取";
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
        throw new Error("GEA_MODEL_NOT_SSE");
      let reportedUsage = false;
      for await (const chunk of geaTextStream(
        response.body,
        signal,
        {
          names: options.tools?.map((tool) => tool.name) ?? [],
        },
        () => watchdog.pulse(),
      )) {
        if (chunk.type === "text-delta") textChars += chunk.text.length;
        if (chunk.type === "usage") {
          reportedUsage = true;
          console.info(
            JSON.stringify({
              event: "GEA_MODEL_USAGE",
              requestId,
              sessionId: options.sessionId,
              usage: chunk.usage,
            }),
          );
        }
        yield chunk;
      }
      if (!reportedUsage)
        console.info(
          JSON.stringify({
            event: "GEA_MODEL_USAGE",
            requestId,
            sessionId: options.sessionId,
            usage: null,
          }),
        );
    };
    const iterator = request();
    try {
      while (true) {
        const next = await watchdog.next(iterator);
        signal.throwIfAborted();
        if (next.done) return;
        yield next.value;
      }
    } catch (error) {
      // 线上实测：模型请求断线时界面只有 `fetch failed` + UNKNOWN（undici 的真实原因在 cause 里）。
      // 统一翻成可读、带 code 的错误：连哪个 host、断在连接还是流式阶段、原因码是什么。
      const idle = timeoutOf(watchdog.signal, "GEA_MODEL_IDLE");
      if (!idle && error instanceof LlmError) throw error;
      if ((error as { code?: string })?.code === "GEA_MODEL_TOOL_TEXT")
        throw new LlmError((error as Error).message, "PROVIDER_PROTOCOL");
      const converted = networkError(
        idle ? new DOMException(idle.message, "TimeoutError") : error,
        {
          what: modelHost,
          stage,
          timeoutMs: this.business.config.modelRequestTimeoutMs,
          timeoutScope: "model-idle",
        },
      );
      if (converted.name === "AbortError") throw converted;
      const code = (converted as Error & { code?: unknown }).code;
      console.info(
        JSON.stringify({
          event: "GEA_MODEL_FAILURE",
          requestId,
          sessionId: options.sessionId,
          model: options.model,
          code: typeof code === "string" ? code : "NETWORK",
          stage,
          elapsedMs: Date.now() - startedAt,
          responseReceivedMs,
          textChars,
          timeoutMs: this.business.config.modelRequestTimeoutMs,
        }),
      );
      throw new LlmError(
        `${converted.message} requestId=${requestId}`,
        typeof code === "string" ? code : "NETWORK",
        { requestId: ProviderRequestId(requestId) },
      );
    } finally {
      releaseSource?.();
      cancellation.abort();
      try {
        await iterator.return(undefined);
      } catch {}
      transport.dispose();
    }
  }
}

function toGeaRequest(options: GenerateOptions) {
  const extraParams = geaExtraParams(options);
  return {
    model: options.model,
    messages: toGeaMessages(options),
    stream: true,
    gea_tool_execution_mode: "client",
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
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  };
}

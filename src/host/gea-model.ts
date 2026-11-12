import type { CapturedRequest } from "./request-capture.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ProviderRequestId,
  attributionHeaders,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmReasoningEffortInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import type { Business } from "./business.ts";
import { toGeaMessages } from "./gea-messages.ts";
import { networkError } from "../shared/net-error.ts";
import { modelHttpError } from "../shared/model-http-error.ts";
import {
  modelCorrelationId,
  modelFailure,
  modelResponseDetails,
  type ModelFailureDetails,
} from "../shared/model-failure.ts";
import { transportSignal } from "../shared/transport-signal.ts";
import { geaTextStream } from "../shared/gea-stream.ts";
import { WORKBENCH_AGENT_CODE } from "./shared-agent.ts";

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

const GEA_DEFAULT_REASONING_EFFORT = ReasoningEffortId("high");

const GEA_EFFORT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const GEA_MODEL_RETRY_POLICY = resolveRetryPolicy(
  { mode: "normal", maxRetries: 2 },
  "gea-analysis.retryPolicy",
);

function geaExtraParams(options: GenerateOptions): Record<string, string> | undefined {
  const effort = options.reasoningEffort;
  if (effort === undefined) return undefined;
  const value = String(effort);
  if (!GEA_EFFORT_PATTERN.test(value)) return undefined;
  return { reasoning_effort: value };
}

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
    route = await business.modelRoute(signal, WORKBENCH_AGENT_CODE);
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

export class GeaModelAdapter extends LlmAdapter {
  private readonly requestOwners = new WeakMap<AbortSignal, AbortSignal>();
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
  override providerRetryPolicy(_provider: string) {
    return GEA_MODEL_RETRY_POLICY;
  }
  async listModels(provider: string) {
    const route = await this.business.modelRoute(
      new AbortController().signal,
      WORKBENCH_AGENT_CODE,
    );
    return route.models.map((id) => ({ provider, id, name: route.names[id] }));
  }
  async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const route = await this.business.modelRoute(
      signal ?? new AbortController().signal,
      WORKBENCH_AGENT_CODE,
    );
    return {
      provider,
      id: model,
      ...(route.contextWindows?.[model]
        ? { context: { contextWindow: route.contextWindows[model] } }
        : {}),
      name: route.names[model] ?? "GEA 模型（名称未提供）",

      reasoning: {
        efforts: GEA_REASONING_EFFORTS,
        defaultEffort: GEA_DEFAULT_REASONING_EFFORT,
      },
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose !== "compaction") {
      yield* this.streamAttempt(options);
      return;
    }
    const signal = options.signal ?? new AbortController().signal;
    const policy = this.providerRetryPolicy(options.provider);
    for (let retry = 0; ; retry++) {
      try {
        const chunks: StreamChunk[] = [];
        for await (const chunk of this.streamAttempt({ ...options, signal })) chunks.push(chunk);
        signal.throwIfAborted();
        this.requestOwners.get(signal)?.throwIfAborted();
        yield* chunks;
        return;
      } catch (error) {
        const active = AbortSignal.any([
          signal,
          this.requestOwners.get(signal) ?? this.business.identitySignal(),
        ]);
        active.throwIfAborted();
        if (
          !(error instanceof LlmError) ||
          policy.mode !== "normal" ||
          !policy.retryableCodes.includes(error.code) ||
          retry >= policy.maxRetries
        )
          throw error;
        const requestedDelay = error.failure.providerRetryAfterMs;
        if (requestedDelay !== undefined && requestedDelay > policy.maxDelayMs) throw error;
        const delayMs =
          requestedDelay ??
          Math.min(
            Math.min(policy.initialDelayMs * 2 ** retry, policy.maxDelayMs) *
              (1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()),
            policy.maxDelayMs,
          );
        console.info(
          JSON.stringify({
            event: "GEA_MODEL_RETRY",
            purpose: options.purpose,
            sessionId: options.sessionId,
            model: options.model,
            retry: retry + 1,
            delayMs,
            code: error.code,
            requestId: error.failure.requestId,
            httpStatus: error.failure.status,
          }),
        );
        await delay(delayMs, undefined, { signal: active });
      }
    }
  }
  private async *streamAttempt(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const identity =
      (options.signal && this.requestOwners.get(options.signal)) ?? this.business.identitySignal();
    if (options.signal) this.requestOwners.set(options.signal, identity);
    identity.throwIfAborted();
    const startedAt = Date.now();
    let requestId: string | undefined;
    let captured: CapturedRequest | undefined;
    let responseReceivedMs: number | null = null;
    let textChars = 0;
    let responseDetails: ModelFailureDetails = {};
    let modelSecret = "";
    const cancellation = new AbortController();
    let releaseSource: (() => void) | undefined;
    using watchdog = idleWatchdog(
      AbortSignal.any([cancellation.signal, ...(options.signal ? [options.signal] : []), identity]),
      this.business.config.modelRequestTimeoutMs,
      "GEA_MODEL_IDLE",
    );
    const transport = transportSignal(watchdog.signal);
    const signal = transport.signal;

    let stage = "连接";
    const modelHost = "GEA 模型网关";
    const business = this.business;
    const htmlAccess = this.htmlAccess;
    const requestOwners = this.requestOwners;
    const request = async function* (): AsyncGenerator<StreamChunk> {
      const access = await htmlAccess(options.sessionId, signal);
      if (access) {
        if (options.signal)
          requestOwners.set(options.signal, AbortSignal.any([identity, access.signal]));
        const abort = () => cancellation.abort(access.signal.reason);
        access.signal.addEventListener("abort", abort, { once: true });
        releaseSource = () => access.signal.removeEventListener("abort", abort);
        access.signal.throwIfAborted();
      }
      const consumer = access?.consumerCode;
      business.assertExecutionAllowed(consumer ?? WORKBENCH_AGENT_CODE, "view", options.sessionId);
      const route = await business.modelRoute(
        signal,
        consumer ?? WORKBENCH_AGENT_CODE,
        options.sessionId,
      );
      if (!route.models.includes(options.model))
        throw new LlmError(
          "GEA_MODEL_NOT_FOUND: 当前Agent不支持所选模型，请按当前Agent重新发现并选择模型；不能借用其它Agent的模型身份。",
          "MODEL_NOT_FOUND",
        );
      const requestBody = toGeaRequest(options);
      modelSecret = route.secret;
      const response = await business.capture.observe(
        () =>
          business.fetchExternal(route.baseUrl + "/chat/completions", {
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
          }),
        (request) => {
          if (request.row.requestType !== "MODEL") return;
          captured = request;
          requestId = request.row.requestId;
          console.info(
            JSON.stringify({
              event: "GEA_MODEL_REQUEST",
              requestId,
              purpose: options.purpose ?? "conversation",
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
        },
      );
      responseReceivedMs = Date.now() - startedAt;
      responseDetails = {
        httpStatus: response.status,
        ...modelResponseDetails(response.headers, [route.secret]),
      };
      if (!response.ok) {
        if (response.status === 401) business.expireModelLogin();
        throw await modelHttpError(response, route.agentCode, "模型推理", [route.secret], (value) =>
          business.capture.diagnostic(captured, "received", value),
        );
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
        {
          received: (text) => business.capture.diagnostic(captured, "received", text),
          assembled: (value) => business.capture.diagnostic(captured, "assembled", value),
          terminal: (state, error) => {
            if (error) business.capture.fail(captured, error, signal);
            else business.capture.finish(captured, state);
            business.capture.diagnostic(captured, "terminal", {
              state: captured?.row.state,
              errorCode: captured?.row.errorCode,
            });
          },
        },
      )) {
        if (chunk.type === "text-delta") textChars += chunk.text.length;
        if (chunk.type === "usage") {
          reportedUsage = true;
          console.info(
            JSON.stringify({
              event: "GEA_MODEL_USAGE",
              requestId,
              serverRequestId: responseDetails.requestId,
              traceId: responseDetails.traceId ?? requestId,
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
            serverRequestId: responseDetails.requestId,
            traceId: responseDetails.traceId ?? requestId,
            sessionId: options.sessionId,
            usage: null,
          }),
        );
    };
    const iterator = business.capture.iterate(
      options.sessionId,
      options.purpose ?? "模型推理",
      request(),
    );
    try {
      while (true) {
        const next = await watchdog.next(iterator);
        signal.throwIfAborted();
        if (next.done) return;
        yield next.value;
      }
    } catch (error) {
      business.capture.fail(captured, error, signal);
      business.capture.diagnostic(captured, "terminal", {
        state: captured?.row.state,
        errorCode: captured?.row.errorCode,
      });

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
      const failure = modelFailure(converted);
      const details = { ...failure.details, ...responseDetails };
      const serverRequestId = modelCorrelationId(details.requestId, [modelSecret]);
      const traceId = modelCorrelationId(details.traceId, [modelSecret]) ?? requestId;
      const correlation = serverRequestId ?? requestId;
      console.info(
        JSON.stringify({
          event: "GEA_MODEL_FAILURE",
          requestId,
          purpose: options.purpose ?? "conversation",
          sessionId: options.sessionId,
          model: options.model,
          code: failure.code,
          geaCode: failure.originalCode,
          serverRequestId,
          traceId,
          httpStatus: details.httpStatus,
          upstreamCode: details.upstreamCode,
          stage,
          elapsedMs: Date.now() - startedAt,
          responseReceivedMs,
          textChars,
          timeoutMs: this.business.config.modelRequestTimeoutMs,
        }),
      );
      throw new LlmError(
        `${converted.message} requestId=${serverRequestId ?? requestId} clientRequestId=${requestId} traceId=${traceId}`,
        failure.code,
        {
          ...(correlation ? { requestId: ProviderRequestId(correlation) } : {}),
          status: details.httpStatus,
          providerRetryAfterMs: details.providerRetryAfterMs,
          cause: converted,
        },
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

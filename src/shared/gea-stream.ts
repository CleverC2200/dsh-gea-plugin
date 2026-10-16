/** 将 GEA SSE 增量转换为 DSH 流块；只接受声明过的工具、限制累计大小，并拒绝歧义格式。 */
import { createParser } from "eventsource-parser";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("GEA_MODEL_INVALID_SSE");
  return value as Record<string, unknown>;
}

/**
 * 模型流失败的统一错误：错误码保留在消息最前面（便于检索与既有断言），
 * 后面跟一句人能看懂的话，界面上不再只显示一个裸代号。
 */
const STREAM_FAILURES: Record<string, string> = {
  GEA_MODEL_TOOL_TEXT: "模型把工具调用写成了文本；这些调用未执行，本轮业务答复未完成",
  GEA_MODEL_INCOMPLETE_STREAM: "模型这一轮没返回结束标记就断流了，本轮已中止，请重发一次",
  GEA_MODEL_UNSUPPORTED_TOOL_CALL: "模型用了这个客户端不支持的调用方式，本轮已中止",
  GEA_MODEL_INVALID_TOOL_CALL: "模型这一轮回复里的工具调用不合法，本轮已中止，请重发一次",
  GEA_MODEL_TOOL_CALL_TOO_LARGE: "模型这一轮想传的参数超过上限，本轮已中止，请把请求拆小一点再试",
  GEA_MODEL_UNSUPPORTED_FINISH_REASON: "模型返回了无法识别的结束原因，本轮已中止",
  GEA_MODEL_REASONING_TOO_LARGE: "模型返回的思考超出网关历史上限，本轮已中止，原文不会被截断回传",
  GEA_MODEL_EMPTY_RESPONSE: "模型这一轮没有给出任何内容，请重发一次",
  GEA_MODEL_INVALID_SSE: "模型返回的数据格式无法解析，本轮已中止",
  GEA_MODEL_GATEWAY_ERROR: "模型网关在流里回了错误，本轮已中止",
  GEA_MODEL_CONTEXT_TOO_LONG:
    "这一轮上下文超出模型上限，本轮已中止：把问题拆小（少读几份明细、换成聚合口径）再问一次",
};

function streamFailure(code: string, detail?: string): Error {
  const human = STREAM_FAILURES[code] ?? "模型这一轮返回的内容不合法，本轮已中止";
  const error = new Error(detail ? `${code}：${human}（${detail}）` : `${code}：${human}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

function invalid(code: string, detail?: string): never {
  throw streamFailure(code, detail);
}

/** Classify gateway failures without copying response text into diagnostics. */
const CONTEXT_LIMIT_SIGN =
  /context length|context_length|maximum context|too many tokens|token limit|reduce the length|max_tokens/i;

function gatewayErrorDetail(value: unknown): { detail: string; contextLimit: boolean } {
  const error = record(value);
  const codes = new Set([
    "invalid_request",
    "invalid_tool_message",
    "invalid_api_key",
    "permission_denied",
    "rate_limit_exceeded",
    "concurrency_limit_exceeded",
    "context_length_exceeded",
    "MODEL_UPSTREAM_CONNECT_TIMEOUT",
    "MODEL_UPSTREAM_TIMEOUT",
    "MODEL_UPSTREAM_RATE_LIMITED",
    "MODEL_UPSTREAM_REJECTED",
    "MODEL_UPSTREAM_UNAVAILABLE",
    "model_gateway_unavailable",
    "STREAM_ERROR",
    "STREAM_TRANSPORT_ERROR",
    "INTERNAL",
    "upstream_error",
  ]);
  const safeCode = (value: unknown) =>
    typeof value === "string" && codes.has(value) ? value : undefined;
  const types = new Set([
    "invalid_request_error",
    "server_error",
    "authentication_error",
    "permission_error",
    "rate_limit_error",
  ]);
  return {
    detail: [
      safeCode(error.code),
      typeof error.type === "string" && types.has(error.type) ? error.type : undefined,
    ]
      .filter(Boolean)
      .join(" | "),
    contextLimit: CONTEXT_LIMIT_SIGN.test(
      [error.code, error.message].filter((value) => typeof value === "string").join(" "),
    ),
  };
}

/** Provider counters are authoritative; missing usage is not zero usage. */
export function geaUsage(value: unknown): import("@deepseek-ai/dsh-llm").TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const details = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const valid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  const input = raw.prompt_tokens ?? raw.input_tokens,
    output = raw.completion_tokens ?? raw.output_tokens;
  if (!valid(input) || !valid(output)) return undefined;
  const cached =
    details(raw.prompt_tokens_details).cached_tokens ?? raw.prompt_cache_hit_tokens ?? 0;
  const written = raw.cache_creation_input_tokens ?? 0;
  if (!valid(cached) || !valid(written) || cached + written > input) return undefined;
  const reasoning = details(raw.completion_tokens_details).reasoning_tokens;
  return {
    inputTokens: input - cached - written,
    outputTokens: output,
    ...(cached ? { cacheReadTokens: cached } : {}),
    ...(written ? { cacheWriteTokens: written } : {}),
    ...(valid(reasoning) && reasoning <= output ? { reasoningTokens: reasoning } : {}),
    totalTokens: input + output,
  };
}

function completion(data: string): {
  text?: string;
  reasoning?: string;
  finish?: "stop" | "max-tokens" | "tool-calls";
  tools?: unknown[];
} {
  if (data.trim() === "[DONE]") invalid("GEA_MODEL_INCOMPLETE_STREAM");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    invalid(
      "GEA_MODEL_INVALID_SSE",
      `这一帧不是 JSON（${new TextEncoder().encode(data).byteLength} 字节）`,
    );
  }
  const payload = record(parsed);
  // 网关用 SSE 回错误对象时（上下文超限、上游模型报错、限流…），要把它的话原样带出来：
  // 一律报"格式无法解析"等于把真因吞掉（线上就是这么被误导的）。
  if (payload.error != null) {
    const detail = gatewayErrorDetail(payload.error);
    if (detail.contextLimit) invalid("GEA_MODEL_CONTEXT_TOO_LONG", detail.detail);
    invalid("GEA_MODEL_GATEWAY_ERROR", detail.detail);
  }
  if (!Array.isArray(payload.choices)) invalid("GEA_MODEL_INVALID_SSE", "choices 不是数组");
  if (payload.choices.length > 1)
    invalid("GEA_MODEL_INVALID_SSE", `choices 多于一条（${payload.choices.length}）`);
  if (payload.choices.length === 0) return {};
  const choice = record(payload.choices[0]);
  if (choice.index !== undefined && choice.index !== 0)
    invalid("GEA_MODEL_INVALID_SSE", "不支持的 choice.index");
  const delta = choice.delta == null ? {} : record(choice.delta);
  if (delta.function_call != null) invalid("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
  if (delta.tool_calls != null && !Array.isArray(delta.tool_calls))
    invalid("GEA_MODEL_INVALID_SSE", "tool_calls 不是数组");
  const tools = delta.tool_calls as unknown[] | undefined;
  if (delta.content != null && typeof delta.content !== "string")
    invalid("GEA_MODEL_INVALID_SSE", `content 类型是 ${typeof delta.content}`);
  const text = typeof delta.content === "string" ? delta.content : undefined;
  if (delta.reasoning_content != null && typeof delta.reasoning_content !== "string")
    invalid("GEA_MODEL_INVALID_SSE", "reasoning_content 不是字符串");
  const reasoning =
    typeof delta.reasoning_content === "string" ? delta.reasoning_content : undefined;
  if (choice.finish_reason == null) return { text, reasoning, tools };
  if (choice.finish_reason === "stop") return { text, reasoning, tools, finish: "stop" };
  if (choice.finish_reason === "length") return { text, reasoning, tools, finish: "max-tokens" };
  if (choice.finish_reason === "tool_calls")
    return { text, reasoning, tools, finish: "tool-calls" };
  invalid("GEA_MODEL_UNSUPPORTED_FINISH_REASON");
}

/**
 * 将流式文本保留在权威的最终块中，并要求收到终止完成事件。
 * @param body 此次模型调用拥有的成功 SSE 响应体。
 * @param signal 同时取消待读取和所属请求。
 * @param offered 所属请求提供的工具名及参数字节预算；省略时仅允许文本。
 * @returns Harness 流块；不完整或不支持的完成会抛错，交由 LlmRuntime 分类。
 */
export async function* geaTextStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  offered?: { names: readonly string[]; maxBytes: number },
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel().catch(() => {
      // 已报错或已中止的响应可能拒绝取消；其读取过程已经报告了失败。
    });
    return cancellation;
  };
  const onAbort = () => {
    void cancel();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  const events: string[] = [];
  const parser = createParser({ onEvent: (event) => events.push(event.data) });
  let text = "";
  let reasoning = "";
  let reasoningStarted = false;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  let callBytes = 0;
  let terminal: "stop" | "max-tokens" | "tool-calls" | undefined;
  let usage: import("@deepseek-ai/dsh-llm").TokenUsage | undefined;
  let usageDeadline = 0;
  const finishChunk = (reason: NonNullable<typeof terminal>): StreamChunk => ({
    type: "finish",
    reason: { kind: reason },
    ...(reasoning && reason !== "max-tokens"
      ? { replayState: { response: { protocol: "gea-client-reasoning-v1", complete: true } } }
      : {}),
  });
  try {
    signal?.throwIfAborted();
    yield { type: "block-start", index: 0, blockType: "text" };
    while (true) {
      signal?.throwIfAborted();
      if (terminal && Date.now() >= usageDeadline) {
        if (usage) yield { type: "usage", usage };
        yield finishChunk(terminal);
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = terminal
        ? await Promise.race([
            reader.read(),
            new Promise<ReadableStreamReadResult<Uint8Array>>((done) => {
              timer = setTimeout(
                () => done({ done: true, value: undefined }),
                Math.max(1, usageDeadline - Date.now()),
              );
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          })
        : await reader.read();
      signal?.throwIfAborted();
      parser.feed(read.done ? decoder.decode() : decoder.decode(read.value, { stream: true }));
      for (const data of events.splice(0)) {
        signal?.throwIfAborted();
        if (data.trim() === "[DONE]" && terminal) {
          if (usage) yield { type: "usage", usage };
          yield finishChunk(terminal);
          return;
        }
        try {
          usage = geaUsage(record(JSON.parse(data)).usage) ?? usage;
        } catch {
          /* completion reports malformed frames. */
        }
        const chunk = completion(data);
        // completion still checks error envelopes. Late successful deltas do not
        // mutate blocks which have already completed.
        if (terminal) continue;
        if (chunk.reasoning) {
          if (reasoning.length + chunk.reasoning.length > 1_048_576)
            invalid("GEA_MODEL_REASONING_TOO_LARGE");
          reasoning += chunk.reasoning;
          if (!reasoningStarted) {
            reasoningStarted = true;
            yield { type: "block-start", index: 1, blockType: "reasoning" };
          }
          yield { type: "reasoning-delta", index: 1, text: chunk.reasoning };
        }
        for (const value of chunk.tools ?? []) {
          if (!offered?.names.length) invalid("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
          const delta = record(value);
          if (
            !Number.isSafeInteger(delta.index) ||
            (delta.index as number) < 0 ||
            (delta.type !== undefined && delta.type !== "function")
          )
            invalid("GEA_MODEL_INVALID_TOOL_CALL", "工具调用索引或类型无效");
          const fn = delta.function == null ? {} : record(delta.function);
          const call = calls.get(delta.index as number) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          for (const [field, fragment] of [
            ["id", delta.id],
            ["name", fn.name],
          ] as const) {
            if (fragment === undefined || fragment === "") continue;
            if (
              typeof fragment !== "string" ||
              (call[field] && call[field] !== fragment)
            )
              invalid("GEA_MODEL_INVALID_TOOL_CALL", "工具调用标识或名称片段冲突");
            if (!call[field]) callBytes += new TextEncoder().encode(fragment).byteLength;
            call[field] = fragment;
          }
          if (fn.arguments !== undefined) {
            if (typeof fn.arguments !== "string") invalid("GEA_MODEL_INVALID_TOOL_CALL", "工具参数片段不是字符串");
            call.arguments += fn.arguments;
            callBytes += new TextEncoder().encode(fn.arguments).byteLength;
          }
          if (!calls.has(delta.index as number)) callBytes += 1;
          if (callBytes > offered.maxBytes) invalid("GEA_MODEL_TOOL_CALL_TOO_LARGE");
          calls.set(delta.index as number, call);
        }
        if (chunk.text) {
          text += chunk.text;
          // Reject raw protocol before yielding its completed marker, including split SSE chunks.
          if (/^\s*<[|｜]{2}DSML[|｜]{2}\s*(?:tool_calls|calls|invoke)\b/.test(text))
            invalid("GEA_MODEL_TOOL_TEXT");
          yield { type: "text-delta", index: 0, text: chunk.text };
        }
        if (chunk.finish) {
          signal?.throwIfAborted();
          const ids = new Set<string>();
          if (calls.size > 0 !== (chunk.finish === "tool-calls"))
            invalid("GEA_MODEL_INVALID_TOOL_CALL", "结束标记与工具调用不一致");
          for (const call of calls.values()) {
            if (!call.id || ids.has(call.id))
              invalid("GEA_MODEL_INVALID_TOOL_CALL", "工具调用标识为空或重复");
            if (!offered?.names.includes(call.name))
              invalid("GEA_MODEL_INVALID_TOOL_CALL", "调用的工具不在本轮提供的清单中");
            ids.add(call.id);
            let args: unknown;
            try {
              args = JSON.parse(call.arguments);
            } catch {
              invalid("GEA_MODEL_INVALID_TOOL_CALL", "工具参数不是合法 JSON");
            }
            if (!args || typeof args !== "object" || Array.isArray(args))
              invalid("GEA_MODEL_INVALID_TOOL_CALL", "工具参数不是 JSON 对象");
          }
          if (!text.trim() && chunk.finish === "stop") invalid("GEA_MODEL_EMPTY_RESPONSE");
          yield { type: "block-end", index: 0, block: { type: "text", text } };
          if (reasoningStarted)
            yield { type: "block-end", index: 1, block: { type: "reasoning", text: reasoning } };
          let index = reasoningStarted ? 2 : 1;
          for (const call of calls.values()) {
            signal?.throwIfAborted();
            const id = brandString<ToolCallId>(call.id);
            yield { type: "block-start", index, blockType: "tool-call" };
            yield {
              type: "tool-call-delta",
              index,
              id,
              name: call.name,
              argumentsDelta: call.arguments,
            };
            yield {
              type: "block-end",
              index,
              block: {
                type: "tool-call",
                id,
                name: call.name,
                arguments: call.arguments,
              },
            };
            index++;
          }
          signal?.throwIfAborted();
          terminal = chunk.finish;
          usageDeadline = Date.now() + 250;
        }
      }
      if (read.done) {
        if (!terminal) invalid("GEA_MODEL_INCOMPLETE_STREAM");
        if (usage) yield { type: "usage", usage };
        yield finishChunk(terminal);
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await cancel();
    reader.releaseLock();
  }
}

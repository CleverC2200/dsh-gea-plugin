/** 将 GEA SSE 增量转换为 DSH 流块；只接受声明过的工具、限制累计大小，并拒绝歧义格式。 */
import { createParser } from "eventsource-parser";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("GEA_MODEL_INVALID_SSE");
  return value as Record<string, unknown>;
}

/**
 * 模型流失败的统一错误：错误码保留在消息最前面（便于检索与既有断言），
 * 后面跟一句人能看懂的话，界面上不再只显示一个裸代号。
 */
const STREAM_FAILURES: Record<string, string> = {
  GEA_MODEL_INCOMPLETE_STREAM:
    "模型这一轮没返回结束标记就断流了，本轮已中止，请重发一次",
  GEA_MODEL_UNSUPPORTED_TOOL_CALL:
    "模型用了这个客户端不支持的调用方式，本轮已中止",
  GEA_MODEL_INVALID_TOOL_CALL:
    "模型这一轮回复里的工具调用不合法，本轮已中止，请重发一次",
  GEA_MODEL_TOOL_CALL_TOO_LARGE:
    "模型这一轮想传的参数超过上限，本轮已中止，请把请求拆小一点再试",
  GEA_MODEL_UNSUPPORTED_FINISH_REASON:
    "模型返回了无法识别的结束原因，本轮已中止",
  GEA_MODEL_EMPTY_RESPONSE: "模型这一轮没有给出任何内容，请重发一次",
  GEA_MODEL_INVALID_SSE: "模型返回的数据格式无法解析，本轮已中止",
};

function streamFailure(code: string, detail?: string): Error {
  const human = STREAM_FAILURES[code] ?? "模型这一轮返回的内容不合法，本轮已中止";
  const error = new Error(
    detail ? `${code}：${human}（${detail}）` : `${code}：${human}`,
  );
  (error as Error & { code?: string }).code = code;
  return error;
}

function invalid(code: string, detail?: string): never {
  throw streamFailure(code, detail);
}

/** 出问题时把参数尾部（截断、去控制字符）留在运行日志里，方便下次定位。 */
function argumentTail(argumentsText: string, max = 160): string {
  const flat = argumentsText.replace(/[\u0000-\u001f]+/g, " ").trim();
  return flat.length > max ? "…" + flat.slice(-max) : flat;
}

function logRejectedToolCall(name: string, reason: string, argumentsText: string): void {
  console.log(
    `[model-stream] dropped tool call name=${name || "(no name)"} reason=${reason} bytes=${new TextEncoder().encode(argumentsText).byteLength} tail=${argumentTail(argumentsText)}`,
  );
}

function completion(data: string): {
  text?: string;
  finish?: "stop" | "max-tokens" | "tool-calls";
  tools?: unknown[];
} {
  if (data.trim() === "[DONE]") invalid("GEA_MODEL_INCOMPLETE_STREAM");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    invalid("GEA_MODEL_INVALID_SSE");
  }
  const payload = record(parsed);
  if (
    payload.error ||
    !Array.isArray(payload.choices) ||
    payload.choices.length > 1
  )
    invalid("GEA_MODEL_INVALID_SSE");
  if (payload.choices.length === 0) return {};
  const choice = record(payload.choices[0]);
  if (choice.index !== undefined && choice.index !== 0)
    invalid("GEA_MODEL_INVALID_SSE");
  const delta = choice.delta == null ? {} : record(choice.delta);
  if (delta.function_call != null)
    invalid("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
  if (delta.tool_calls != null && !Array.isArray(delta.tool_calls))
    invalid("GEA_MODEL_INVALID_SSE");
  const tools = delta.tool_calls as unknown[] | undefined;
  if (delta.content != null && typeof delta.content !== "string")
    invalid("GEA_MODEL_INVALID_SSE");
  const text = typeof delta.content === "string" ? delta.content : undefined;
  // reasoning_content 不会被投影为最终答案。
  if (choice.finish_reason == null) return { text, tools };
  if (choice.finish_reason === "stop") return { text, tools, finish: "stop" };
  if (choice.finish_reason === "length")
    return { text, tools, finish: "max-tokens" };
  if (choice.finish_reason === "tool_calls")
    return { text, tools, finish: "tool-calls" };
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
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let callBytes = 0;
  try {
    signal?.throwIfAborted();
    yield { type: "block-start", index: 0, blockType: "text" };
    while (true) {
      signal?.throwIfAborted();
      const read = await reader.read();
      signal?.throwIfAborted();
      parser.feed(
        read.done
          ? decoder.decode()
          : decoder.decode(read.value, { stream: true }),
      );
      for (const data of events.splice(0)) {
        signal?.throwIfAborted();
        const chunk = completion(data);
        for (const value of chunk.tools ?? []) {
          if (!offered?.names.length)
            invalid("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
          const delta = record(value);
          if (
            !Number.isSafeInteger(delta.index) ||
            (delta.index as number) < 0 ||
            (delta.type !== undefined && delta.type !== "function")
          )
            invalid("GEA_MODEL_INVALID_TOOL_CALL");
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
            if (fragment === undefined) continue;
            if (
              typeof fragment !== "string" ||
              !fragment ||
              (call[field] && call[field] !== fragment)
            )
              invalid("GEA_MODEL_INVALID_TOOL_CALL");
            if (!call[field])
              callBytes += new TextEncoder().encode(fragment).byteLength;
            call[field] = fragment;
          }
          if (fn.arguments !== undefined) {
            if (typeof fn.arguments !== "string")
              invalid("GEA_MODEL_INVALID_TOOL_CALL");
            call.arguments += fn.arguments;
            callBytes += new TextEncoder().encode(fn.arguments).byteLength;
          }
          if (!calls.has(delta.index as number)) callBytes += 1;
          if (callBytes > offered.maxBytes)
            invalid("GEA_MODEL_TOOL_CALL_TOO_LARGE");
          calls.set(delta.index as number, call);
        }
        if (chunk.text) {
          text += chunk.text;
          yield { type: "text-delta", index: 0, text: chunk.text };
        }
        if (chunk.finish) {
          signal?.throwIfAborted();
          const ids = new Set<string>();
          // 只有"参数不是合法 JSON"这一类降级为"这一次调用失败"：结构性问题
          // （缺 id、id 重复、调了本轮没提供的工具）仍然硬失败，不能拿坏流糊过去。
          const executable: Array<{
            id: string;
            name: string;
            arguments: string;
          }> = [];
          const dropped: string[] = [];
          for (const call of calls.values()) {
            if (
              !call.id ||
              ids.has(call.id) ||
              !offered?.names.includes(call.name)
            )
              invalid("GEA_MODEL_INVALID_TOOL_CALL");
            ids.add(call.id);
            let reason: string | undefined;
            try {
              const args: unknown = JSON.parse(call.arguments);
              if (!args || typeof args !== "object" || Array.isArray(args))
                reason = "参数不是 JSON 对象";
            } catch {
              reason = "参数不是合法 JSON（多半被截断，或引号/括号错位）";
            }
            if (reason) {
              logRejectedToolCall(call.name, reason, call.arguments);
              dropped.push(`${call.name}：${reason}`);
              continue;
            }
            executable.push(call);
          }
          if (dropped.length === 0 && calls.size > 0 !== (chunk.finish === "tool-calls"))
            invalid("GEA_MODEL_INVALID_TOOL_CALL");
          // 被丢弃的调用要告诉模型，让它自己重发一次；不假装它调用成功了。
          if (dropped.length > 0)
            text +=
              (text.trim() ? "\n\n" : "") +
              `（宿主提示：${dropped.length} 次工具调用的参数不合法，已丢弃，没有执行：${dropped.join("；")}。` +
              "请重新发起这些调用，参数必须是合法的 JSON 对象；如果用不到就忽略这条提示。）";
          const finishKind =
            dropped.length > 0
              ? executable.length > 0
                ? "tool-calls"
                : "stop"
              : chunk.finish;
          if (!text.trim() && finishKind === "stop")
            invalid("GEA_MODEL_EMPTY_RESPONSE");
          yield { type: "block-end", index: 0, block: { type: "text", text } };
          let index = 1;
          for (const call of executable) {
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
          yield { type: "finish", reason: { kind: finishKind } };
          return;
        }
      }
      if (read.done) invalid("GEA_MODEL_INCOMPLETE_STREAM");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await cancel();
    reader.releaseLock();
  }
}

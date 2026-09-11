/** OpenAI-compatible SSE translation for GEA text and explicitly offered tools. */
import { createParser } from "eventsource-parser";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GEA_MODEL_INVALID_SSE");
  return value as Record<string, unknown>;
}

function completion(data: string): {
  text?: string;
  finish?: "stop" | "max-tokens" | "tool-calls";
  tools?: unknown[];
} {
  if (data.trim() === "[DONE]") throw new Error("GEA_MODEL_INCOMPLETE_STREAM");
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("GEA_MODEL_INVALID_SSE");
  }
  const payload = record(parsed);
  if (
    payload.error ||
    !Array.isArray(payload.choices) ||
    payload.choices.length > 1
  )
    throw new Error("GEA_MODEL_INVALID_SSE");
  if (payload.choices.length === 0) return {};
  const choice = record(payload.choices[0]);
  if (choice.index !== undefined && choice.index !== 0)
    throw new Error("GEA_MODEL_INVALID_SSE");
  const delta = choice.delta == null ? {} : record(choice.delta);
  if (delta.function_call != null)
    throw new Error("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
  if (delta.tool_calls != null && !Array.isArray(delta.tool_calls))
    throw new Error("GEA_MODEL_INVALID_SSE");
  const tools = delta.tool_calls as unknown[] | undefined;
  if (delta.content != null && typeof delta.content !== "string")
    throw new Error("GEA_MODEL_INVALID_SSE");
  const text = typeof delta.content === "string" ? delta.content : undefined;
  // reasoning_content is intentionally not projected as an answer.
  if (choice.finish_reason == null) return { text, tools };
  if (choice.finish_reason === "stop") return { text, tools, finish: "stop" };
  if (choice.finish_reason === "length")
    return { text, tools, finish: "max-tokens" };
  if (choice.finish_reason === "tool_calls")
    return { text, tools, finish: "tool-calls" };
  throw new Error("GEA_MODEL_UNSUPPORTED_FINISH_REASON");
}

/**
 * Preserve streamed text in the authoritative final block and require a terminal completion.
 * @param body - The successful SSE response body owned by this model call.
 * @param signal - Cancels pending reads as well as the owning request.
 * @param offered - Tool names and argument byte budget from the owning request; omitted means text only.
 * @returns Harness chunks; incomplete or unsupported completions throw for LlmRuntime to classify.
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
      // An errored or aborted response can reject cancellation; its read already reports the failure.
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
            throw new Error("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
          const delta = record(value);
          if (
            !Number.isSafeInteger(delta.index) ||
            (delta.index as number) < 0 ||
            (delta.type !== undefined && delta.type !== "function")
          )
            throw new Error("GEA_MODEL_INVALID_TOOL_CALL");
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
              throw new Error("GEA_MODEL_INVALID_TOOL_CALL");
            if (!call[field])
              callBytes += new TextEncoder().encode(fragment).byteLength;
            call[field] = fragment;
          }
          if (fn.arguments !== undefined) {
            if (typeof fn.arguments !== "string")
              throw new Error("GEA_MODEL_INVALID_TOOL_CALL");
            call.arguments += fn.arguments;
            callBytes += new TextEncoder().encode(fn.arguments).byteLength;
          }
          if (!calls.has(delta.index as number)) callBytes += 1;
          if (callBytes > offered.maxBytes)
            throw new Error("GEA_MODEL_TOOL_CALL_TOO_LARGE");
          calls.set(delta.index as number, call);
        }
        if (chunk.text) {
          text += chunk.text;
          yield { type: "text-delta", index: 0, text: chunk.text };
        }
        if (chunk.finish) {
          signal?.throwIfAborted();
          if (calls.size > 0 !== (chunk.finish === "tool-calls"))
            throw new Error("GEA_MODEL_INVALID_TOOL_CALL");
          const ids = new Set<string>();
          for (const call of calls.values()) {
            if (
              !call.id ||
              ids.has(call.id) ||
              !offered?.names.includes(call.name)
            )
              throw new Error("GEA_MODEL_INVALID_TOOL_CALL");
            ids.add(call.id);
            let args: unknown;
            try {
              args = JSON.parse(call.arguments);
            } catch {
              throw new Error("GEA_MODEL_INVALID_TOOL_CALL");
            }
            record(args);
          }
          if (!text.trim() && chunk.finish === "stop")
            throw new Error("GEA_MODEL_EMPTY_RESPONSE");
          yield { type: "block-end", index: 0, block: { type: "text", text } };
          let index = 1;
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
          yield { type: "finish", reason: { kind: chunk.finish } };
          return;
        }
      }
      if (read.done) throw new Error("GEA_MODEL_INCOMPLETE_STREAM");
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await cancel();
    reader.releaseLock();
  }
}

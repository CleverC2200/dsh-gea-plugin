/** Text-only OpenAI-compatible SSE translation for the GEA analysis preset. */
import { createParser } from "eventsource-parser";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GEA_MODEL_INVALID_SSE");
  return value as Record<string, unknown>;
}

function completion(data: string): {
  text?: string;
  finish?: "stop" | "max-tokens";
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
  if (
    delta.function_call != null ||
    (delta.tool_calls != null &&
      (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0))
  )
    throw new Error("GEA_MODEL_UNSUPPORTED_TOOL_CALL");
  if (delta.content != null && typeof delta.content !== "string")
    throw new Error("GEA_MODEL_INVALID_SSE");
  const text = typeof delta.content === "string" ? delta.content : undefined;
  // reasoning_content is intentionally not projected as an answer.
  if (choice.finish_reason == null) return { text };
  if (choice.finish_reason === "stop") return { text, finish: "stop" };
  if (choice.finish_reason === "length") return { text, finish: "max-tokens" };
  throw new Error("GEA_MODEL_UNSUPPORTED_FINISH_REASON");
}

/**
 * Preserve streamed text in the authoritative final block and require a terminal completion.
 * @param body - The successful SSE response body owned by this model call.
 * @param signal - Cancels pending reads as well as the owning request.
 * @returns Harness chunks; incomplete or unsupported completions throw for LlmRuntime to classify.
 */
export async function* geaTextStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
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
        if (chunk.text) {
          text += chunk.text;
          yield { type: "text-delta", index: 0, text: chunk.text };
        }
        if (chunk.finish) {
          signal?.throwIfAborted();
          if (!text.trim() && chunk.finish === "stop")
            throw new Error("GEA_MODEL_EMPTY_RESPONSE");
          yield { type: "block-end", index: 0, block: { type: "text", text } };
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

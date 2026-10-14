import { throwIfAborted } from "../shared/abort.ts";

// The wire can carry both structured JSON and its escaped text representation.
export const DEFAULT_MCP_RESPONSE_BYTES = 320 * 1024 * 1024;

/** Bound decoded UTF-8 response bytes before allocating or parsing the whole message. */
export async function readMcpResponseText(
  response: Response,
  signal: AbortSignal,
  maxBytes = DEFAULT_MCP_RESPONSE_BYTES,
): Promise<string> {
  throwIfAborted(signal);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        cancel();
        throw Object.assign(Error("GEA_MCP_RESPONSE_TOO_LARGE: 请缩小查询或分页，不要原样重试。"), {
          code: "GEA_MCP_RESPONSE_TOO_LARGE",
          retryable: false,
          suggestedAction: "NARROW_QUERY_OR_PAGINATE",
          actualBytes: bytes,
          maxBytes,
        });
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

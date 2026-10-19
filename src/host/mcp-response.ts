import { throwIfAborted } from "../shared/abort.ts";
import { readableMessage } from "./error-envelope.ts";

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

export async function readMcpHttpFailure(
  response: Response,
  signal: AbortSignal,
  maxBytes?: number,
): Promise<Error | undefined> {
  let value: unknown;
  try {
    const text = await readMcpResponseText(
      response,
      signal,
      Math.min(maxBytes ?? DEFAULT_MCP_RESPONSE_BYTES, 64 * 1024),
    );
    value = JSON.parse(text);
  } catch {
    throwIfAborted(signal);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (!("success" in value) || value.success !== false) return;
  if (
    !("code" in value) ||
    typeof value.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.code)
  )
    return;
  const message = "message" in value ? readableMessage(value.message) : undefined;
  if (!message || /[<>]|authorization|cookie|token|delegation/i.test(message)) return;
  const ids = Object.fromEntries(
    ["requestId", "traceId", "auditId"].flatMap((key) => {
      const id = Reflect.get(value, key);
      return typeof id === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(id) ? [[key, id]] : [];
    }),
  );
  const retryable = "retryable" in value && value.retryable === true;
  const retryAfter = "retryAfterMs" in value ? value.retryAfterMs : undefined;
  return Object.assign(
    Error(
      `${value.code}: ${message}（HTTP ${response.status}）。本次请求已停止，不自动重试。${Object.entries(
        ids,
      )
        .map(([key, id]) => ` ${key}=${id}`)
        .join("")}`,
    ),
    {
      code: value.code,
      httpStatus: response.status,
      retryable,
      ...(typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter >= 0
        ? { retryAfterMs: retryAfter }
        : {}),
      ...ids,
    },
  );
}

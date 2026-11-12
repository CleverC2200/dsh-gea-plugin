export const ABORTED_CODE = "GEA_TURN_ABORTED";

const ABORT_MESSAGE = "已中止：这一轮被停止（用户停止或身份失效），本次调用没有完成。";

function looksAborted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && /abort/i.test(kind);
}

function abortDetail(reason: unknown): string {
  if (reason === undefined) return "";
  if (typeof reason === "string") return reason.slice(0, 80);
  if (looksAborted(reason)) {
    const inner = (reason as { reason?: unknown }).reason;
    const innerKind =
      inner && typeof inner === "object" ? (inner as { kind?: unknown }).kind : inner;
    return typeof innerKind === "string" ? innerKind.slice(0, 40) : "";
  }
  return "";
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return code === ABORTED_CODE || value.name === "AbortError" || value.name === "TimeoutError";
  }
  return looksAborted(value);
}

export function readableError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (isAbortError(value)) {
    const detail = abortDetail(value);
    return Object.assign(
      new Error(`${ABORTED_CODE}: ${ABORT_MESSAGE}${detail ? `（原因：${detail}）` : ""}`),
      { code: ABORTED_CODE, cause: value },
    );
  }
  if (value && typeof value === "object") {
    const record = value as { message?: unknown; code?: unknown };
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message
        : describe(value);
    const code = typeof record.code === "string" ? record.code : "";
    return Object.assign(new Error(code ? `${code}: ${message}` : message), {
      ...(code ? { code } : {}),
      cause: value,
    });
  }
  return new Error(String(value));
}

export function describe(value: unknown): string {
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) : value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string" && text !== "{}") return text.slice(0, 300);
  } catch {}
  return String(value);
}

export function throwIfAborted(signal: AbortSignal | undefined | null): void {
  if (!signal?.aborted) return;
  throw readableError(signal.reason ?? { kind: "aborted" });
}

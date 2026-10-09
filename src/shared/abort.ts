/**
 * 中止信号与"抛出来的不是 Error"这两件事的统一处理。
 *
 * 线上现象（2026-09-23，会话 session-af74ce65）：用户点停止后界面上出现一行红色
 * `Error: [object Object]`。原因已复现：宿主把 dsh 的中止信号原样使用，而 dsh 中止时
 * 携带的 `signal.reason` 是一个**对象**（`{kind:"aborted",reason:{kind:"user"}}`）。
 * `AbortSignal.throwIfAborted()` 按规范抛的就是这个 reason；`fetch` 因 abort 失败时也
 * 会以它为拒绝原因，于是宿主往上层抛出了一个普通对象。框架只能用 `String(obj)` 渲染，
 * 就变成 `[object Object]`，看起来像"查询失败"，其实是用户自己停的。
 *
 * 这里做两件事：
 * 1. `throwIfAborted`/`readableError` 把任何中止（含对象 reason）翻成可读错误；
 * 2. `readableError` 兜住"非 Error 被抛出"的其它情况（打印对象内容而不是 [object Object]）。
 */

/** 中止类错误统一用这个码，调用方据此不计失败、不计白跑。 */
export const ABORTED_CODE = "GEA_TURN_ABORTED";

const ABORT_MESSAGE = "已中止：这一轮被停止（用户停止或身份失效），本次调用没有完成。";

/** 值看起来是不是"中止原因"：dsh 用 `{kind:"aborted",…}`。 */
function looksAborted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && /abort/i.test(kind);
}

/** 中止原因压成一小段诊断文本（不含业务数据；dsh 的形状是 kind/reason.kind）。 */
function abortDetail(reason: unknown): string {
  if (reason === undefined) return "";
  if (typeof reason === "string") return reason.slice(0, 80);
  if (looksAborted(reason)) {
    const inner = (reason as { reason?: unknown }).reason;
    const innerKind =
      inner && typeof inner === "object"
        ? (inner as { kind?: unknown }).kind
        : inner;
    return typeof innerKind === "string" ? innerKind.slice(0, 40) : "";
  }
  return "";
}

/** 这个值是不是中止（Error 的 name、DOMException、或 dsh 的对象 reason）。 */
export function isAbortError(value: unknown): boolean {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return (
      code === ABORTED_CODE ||
      value.name === "AbortError" ||
      value.name === "TimeoutError"
    );
  }
  return looksAborted(value);
}

/**
 * 把任意被抛出的值翻成可读 Error：
 * - Error 原样返回（保留 message 与 code 等属性）；
 * - 中止原因 → `GEA_TURN_ABORTED: 已中止…`；
 * - 普通对象 → 用 message/code 拼，拼不出就带一小段 JSON，绝不出现 `[object Object]`。
 */
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

/** 非 Error 值的可读文本：对象取 JSON（截断），其余 String。 */
export function describe(value: unknown): string {
  if (typeof value === "string") return value.length > 300 ? value.slice(0, 300) : value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string" && text !== "{}") return text.slice(0, 300);
  } catch {
    // 循环引用之类：退回 String。
  }
  return String(value);
}

/** `signal.throwIfAborted()` 的可读版：中止就抛可读 Error，不抛原始 reason 对象。 */
export function throwIfAborted(signal: AbortSignal | undefined | null): void {
  if (!signal?.aborted) return;
  throw readableError(signal.reason ?? { kind: "aborted" });
}

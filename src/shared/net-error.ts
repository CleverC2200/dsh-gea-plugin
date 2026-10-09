/**
 * 把 "fetch failed" 翻成人能看懂的错。
 *
 * 线上现象（2026-09-23 21:12，session-764c86e2）：模型流式请求中断，界面只显示
 * `本轮运行失败 fetch failed  UNKNOWN`。原因是 Node/undici 的 `fetch` 失败时抛的是一个
 * 只有 "fetch failed" 的 `TypeError`，真实原因（ECONNRESET / ENOTFOUND / 连接超时…）
 * 藏在 `error.cause` 里，宿主没读出来，框架也不知道该给什么 code，就标成 UNKNOWN。
 *
 * 这里统一做两件事：
 * 1. 把 `cause` 里的 code / hostname / syscall 挖出来，拼成可读原因；
 * 2. 给错误挂上 `code`，界面与日志不再显示 UNKNOWN。
 */
import { isAbortError, readableError } from "./abort.ts";

/** 网络层失败：连不上、连接被重置、DNS 失败等。 */
export const NETWORK_FAILURE_CODE = "GEA_NETWORK_FAILED";
/** 超时：请求发出去了但没在预算内回来。 */
export const NETWORK_TIMEOUT_CODE = "GEA_NETWORK_TIMEOUT";

type CauseLike = {
  code?: unknown;
  message?: unknown;
  syscall?: unknown;
  hostname?: unknown;
  address?: unknown;
  port?: unknown;
  errors?: unknown;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** 一个 cause（可能是 AggregateError，多个地址各一条）压成一句话。 */
function causeOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause as CauseLike | undefined;
  if (!cause || typeof cause !== "object") return undefined;
  const parts: string[] = [];
  const code = text(cause.code);
  if (code) parts.push(code);
  const syscall = text(cause.syscall);
  const host = text(cause.hostname) ?? text(cause.address);
  if (syscall || host)
    parts.push(`(${[syscall, host].filter(Boolean).join(" ")}${text(cause.port) ? ":" + text(cause.port) : ""})`);
  if (!code) {
    const message = text(cause.message);
    if (message) parts.push(message);
  }
  if (Array.isArray(cause.errors)) {
    const nested = cause.errors
      .map((entry) => text((entry as CauseLike)?.code) ?? text((entry as CauseLike)?.message))
      .filter((value): value is string => Boolean(value));
    if (nested.length > 0) parts.push(`[${[...new Set(nested)].join(", ")}]`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** 超时判定：AbortSignal.timeout 产生的是 TimeoutError。 */
function isTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const reason = (error as { cause?: unknown })?.cause;
  return reason instanceof Error && reason.name === "TimeoutError";
}

/**
 * fetch 失败 → 可读错误。
 *
 * @param error 捕获到的原始错误。
 * @param context `what` 是"在连什么"（会打印给用户/日志），`stage` 是阶段说明，
 *   `timeoutMs` 给了就在超时时写进文案。
 * 已经是带 code 的错误、或用户中止，原样返回（不重复包装）。
 */
export function networkError(
  error: unknown,
  context: { what: string; stage?: string; timeoutMs?: number; timeoutScope?: "model-total" },
): Error {
  // 中止（用户点停止）走既有口径；已有 code 的错（GEA_MODEL_HTTP_500 这类）保持原样。
  // dsh 中止时 fetch 直接以 signal.reason 为拒绝原因；有的实现会把它包进 cause，两种都认。
  const abortish = isAbortError(error)
    ? error
    : isAbortError((error as { cause?: unknown })?.cause)
      ? (error as { cause?: unknown }).cause
      : undefined;
  if (abortish !== undefined && !isTimeout(abortish)) return readableError(abortish);
  const coded = (error as { code?: unknown })?.code;
  if (typeof coded === "string" && coded.trim() && !/^ERR_/.test(coded))
    return readableError(error);

  const stage = context.stage ? `${context.stage}阶段` : "";
  const detail = causeOf(error) ?? (error instanceof Error ? error.message : String(error));
  if (isTimeout(error) && context.timeoutScope === "model-total")
    return Object.assign(
      new Error(
        `${NETWORK_TIMEOUT_CODE}: ${context.what}请求达到总时限${context.timeoutMs ? `（${Math.round(context.timeoutMs / 1000)} 秒）` : ""}，本轮未完成。` +
        (context.stage === "流式读取" ? "已收到响应，但未在总时限内生成完毕；这不代表连续无输出。" : "等待模型响应时超时。") +
        "仅凭超时不能确定是模型生成、网关还是网络耗时；请结合请求日志核对。",
      ),
      { code: NETWORK_TIMEOUT_CODE, cause: error },
    );
  if (isTimeout(error))
    return Object.assign(
      new Error(
        `${NETWORK_TIMEOUT_CODE}: 连接 ${context.what} 时${context.stage ? context.stage : "请求"}超时${
          context.timeoutMs ? `（上限 ${Math.round(context.timeoutMs / 1000)} 秒）` : ""
        }。这不是参数问题：稍后重试一次；持续超时请检查到该地址的网络或代理。`,
      ),
      { code: NETWORK_TIMEOUT_CODE, cause: error },
    );
  return Object.assign(
    new Error(
      `${NETWORK_FAILURE_CODE}: 连不上 ${context.what}（${stage ? stage + "失败" : "失败"}：${detail}）。` +
        "这通常是网络/链路抖动，重问一次即可；若持续出现，检查到该地址的网络或代理。",
    ),
    { code: NETWORK_FAILURE_CODE, cause: error },
  );
}

import { isAbortError, readableError } from "./abort.ts";

export const NETWORK_FAILURE_CODE = "GEA_NETWORK_FAILED";

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

function causeOf(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause as CauseLike | undefined;
  if (!cause || typeof cause !== "object") return undefined;
  const parts: string[] = [];
  const code = text(cause.code);
  if (code) parts.push(code);
  const syscall = text(cause.syscall);
  const host = text(cause.hostname) ?? text(cause.address);
  if (syscall || host)
    parts.push(
      `(${[syscall, host].filter(Boolean).join(" ")}${text(cause.port) ? ":" + text(cause.port) : ""})`,
    );
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

function isTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const reason = (error as { cause?: unknown })?.cause;
  return reason instanceof Error && reason.name === "TimeoutError";
}

export function networkError(
  error: unknown,
  context: { what: string; stage?: string; timeoutMs?: number; timeoutScope?: "model-idle" },
): Error {
  const abortish = isAbortError(error)
    ? error
    : isAbortError((error as { cause?: unknown })?.cause)
      ? (error as { cause?: unknown }).cause
      : undefined;
  if (abortish !== undefined && !isTimeout(abortish)) return readableError(abortish);
  const coded = (error as { code?: unknown })?.code;
  if (typeof coded === "string" && coded.trim() && !coded.startsWith("ERR_"))
    return readableError(error);

  const stage = context.stage ? `${context.stage}阶段` : "";
  const detail = causeOf(error) ?? (error instanceof Error ? error.message : String(error));
  if (isTimeout(error) && context.timeoutScope === "model-idle")
    return Object.assign(
      new Error(
        `${NETWORK_TIMEOUT_CODE}: ${context.what}连续${context.timeoutMs ? ` ${Math.round(context.timeoutMs / 1000)} 秒` : ""}未收到新的模型事件或心跳，本轮未完成。` +
          "这是空闲超时，持续输出和心跳会续期。仅凭超时不能确定模型、网关或网络原因，请结合请求日志核对。",
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

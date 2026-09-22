/**
 * RPC 错误信封：让失败"说得出来"。
 *
 * 之前只有 `GeaResponseError` 带得出原因，其它错误（业务查询的 GeaSqlError、
 * 页面的 INVALID_QUERY、待登录提示）一律被压成 `GEA_REQUEST_FAILED`，模型和用户
 * 都拿不到"为什么失败、该怎么改"，于是只看得到一句裸代号。
 *
 * 规则：
 * - 带 `code` 的错误：保留它的错误码，并把可读原因带出来；
 * - 错误信息本身就是大写错误码（例如 `LOGIN_REQUIRED`）：原样返回；
 * - 其它错误：用 `GEA_REQUEST_FAILED` 兜底，但仍带可读原因（做过本机路径、
 *   凭据、超长文本的过滤，内部细节不外泄）。
 */
import { GeaResponseError } from "../shared/gea-error.js";

export type ErrorEnvelope = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
};

const CODE_PATTERN = /^[A-Z][A-Z_0-9]{2,}$/;
/** 不给模型/用户看的东西：本机路径、凭据、超长文本。 */
const UNSAFE = /[\\/]|node_modules|file:|https?:\/\/|Bearer\s|eyJ[A-Za-z0-9_-]{10}/;

/** 只保留"能念给用户听"的短句，别的一律不要。 */
export function readableMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 200 || UNSAFE.test(text)) return undefined;
  return text;
}

/** 把任意错误翻成统一的 `{code, message}` 信封。 */
export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof GeaResponseError)
    return {
      code: error.code,
      message: readableMessage(error.message) ?? error.code,
      details: error.details,
    };
  const candidate = error as
    | { code?: unknown; message?: unknown; retryable?: unknown }
    | null
    | undefined;
  const message =
    typeof candidate?.message === "string"
      ? candidate.message
      : typeof error === "string"
        ? error
        : "";
  const code =
    typeof candidate?.code === "string" && CODE_PATTERN.test(candidate.code)
      ? candidate.code
      : CODE_PATTERN.test(message)
        ? message
        : "GEA_REQUEST_FAILED";
  return {
    code,
    message: readableMessage(message) ?? code,
    ...(candidate?.retryable === true ? { retryable: true } : {}),
  };
}

/** Model HTTP failures retain their protocol status and safe gateway diagnostics. */
import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError } from "@deepseek-ai/dsh-llm";
import { GeaResponseError } from "./gea-error.js";

export async function modelHttpError(
  response: Response,
  consumer: string,
  operation: "模型列表读取" | "模型推理",
  secrets: string[],
): Promise<Error> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    // A proxy's HTML error is not a gateway business message.
  }
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const nested = "error" in envelope ? envelope.error : undefined;
  const body = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : envelope;
  const field = (key: string): unknown => (key in body ? Reflect.get(body, key) : undefined);
  const safe = new GeaResponseError(
    response.status,
    {
      message: field("message"),
      errorCode: field("code") ?? field("errorCode"),
      requestId: field("requestId"),
      traceId: field("traceId"),
    },
    secrets,
  );
  const contextOverflow =
    operation === "模型推理" &&
    [400, 413, 422].includes(response.status) &&
    isContextWindowExceededError(
      [field("code"), field("errorCode"), field("type"), field("message")]
        .filter((value) => typeof value === "string")
        .join(" "),
    );
  const code = contextOverflow ? CONTEXT_WINDOW_EXCEEDED_CODE : `GEA_MODEL_HTTP_${response.status}`;
  const action =
    response.status === 403
      ? `当前 Agent ${consumer} 的请求被拒绝。请核对该 Agent 的模型访问授权，本轮停止，不自动重试或切换身份。`
      : response.status === 401
        ? "模型凭据未通过认证，请重新登录 GEA。"
        : contextOverflow
          ? "模型上下文超限，由 Core 按现有压缩策略决定能否恢复。"
          : "模型网关已返回失败响应，请按状态码和原始错误核对；本轮停止，不自动重试。";
  const details = Object.entries(safe.details)
    .filter(([key]) => key !== "httpStatus")
    .map(([key, value]) => `${key}=${value}`)
    .join("，");
  return Object.assign(
    Error(`${code}: ${operation}失败。${safe.message}。${action}${details ? " " + details : ""}`),
    { code, details: safe.details },
  );
}

import { CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError } from "@deepseek-ai/dsh-llm";
import { GeaResponseError } from "./gea-error.js";
import { modelResponseDetails } from "./model-failure.ts";

export async function modelHttpError(
  response: Response,
  consumer: string,
  operation: "模型列表读取" | "模型推理",
  secrets: string[],
  received?: (raw: unknown) => void,
): Promise<Error> {
  let raw: unknown;
  try {
    const text = await response.text();
    try {
      received?.(text);
    } catch {}
    raw = JSON.parse(text);
  } catch {}
  const envelope = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const nested = "error" in envelope ? envelope.error : undefined;
  const body = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : envelope;
  const field = (key: string): unknown => (key in body ? Reflect.get(body, key) : undefined);
  const responseDetails = modelResponseDetails(response.headers, secrets);
  const safe = new GeaResponseError(
    response.status,
    {
      message: field("message"),
      errorCode: field("code") ?? field("errorCode"),
      requestId: responseDetails.requestId ?? field("requestId"),
      traceId: responseDetails.traceId ?? field("traceId"),
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
      ? `当前 Agent ${consumer} 的请求被拒绝。请联系管理员开通该 Agent 的模型访问权限，本轮停止，不自动重试或切换身份。`
      : response.status === 401
        ? "模型凭据未通过认证，请重新登录 GEA。"
        : contextOverflow
          ? "模型上下文超限，由 Core 按现有压缩策略决定能否恢复。"
          : operation === "模型推理"
            ? "本次模型请求未完成，由 Core 按错误类型决定是否恢复。"
            : "模型目录读取失败，请保留请求标识排查。";
  const details = Object.entries(safe.details)
    .filter(([key]) => key !== "httpStatus")
    .map(([key, value]) => `${key}=${value}`)
    .join("，");
  return Object.assign(
    Error(`${code}: ${operation}失败。${safe.message}。${action}${details ? " " + details : ""}`),
    {
      code,
      details: {
        ...safe.details,
        providerRetryAfterMs: responseDetails.providerRetryAfterMs,
      },
    },
  );
}

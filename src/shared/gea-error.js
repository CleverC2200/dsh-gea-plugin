/** GEA 错误只保留有界的状态、追踪字段和截断消息，凭证、Bearer 和完整响应体一律脱敏。 */
export class GeaResponseError extends Error {
  constructor(status, data, secrets = []) {
    const code = `GEA_HTTP_${status}`;
    const clean = (value) => {
      if (typeof value !== "string") return undefined;
      let text = value;
      for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, "[REDACTED]");
      return text
        .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
        .split("")
        .map((char) => (char.charCodeAt(0) < 32 ? " " : char))
        .join("")
        .slice(0, 350);
    };
    const message = clean(data?.message);
    super(message ? `${code}：${message}` : code);
    this.code = code;
    this.details = Object.fromEntries(
      Object.entries({
        httpStatus: status,
        upstreamCode: clean(data?.errorCode),
        category: clean(data?.category),
        retryable: typeof data?.retryable === "boolean" ? data.retryable : undefined,
        requestId: clean(data?.requestId),
        traceId: clean(data?.traceId),
        failure: (() => {
          const value = data?.failure ?? data?.result?.failure ?? data?.data?.failure;
          if (!value || typeof value !== "object") return undefined;
          return Object.fromEntries(
            ["stage", "reasonCode", "statementPath", "target", "suggestedAction"]
              .map((key) => [key, clean(value[key])])
              .filter(([, value]) => value !== undefined),
          );
        })(),
      }).filter(([, value]) => value !== undefined),
    );
  }
}

/** 只从 JSON 错误提取诊断字段；HTML 不展示给用户。 */
export async function geaResponseError(response, secrets) {
  let data;
  try {
    data = await response.json();
  } catch {
    /* 非 JSON Gateway 响应没有结构化 GEA 诊断信息。 */
  }
  return new GeaResponseError(response.status, data, secrets);
}

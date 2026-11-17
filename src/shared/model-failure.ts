export interface ModelFailureDetails {
  httpStatus?: number;
  upstreamCode?: string;
  requestId?: string;
  traceId?: string;
  providerRetryAfterMs?: number;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

export function modelCorrelationId(
  value: unknown,
  secrets: readonly string[] = [],
): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) return undefined;
  return secrets.some((secret) => secret && value.includes(secret)) ? undefined : value;
}

export function modelResponseDetails(
  headers: Headers,
  secrets: readonly string[],
): ModelFailureDetails {
  const raw = headers.get("Retry-After");
  const delay =
    raw === null
      ? NaN
      : /^\d+(?:\.\d+)?$/.test(raw)
        ? Number(raw) * 1000
        : Date.parse(raw) - Date.now();
  const details: ModelFailureDetails = {};
  const requestId = modelCorrelationId(headers.get("X-Request-Id"), secrets);
  const traceId = modelCorrelationId(headers.get("X-Trace-Id"), secrets);
  if (requestId) details.requestId = requestId;
  if (traceId) details.traceId = traceId;
  if (Number.isFinite(delay) && delay > 0) details.providerRetryAfterMs = delay;
  return details;
}

export function modelFailure(error: Error): {
  code: string;
  originalCode: string;
  details: ModelFailureDetails;
} {
  const original = field(error, "code");
  const originalCode =
    typeof original === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(original)
      ? original
      : "NETWORK";
  const raw = field(error, "details");
  const status = field(raw, "httpStatus");
  const upstream = field(raw, "upstreamCode");
  const delay = field(raw, "providerRetryAfterMs");
  const details: ModelFailureDetails = {};
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
    details.httpStatus = status;
  if (typeof upstream === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(upstream))
    details.upstreamCode = upstream;
  const requestId = modelCorrelationId(field(raw, "requestId"));
  const traceId = modelCorrelationId(field(raw, "traceId"));
  if (requestId) details.requestId = requestId;
  if (traceId) details.traceId = traceId;
  if (typeof delay === "number" && Number.isFinite(delay) && delay > 0)
    details.providerRetryAfterMs = delay;
  let code = originalCode;
  const permanent = new Set([
    "MODEL_UPSTREAM_REJECTED",
    "invalid_api_key",
    "permission_denied",
    "invalid_request",
    "invalid_tool_message",
  ]);
  const httpStatus = details.httpStatus;
  const permanentStatus =
    httpStatus !== undefined &&
    ((httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 429) ||
      httpStatus === 501 ||
      httpStatus === 505);
  if (!permanentStatus && !permanent.has(details.upstreamCode ?? "")) {
    switch (details.upstreamCode) {
      case "MODEL_UPSTREAM_UNAVAILABLE":
      case "model_gateway_unavailable":
        code = "SERVER";
        break;
      case "MODEL_UPSTREAM_TIMEOUT":
      case "MODEL_UPSTREAM_CONNECT_TIMEOUT":
        code = "TIMEOUT";
        break;
      case "MODEL_UPSTREAM_RATE_LIMITED":
      case "rate_limit_exceeded":
      case "concurrency_limit_exceeded":
        code = "RATE_LIMIT";
        break;
      default:
        if ([500, 502, 503].includes(details.httpStatus ?? 0)) code = "SERVER";
        else if ([408, 504].includes(details.httpStatus ?? 0)) code = "TIMEOUT";
        else if (details.httpStatus === 429) code = "RATE_LIMIT";
    }
  }
  if (originalCode === "GEA_NETWORK_TIMEOUT") code = "TIMEOUT";
  const transportCodes = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ]);
  const classify = (cause: unknown, depth = 0): "TIMEOUT" | "TRANSPORT" | undefined => {
    if (!cause || depth > 4) return undefined;
    const errors = field(cause, "errors");
    if (Array.isArray(errors) && errors.length) {
      const failures = errors.map((entry) => classify(entry, depth + 1));
      if (failures.some((failure) => failure === undefined)) return undefined;
      return failures.every((failure) => failure === "TIMEOUT") ? "TIMEOUT" : "TRANSPORT";
    }
    const causeCode = String(field(cause, "code"));
    if (transportCodes.has(causeCode))
      return [
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(causeCode)
        ? "TIMEOUT"
        : "TRANSPORT";
    return classify(field(cause, "cause"), depth + 1);
  };
  if (originalCode === "GEA_NETWORK_FAILED" || transportCodes.has(originalCode))
    code = classify(error) ?? code;
  return { code, originalCode, details };
}

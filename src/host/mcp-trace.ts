/** Only these diagnostic headers may enter model-visible knowledge results. */
export type GatewayTrace = Partial<Record<"requestId" | "traceId" | "auditId", string>>;

export function readMcpTrace(headers: Headers): GatewayTrace {
  return Object.fromEntries(
    [
      ["requestId", "x-request-id"],
      ["traceId", "x-trace-id"],
      ["auditId", "x-audit-id"],
    ].flatMap(([key, header]) => {
      const value = headers.get(header);
      return value && /^[A-Za-z0-9._:-]{1,200}$/.test(value) ? [[key, value]] : [];
    }),
  );
}

export function withMcpTrace(error: Error, gatewayTrace: GatewayTrace): Error {
  const ids = Object.entries(gatewayTrace);
  if (!ids.length) return error;
  error.message += " " + ids.map(([key, value]) => `gateway.${key}=${value}`).join(" ");
  return Object.assign(error, { gatewayTrace });
}

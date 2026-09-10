/** Safe, bounded diagnostics for GEA responses; never return response bodies. */
export class GeaResponseError extends Error {
  constructor(status, data, secrets = []) {
    const code = `GEA_HTTP_${status}`;
    const clean = value => {
      if (typeof value !== 'string') return undefined;
      let text = value;
      for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, '[REDACTED]');
      return text.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/[\u0000-\u001f]/g, ' ').slice(0, 350);
    };
    const message = clean(data?.message);
    super(message ? `${code}：${message}` : code);
    this.code = code;
    this.details = Object.fromEntries(Object.entries({
      httpStatus: status,
      upstreamCode: clean(data?.errorCode),
      category: clean(data?.category),
      requestId: clean(data?.requestId),
      traceId: clean(data?.traceId),
    }).filter(([, value]) => value !== undefined));
  }
}

/** Extract only diagnostic fields from a JSON error; HTML is not shown to users. */
export async function geaResponseError(response, secrets) {
  let data;
  try { data = await response.json(); } catch { /* A non-JSON gateway response has no structured GEA diagnostic. */ }
  return new GeaResponseError(response.status, data, secrets);
}

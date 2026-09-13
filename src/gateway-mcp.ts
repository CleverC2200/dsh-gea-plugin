/** Login-owned GEA gateway capability. Secrets never leave the fetch closure. */
import { randomUUID } from "node:crypto";

/** Prepare one authorized business session; transport session negotiation stays with MCP SDK. */
export async function prepareGatewayMcp(
  base: string,
  auth: { token: string; tenantId: string },
  consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string },
  identity: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url: string; fetch: typeof fetch }> {
  if (
    !["AGENT", "CLIENT_APP"].includes(consumer.consumerType) ||
    !consumer.consumerCode.trim()
  )
    throw new Error("GEA_MCP_CONSUMER_REQUIRED");
  identity.throwIfAborted();
  const response = await fetchImpl(base + "/ai/gateway/session", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([identity, AbortSignal.timeout(timeoutMs)]),
    headers: {
      "Content-Type": "application/json",
      "X-Access-Token": auth.token,
      "X-Tenant-Id": auth.tenantId,
    },
    body: JSON.stringify({
      ...consumer,
      conversationId: randomUUID(),
      requestId: randomUUID(),
      channel: "MCP_CLIENT",
    }),
  });
  if (!response.ok) throw new Error("GEA_MCP_SESSION_HTTP_" + response.status);
  const payload = await response.json();
  identity.throwIfAborted();
  const result = payload?.result;
  const context = result?.gatewayContext;
  const nonempty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (
    payload?.success !== true ||
    result?.accessDecision?.allowed !== true ||
    !nonempty(context?.sessionId) ||
    !nonempty(context?.conversationId) ||
    !nonempty(result?.delegationToken) ||
    context?.consumerType !== consumer.consumerType ||
    context?.consumerCode !== consumer.consumerCode
  )
    throw new Error("GEA_MCP_SESSION_REJECTED");
  const meta = {
    sessionId: context.sessionId,
    conversationId: context.conversationId,
    delegationToken: result.delegationToken,
    ...(consumer.consumerType === "AGENT"
      ? { agentCode: consumer.consumerCode }
      : {}),
  };
  const url = base + "/ai/gateway/mcp/proxy/mcp";
  const gatewayFetch: typeof fetch = async (input, init) => {
    identity.throwIfAborted();
    const target = input instanceof Request ? input.url : String(input);
    if (target !== url) throw new Error("GEA_MCP_ENDPOINT_REJECTED");
    let body = init?.body;
    if (body !== undefined && body !== null) {
      if (typeof body !== "string") throw new Error("GEA_MCP_BODY_INVALID");
      const message = JSON.parse(body);
      if (Array.isArray(message) || !message || typeof message !== "object")
        throw new Error("GEA_MCP_BODY_INVALID");
      if (
        [
          "tools/list",
          "tools/call",
          "resources/list",
          "resources/read",
        ].includes(message.method)
      ) {
        // Replace caller-supplied identity entirely; never insert it in arguments.
        message.params = { ...message.params, _meta: meta };
      }
      body = JSON.stringify(message);
    }
    const res = await fetchImpl(url, {
      ...init,
      body,
      redirect: "error",
      signal: AbortSignal.any([
        identity,
        ...(init?.signal ? [init.signal] : []),
        AbortSignal.timeout(timeoutMs),
      ]),
    });
    identity.throwIfAborted();
    return res;
  };
  return { url, fetch: gatewayFetch };
}

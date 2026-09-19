/** Login-owned GEA gateway capability. Secrets never leave the fetch closure. */
import { randomUUID } from "node:crypto";


const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Prepare one authorized business session; transport session negotiation stays with MCP SDK. */
export async function prepareGatewayLaunch(
  base: string,
  auth: { token: string; tenantId: string },
  consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string },
  identity: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  conversationId: string = randomUUID(),
) {
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
      conversationId,
      requestId: randomUUID(),
      channel: "MCP_CLIENT",
    }),
  });
  if (!response.ok) throw new Error("GEA_MCP_SESSION_HTTP_" + response.status);
  const payload = await response.json();
  identity.throwIfAborted();
  const result = payload?.result;
  const context = result?.gatewayContext;
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
  return meta;
}

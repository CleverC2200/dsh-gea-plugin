/** Login-owned GEA gateway capability. Secrets never leave the fetch closure. */
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";

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
  const routes = new Map<string, string>();
  const gatewayFetch: typeof fetch = async (input, init) => {
    identity.throwIfAborted();
    const target = input instanceof Request ? input.url : String(input);
    if (target !== url) throw new Error("GEA_MCP_ENDPOINT_REJECTED");
    let body = init?.body;
    let discovery: { id: unknown; firstPage: boolean } | undefined;
    if (body !== undefined && body !== null) {
      if (typeof body !== "string") throw new Error("GEA_MCP_BODY_INVALID");
      const message = JSON.parse(body);
      if (Array.isArray(message) || !message || typeof message !== "object")
        throw new Error("GEA_MCP_BODY_INVALID");
      if (message.method === "tools/list")
        discovery = { id: message.id, firstPage: !message.params?.cursor };
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
        if (message.method === "tools/call") {
          const mcpCode = routes.get(message.params.name);
          if (!mcpCode) throw new Error("GEA_MCP_TOOL_ROUTE_REQUIRED");
          message.params._meta = { ...meta, mcpCode };
        }
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
    if (discovery && res.ok) {
      const text = await res.clone().text();
      identity.throwIfAborted();
      const messages: unknown[] = [];
      if (res.headers.get("content-type")?.includes("text/event-stream")) {
        createParser({
          onEvent: (event) => messages.push(JSON.parse(event.data)),
        }).feed(text);
      } else {
        messages.push(JSON.parse(text));
      }
      for (const value of messages) {
        if (!value || typeof value !== "object") continue;
        const reply = value as { id?: unknown; result?: { tools?: unknown } };
        if (reply.id !== discovery.id || !Array.isArray(reply.result?.tools))
          continue;
        const next = discovery.firstPage
          ? new Map<string, string>()
          : new Map(routes);
        for (const tool of reply.result.tools) {
          const code = tool?._meta?.sourceCode;
          if (!nonempty(tool?.name) || !nonempty(code))
            throw new Error("GEA_MCP_TOOL_ROUTE_INVALID");
          if (next.has(tool.name) && next.get(tool.name) !== code)
            throw new Error("GEA_MCP_TOOL_ROUTE_AMBIGUOUS");
          next.set(tool.name, code);
        }
        routes.clear();
        for (const [name, code] of next) routes.set(name, code);
      }
    }
    return res;
  };
  return { url, fetch: gatewayFetch };
}

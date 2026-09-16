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
  let initializeBody: string | undefined;
  let transportSession: string | undefined;
  let reconnect: Promise<void> | undefined;
  const send = (init: RequestInit) => fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([
      identity,
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]),
  });
  const restore = async (headers: Headers) => {
    headers.delete("MCP-Session-Id");
    const response = await send({ method: "POST", headers, body: initializeBody });
    identity.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GEA_MCP_RECONNECT_HTTP_${response.status}`);
    }
    const session = response.headers.get("MCP-Session-Id");
    const result = await response.json();
    if (!session || result.error || result.result?.protocolVersion !== headers.get("MCP-Protocol-Version"))
      throw new Error("GEA_MCP_RECONNECT_REJECTED: 网关协议已变化，请重新登录建立连接。");
    headers.set("MCP-Session-Id", session);
    const ready = await send({ method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await ready.body?.cancel();
    identity.throwIfAborted();
    if (!ready.ok) throw new Error(`GEA_MCP_RECONNECT_HTTP_${ready.status}`);
    transportSession = session;
  };
  const gatewayFetch: typeof fetch = async (input, init) => {
    identity.throwIfAborted();
    const target = input instanceof Request ? input.url : String(input);
    if (target !== url) throw new Error("GEA_MCP_ENDPOINT_REJECTED");
    let body = init?.body;
    let method: string | undefined;
    if (body !== undefined && body !== null) {
      if (typeof body !== "string") throw new Error("GEA_MCP_BODY_INVALID");
      const message = JSON.parse(body);
      if (Array.isArray(message) || !message || typeof message !== "object")
        throw new Error("GEA_MCP_BODY_INVALID");
      method = message.method;
      if (
        message.method === "resources/read" &&
        typeof message.params?.uri === "string" &&
        /^file:/i.test(message.params.uri.trim())
      )
        throw new Error(
          "GEA_MCP_LOCAL_RESOURCE: 本地 Skill 参考文件请使用 gea_skill_reference_read，传入技能名和正文链接的相对路径；MCP 只读取该服务返回的资源 URI。",
        );
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
    const headers = new Headers(init?.headers);
    if (transportSession && method !== "initialize") headers.set("MCP-Session-Id", transportSession);
    const sentSession = headers.get("MCP-Session-Id");
    let res = await send({ ...init, headers, body });
    if (method === "initialize" && res.ok) {
      initializeBody = body as string;
      transportSession = res.headers.get("MCP-Session-Id") ?? undefined;
    }
    // A transport 404 rejects the request before business execution. Recover only
    // this case, once; never retry ambiguous network failures or business errors.
    if (res.status === 404 && init?.method === "POST" && method !== "initialize" && sentSession && initializeBody) {
      await res.body?.cancel();
      if (sentSession === transportSession) {
        reconnect ??= restore(new Headers(headers)).finally(() => { reconnect = undefined; });
        await reconnect;
      }
      identity.throwIfAborted();
      init?.signal?.throwIfAborted();
      headers.set("MCP-Session-Id", transportSession!);
      res = await send({ ...init, headers, body });
    }
    identity.throwIfAborted();
    if (!res.ok && init?.method === "POST") {
      await res.body?.cancel();
      throw new Error(`GEA_MCP_HTTP_${res.status}: 网关请求被拒绝，请检查连接或重新登录；不要原样重复调用。`);
    }
    return res;
  };
  return { url, fetch: gatewayFetch };
}

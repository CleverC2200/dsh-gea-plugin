/** 绑定登录身份的 GEA Gateway 能力；密钥不会离开 Fetch 闭包。 */
import { prepareGatewaySession } from "./gateway-session.ts";
import { createParser } from "eventsource-parser";
import { readableError, throwIfAborted } from "../shared/abort.ts";
import { parseAuthorizedResources, type ResourceReader } from "./authorized-resources.ts";
export type GatewayMcpTransport = {
  url: string;
  fetch: typeof fetch;
  authorizedResources: ResourceReader;
};

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * `Retry-After` 的两种形态都认：秒数（`2`）和 HTTP 日期。
 * 拿不到就返回 undefined——那就只说"限流了"，不编一个等待时间。
 */
function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("Retry-After")?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/** 先用当前登录身份申请 Gateway 上下文，再封装只带该上下文的 MCP Fetch 能力；传输会话协商仍由 MCP SDK 负责。 */
export async function prepareGatewayMcp(
  base: string,
  auth: { token: string; tenantId: string },
  consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string },
  identity: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  routing: { cubeMcpCode?: string } = {},
): Promise<GatewayMcpTransport> {
  const meta = await prepareGatewaySession(base, auth, consumer, identity, timeoutMs, fetchImpl);
  return gatewayMcpTransport(base, meta, identity, timeoutMs, fetchImpl, routing);
}
export function gatewayMcpTransport(
  base: string,
  meta: { sessionId: string; conversationId: string; delegationToken: string; agentCode?: string },
  identity: AbortSignal,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  routing: { cubeMcpCode?: string } = {},
): GatewayMcpTransport {
  if (routing.cubeMcpCode !== undefined && !nonempty(routing.cubeMcpCode))
    throw Error("GEA_MCP_CUBE_SOURCE_INVALID");
  const url = base + "/ai/gateway/mcp/proxy/mcp";
  const routes = new Map<string, string>();
  const artifactRoutes = new Map<string, string>();
  let initializeBody: string | undefined;
  let transportSession: string | undefined;
  let reconnect: Promise<void> | undefined;
  /**
   * 中止（用户点停止）时 fetch 以 `signal.reason` 为拒绝原因，而 dsh 的 reason 是对象
   * （`{kind:"aborted",reason:{kind:"user"}}`）——原样抛出去界面上就是 `Error: [object Object]`。
   * 传输层是最早的边界，在这里统一翻成可读错误。
   */
  const send = async (init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.any([
          identity,
          ...(init.signal ? [init.signal] : []),
          AbortSignal.timeout(timeoutMs),
        ]),
      });
    } catch (error) {
      throw readableError(error);
    }
  };
  const restore = async (headers: Headers) => {
    // 重新初始化只恢复传输会话，不重新申请业务权限，也不接受调用方自带身份。
    headers.delete("MCP-Session-Id");
    const response = await send({ method: "POST", headers, body: initializeBody });
    throwIfAborted(identity);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GEA_MCP_RECONNECT_HTTP_${response.status}`);
    }
    const session = response.headers.get("MCP-Session-Id");
    const result = await response.json();
    if (
      !session ||
      result.error ||
      result.result?.protocolVersion !== headers.get("MCP-Protocol-Version")
    )
      throw new Error("GEA_MCP_RECONNECT_REJECTED: 网关协议已变化，请重新登录建立连接。");
    headers.set("MCP-Session-Id", session);
    const ready = await send({
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await ready.body?.cancel();
    throwIfAborted(identity);
    if (!ready.ok) throw new Error(`GEA_MCP_RECONNECT_HTTP_${ready.status}`);
    transportSession = session;
  };
  const gatewayFetch: typeof fetch = async (input, init) => {
    // 仅把 MCP 方法名映射为服务端分配的路由码；调用方不能直接指定 GEA 路由。
    throwIfAborted(identity);
    const target = input instanceof Request ? input.url : String(input);
    if (target !== url) throw new Error("GEA_MCP_ENDPOINT_REJECTED");
    let body = init?.body;
    let method: string | undefined;
    let discovery: { id: unknown; firstPage: boolean } | undefined;
    let invocation: { id: unknown; code: string } | undefined;
    if (body !== undefined && body !== null) {
      if (typeof body !== "string") throw new Error("GEA_MCP_BODY_INVALID");
      const message = JSON.parse(body);
      if (Array.isArray(message) || !message || typeof message !== "object")
        throw new Error("GEA_MCP_BODY_INVALID");
      method = message.method;
      if (message.method === "tools/list")
        discovery = { id: message.id, firstPage: !message.params?.cursor };
      if (
        message.method === "resources/read" &&
        typeof message.params?.uri === "string" &&
        /^file:/i.test(message.params.uri.trim())
      )
        throw new Error(
          "GEA_MCP_LOCAL_RESOURCE: 本地 Skill 参考文件请使用 skill_reference_read，传入技能名和正文链接的相对路径；MCP 只读取该服务返回的资源 URI。",
        );
      if (
        ["tools/list", "tools/call", "resources/list", "resources/read"].includes(message.method)
      ) {
        // 完全替换调用方提供的身份；绝不把它写入业务参数。
        message.params = { ...message.params, _meta: meta };
        if (message.method === "tools/call") {
          const mcpCode = routes.get(message.params.name);
          if (!mcpCode) throw new Error("GEA_MCP_TOOL_ROUTE_REQUIRED");
          message.params._meta = { ...meta, mcpCode };
          invocation = { id: message.id, code: mcpCode };
        } else if (message.method === "resources/read") {
          const code = artifactRoutes.get(message.params.uri);
          if (code) message.params._meta = { ...meta, mcpCode: code };
          else if (
            routing.cubeMcpCode &&
            String(message.params.uri).startsWith("data-artifact://gateway/")
          )
            throw Error("GEA_MCP_RESOURCE_ROUTE_REQUIRED");
        }
      }
      body = JSON.stringify(message);
    }
    const headers = new Headers(init?.headers);
    if (transportSession && method !== "initialize")
      headers.set("MCP-Session-Id", transportSession);
    const sentSession = headers.get("MCP-Session-Id");
    let res = await send({ ...init, headers, body });
    if (method === "initialize" && res.ok) {
      initializeBody = body as string;
      transportSession = res.headers.get("MCP-Session-Id") ?? undefined;
    }
    // 传输层 404 会在业务执行前拒绝请求；只对这一种情况恢复一次，绝不重试有歧义的网络失败或业务错误。
    if (
      res.status === 404 &&
      init?.method === "POST" &&
      method !== "initialize" &&
      sentSession &&
      initializeBody
    ) {
      await res.body?.cancel();
      if (sentSession === transportSession) {
        reconnect ??= restore(new Headers(headers)).finally(() => {
          reconnect = undefined;
        });
        await reconnect;
      }
      throwIfAborted(identity);
      throwIfAborted(init?.signal);
      headers.set("MCP-Session-Id", transportSession!);
      res = await send({ ...init, headers, body });
    }
    throwIfAborted(identity);
    if (!res.ok && init?.method === "POST") {
      await res.body?.cancel();
      // 限流是"等一下还能用"，不是"连接坏了"：规约 §14 要求按 Retry-After 等待，
      // 并降低并发/缩小查询范围，不能原样立刻重试。REST /call 会回 429 + Retry-After；
      // 这里的 MCP 入口同样要认。
      if (res.status === 429) {
        const waitMs = retryAfterMs(res.headers);
        throw Object.assign(
          new Error(
            `GEA_MCP_RATE_LIMITED: 网关限流（HTTP 429）${
              waitMs === undefined ? "" : `，建议等 ${Math.ceil(waitMs / 1000)} 秒再试`
            }。请降低并发或缩小查询范围后再来，不要原样立刻重试。`,
          ),
          {
            code: "GEA_MCP_RATE_LIMITED",
            retryable: true,
            ...(waitMs === undefined ? {} : { retryAfterMs: waitMs }),
          },
        );
      }
      throw new Error(
        `GEA_MCP_HTTP_${res.status}: 网关请求被拒绝，请检查连接或重新登录；不要原样重复调用。`,
      );
    }
    if ((discovery || invocation) && res.ok) {
      const text = await res.clone().text();
      throwIfAborted(identity);
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
        if (invocation && reply.id === invocation.id) {
          const result = value as {
            result?: { isError?: boolean; content?: Array<{ type?: string; uri?: string }> };
          };
          if (result.result?.isError !== true && Array.isArray(result.result?.content))
            for (const item of result.result.content)
              if (item.type === "resource_link" && nonempty(item.uri)) {
                const existing = artifactRoutes.get(item.uri);
                if (existing && existing !== invocation.code)
                  throw Error("GEA_MCP_RESOURCE_ROUTE_AMBIGUOUS");
                artifactRoutes.set(item.uri, invocation.code);
              }
        }
        if (!discovery || reply.id !== discovery.id || !Array.isArray(reply.result?.tools))
          continue;
        const selectedTools = routing.cubeMcpCode
          ? reply.result.tools.filter(
              (tool) =>
                !["query_business_data", "inspect_cube_model"].includes(tool?.name) ||
                (tool?._meta?.sourceType === "MCP" &&
                  tool?._meta?.sourceCode === routing.cubeMcpCode),
            )
          : reply.result.tools;
        reply.result.tools = selectedTools;
        const next = discovery.firstPage ? new Map<string, string>() : new Map(routes);
        for (const tool of selectedTools) {
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
      if (discovery && routing.cubeMcpCode) {
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        return new Response(
          headers.get("content-type")?.includes("text/event-stream")
            ? messages
                .map((message) => "event: message\ndata: " + JSON.stringify(message) + "\n\n")
                .join("")
            : JSON.stringify(messages[0]),
          { status: res.status, headers },
        );
      }
    }
    return res;
  };
  const authorizedResources: ResourceReader = async (toolName, signal) => {
    throwIfAborted(identity);
    throwIfAborted(signal);
    const mcpCode = routes.get(toolName);
    if (!mcpCode) throw Error("GEA_MCP_TOOL_ROUTE_REQUIRED");
    const response = await fetchImpl(base + "/ai/gateway/mcp/proxy/resources", {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...meta, mcpCode, toolName }),
      signal: AbortSignal.any([identity, signal, AbortSignal.timeout(timeoutMs)]),
    });
    throwIfAborted(identity);
    throwIfAborted(signal);
    if (response.status === 429) {
      const retryAfter = retryAfterMs(response.headers);
      await response.body?.cancel();
      throw Object.assign(
        Error(
          `GEA_RESOURCE_DISCOVERY_RATE_LIMITED: ${retryAfter === undefined ? "遵循 Retry-After" : "至少等待 " + Math.ceil(retryAfter / 1000) + " 秒"}，停止本次资源发现，不立即重试。`,
        ),
        { retryAfterMs: retryAfter },
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw Error("GEA_RESOURCE_DISCOVERY_HTTP_" + response.status);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw Error("GEA_RESOURCE_DISCOVERY_INVALID_JSON");
    }
    throwIfAborted(identity);
    throwIfAborted(signal);
    return parseAuthorizedResources(payload, `MCP_TOOL:${mcpCode}:${toolName}`);
  };
  return { url, fetch: gatewayFetch, authorizedResources };
}

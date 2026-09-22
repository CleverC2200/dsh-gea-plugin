/**
 * 模块 MCP 客户端：把模块自带（`mcp.json` 的 governed-sql-read）的查询工具接进对话。
 *
 * 之前只有页面桥 + 受管 SQL 直读两条路，页面一失败就只能"请打开页面"。
 * 传输层（gateway-mcp.ts）已经把 MCP 会话、路由码、重连都处理好了，这里只补
 * 最上面那层 JSON-RPC：initialize → tools/list → tools/call。
 */
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";

export type McpTool = {
  name: string;
  description?: string;
  /** 入参名清单（给模型看的最小信息，完整 schema 太大）。 */
  parameters: string[];
  required: string[];
};

export type McpModule = {
  tools(): McpTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
};

/**
 * 协议版本按新到旧试一次：网关支持哪版由它决定，客户端不必写死一个版本号，
 * 否则服务端升级协议时我们会整体不可用。
 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const MAX_TOOLS = 40;
const MAX_RESULT_CHARS = 20_000;

type JsonRpcReply = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/** MCP 响应可能是 JSON，也可能是 SSE（每个 event 一条消息）。 */
async function readReply(
  response: Response,
  expectId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const text = await response.text();
  signal.throwIfAborted();
  const messages: unknown[] = [];
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    createParser({
      onEvent: (event) => {
        try {
          messages.push(JSON.parse(event.data));
        } catch {
          // 心跳/注释行忽略。
        }
      },
    }).feed(text);
  } else {
    try {
      messages.push(JSON.parse(text));
    } catch {
      throw new Error("GEA_MCP_BAD_RESPONSE: 模块查询返回了无法解析的内容");
    }
  }
  for (const value of messages) {
    const reply = value as JsonRpcReply;
    if (!reply || typeof reply !== "object") continue;
    if (reply.id !== expectId) continue;
    if (reply.error)
      throw new Error(
        `GEA_MCP_TOOL_ERROR: ${String(reply.error.message ?? reply.error.code ?? "调用失败")}`,
      );
    return reply.result;
  }
  throw new Error("GEA_MCP_NO_REPLY: 模块查询没有返回结果，请重试或改用只读 SQL");
}

function toolList(result: unknown): McpTool[] {
  const tools = (result as { tools?: unknown })?.tools;
  if (!Array.isArray(tools)) return [];
  return tools
    .slice(0, MAX_TOOLS)
    .map((raw) => {
      const tool = (raw ?? {}) as {
        name?: unknown;
        description?: unknown;
        annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
        inputSchema?: { properties?: Record<string, unknown>; required?: unknown };
      };
      // MCP annotations are advisory, but a module that explicitly marks a tool
      // destructive or non-read-only must never pass through this read-only client.
      if (
        (tool.annotations?.readOnlyHint !== undefined &&
          tool.annotations.readOnlyHint !== true) ||
        tool.annotations?.destructiveHint === true
      )
        return null;
      const properties = tool.inputSchema?.properties;
      const required = Array.isArray(tool.inputSchema?.required)
        ? tool.inputSchema!.required.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      return {
        name: typeof tool.name === "string" ? tool.name : "",
        ...(typeof tool.description === "string"
          ? { description: tool.description.slice(0, 300) }
          : {}),
        parameters: properties ? Object.keys(properties).slice(0, 30) : [],
        required,
      };
    })
    .filter((tool): tool is McpTool => tool !== null && tool.name.length > 0);
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) =>
        typeof (item as { text?: unknown })?.text === "string"
          ? (item as { text: string }).text
          : "",
      )
      .join("\n")
      .trim();
    if (text) return text.slice(0, MAX_RESULT_CHARS);
  }
  const isError = (result as { isError?: unknown })?.isError === true;
  const fallback = JSON.stringify(result ?? null);
  return (isError ? "GEA_MCP_TOOL_ERROR: " : "") + fallback.slice(0, MAX_RESULT_CHARS);
}

/**
 * 建立模块 MCP 会话并取回工具清单。传输层已经负责会话头、路由码与重连，
 * 这里只按协议顺序调用；initialize 成功后 MCP-Session-Id 由传输层维护。
 */
export async function openModuleMcp(
  transport: { url: string; fetch: typeof fetch },
  signal: AbortSignal,
): Promise<McpModule> {
  const post = async (
    body: unknown,
    options: { version?: string; expectId?: string } = {},
  ): Promise<Response> =>
    transport.fetch(transport.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(options.version ? { "MCP-Protocol-Version": options.version } : {}),
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });

  let initialized = false;
  /** 协商成功的协议版本：网关要求后续每次请求都带上它（缺了 tools/list 会被 400）。 */
  let negotiated: string | undefined;
  let lastError: unknown;
  for (const version of PROTOCOL_VERSIONS) {
    const id = randomUUID();
    try {
      const response = await post(
        {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: version,
            capabilities: {},
            clientInfo: { name: "gea-dsh", version: "1.0.0" },
          },
        },
        { version },
      );
      await readReply(response, id, signal);
      const ready = await post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { version },
      );
      await ready.body?.cancel();
      initialized = true;
      negotiated = version;
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!initialized)
    throw new Error(
      `GEA_MCP_INIT_FAILED: 模块查询通道协商失败（${
        lastError instanceof Error ? lastError.message : String(lastError)
      }）`,
    );

  // 先取工具清单：传输层靠 tools/list 把工具名映射成服务端路由码，tools/call 才认得。
  const tools = await listModuleTools(transport, signal, negotiated);
  return {
    tools: () => tools,
    call: async (name, args, callSignal) => {
      const id = randomUUID();
      const response = await post(
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        },
        { expectId: id, ...(negotiated ? { version: negotiated } : {}) },
      );
      const result = await readReply(response, id, callSignal);
      return resultText(result);
    },
  };
}

/** 取工具清单（必须在 tools/call 之前调用一次，传输层要据此建立路由）。 */
export async function listModuleTools(
  transport: { url: string; fetch: typeof fetch },
  signal: AbortSignal,
  version?: string,
): Promise<McpTool[]> {
  const id = randomUUID();
  const response = await transport.fetch(transport.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // 线上实测：网关要求每个请求都带协议版本；缺了它 tools/list 直接 400。
      ...(version ? { "MCP-Protocol-Version": version } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} }),
    signal,
    redirect: "error",
  });
  return toolList(await readReply(response, id, signal));
}

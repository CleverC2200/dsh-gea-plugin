/** Cube-New's two wire methods, with login-owned transport and validated inline or historical results. */
import { randomUUID } from "node:crypto";
import { createParser } from "eventsource-parser";
import {
  cubeNewArtifact,
  cubeQueryResultError,
  validateCubeQueryMembers,
  validateCubeQueryResult,
} from "./cube-new.ts";
import type { GatewayMcpTransport } from "./gateway-mcp.ts";
import { throwIfAborted } from "../shared/abort.ts";
import { readMcpResponseText } from "./mcp-response.ts";

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const METHODS = ["inspect_cube_model", "query_business_data"] as const;
const VERSIONS = ["2025-11-25", "2025-06-18", "2024-11-05"];
export type CubeMcpTool = {
  name: (typeof METHODS)[number];
  description: string;
  inputSchema: Record<string, unknown>;
};
export type CubeMcpClient = {
  tools(): CubeMcpTool[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /** Retained evidence can recheck its original resource grant; new queries do not use this API. */
  authorizedResources: GatewayMcpTransport["authorizedResources"];
};

function toolError(
  result: Record<string, unknown>,
  parseText: (text: string) => unknown,
): Error | undefined {
  let failure = record(result.structuredContent);
  if (!failure && Array.isArray(result.content))
    for (const part of result.content) {
      const entry = record(part);
      const text = entry?.type === "text" ? entry.text : undefined;
      if (typeof text !== "string") continue;
      failure = record(parseText(text));
      if (failure?.success === false) break;
    }
  if (result.isError !== true && failure?.success !== false) return;
  const code =
    typeof failure?.businessCode === "string"
      ? failure.businessCode
      : typeof failure?.code === "string"
        ? failure.code
        : "GEA_MCP_TOOL_ERROR";
  const ids = ["requestId", "traceId", "auditId"].flatMap((key) =>
    typeof failure?.[key] === "string" ? [`${key}=${failure[key]}`] : [],
  );
  const message = typeof failure?.message === "string" ? failure.message : "MCP 工具未返回成功结果";
  const action =
    code === "DATA_QUERY_MEMBER_NOT_PUBLISHED"
      ? "查询成员尚未发布，需要服务端核对底层成员发布和资源绑定。本轮停止查询，不换成员、过滤条件或身份重试。"
      : code === "AI_GATEWAY_MCP_RESULT_TOO_LARGE"
        ? "结果超出网关预算，请缩小查询、减少返回列或降低分页大小；不要原样重试，不回退 OSS。"
        : "本次没有取得有效结果。按原错误修正配置或参数，不自动重复请求。";
  return Object.assign(
    Error(`${code}: ${message}。${action}${ids.length ? " " + ids.join("，") : ""}`),
    {
      code,
      retryable: failure?.retryable === true,
      category: failure?.category,
      suggestedAction:
        failure?.suggestedAction ??
        (code === "AI_GATEWAY_MCP_RESULT_TOO_LARGE" ? "NARROW_QUERY_OR_PAGINATE" : undefined),
      retryAfterMs: failure?.retryAfterMs,
      details: failure?.details,
      ...Object.fromEntries(
        ["requestId", "traceId", "auditId"].flatMap((key) =>
          typeof failure?.[key] === "string" ? [[key, failure[key]]] : [],
        ),
      ),
    },
  );
}

export async function openCubeMcp(
  transport: GatewayMcpTransport,
  signal: AbortSignal,
): Promise<CubeMcpClient> {
  let version: string | undefined;
  const rpc = async (method: string, params: Record<string, unknown>, callSignal: AbortSignal) => {
    throwIfAborted(callSignal);
    const id = randomUUID();
    const response = await transport.fetch(transport.url, {
      method: "POST",
      redirect: "error",
      signal: callSignal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(version ? { "MCP-Protocol-Version": version } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw Error(`GEA_MCP_HTTP_${response.status}`);
    const text = await readMcpResponseText(response, callSignal, transport.maxResponseBytes);
    // Keep original numeric lexemes when structuredContent is serialized for the tool output.
    const numbers = new WeakMap<object, Map<string, string>>();
    const parse = (text: string): unknown =>
      JSON.parse(
        text,
        function (this: object, key: string, value: unknown, context?: { source?: string }) {
          if (typeof value === "number" && context?.source !== JSON.stringify(value)) {
            if (!context?.source) throw Error("EXACT_JSON_RUNTIME_REQUIRED");
            const entries = numbers.get(this) ?? new Map<string, string>();
            entries.set(key, context.source);
            numbers.set(this, entries);
          }
          return value;
        },
      );
    const stringify = (value: unknown) =>
      JSON.stringify(value, function (this: object, key, value) {
        const source = numbers.get(this)?.get(key);
        if (source === undefined) return value;
        if (!("rawJSON" in JSON) || typeof JSON.rawJSON !== "function")
          throw Error("EXACT_JSON_RUNTIME_REQUIRED");
        return JSON.rawJSON(source);
      });
    let reply: Record<string, unknown> | undefined;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      createParser({
        onEvent: (event) => {
          const candidate = record(parse(event.data));
          if (candidate?.id === id) reply = candidate;
        },
      }).feed(text);
    } else reply = record(parse(text));
    if (!reply || reply.id !== id || reply.jsonrpc !== "2.0") throw Error("GEA_MCP_REPLY_MISMATCH");
    if (reply.error)
      throw Error(
        `GEA_MCP_PROTOCOL_ERROR: ${String(record(reply.error)?.message ?? "网关协议失败")}`,
      );
    const result = record(reply.result);
    if (!result) throw Error("GEA_MCP_RESULT_INVALID");
    const textValues = new Map<string, unknown>();
    const parseText = (text: string): unknown => {
      if (!textValues.has(text)) {
        let value: unknown;
        try {
          value = JSON.parse(text);
        } catch {
          /* Explanatory text is not business JSON. */
        }
        textValues.set(text, value);
      }
      return textValues.get(text);
    };
    const failed = toolError(result, parseText);
    if (failed) throw failed;
    return { result, stringify, parseText };
  };
  const { result: initialized } = await rpc(
    "initialize",
    {
      protocolVersion: VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "gea-cube-new", version: "1.0" },
    },
    signal,
  );
  if (
    typeof initialized.protocolVersion !== "string" ||
    !VERSIONS.includes(initialized.protocolVersion)
  )
    throw Error("GEA_MCP_PROTOCOL_VERSION_UNSUPPORTED");
  version = initialized.protocolVersion;
  const ready = await transport.fetch(transport.url, {
    method: "POST",
    redirect: "error",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  await ready.body?.cancel();
  throwIfAborted(signal);
  if (!ready.ok) throw Error(`GEA_MCP_HTTP_${ready.status}`);
  const tools: CubeMcpTool[] = [];
  let cursor: string | undefined;
  do {
    const { result: listed } = await rpc("tools/list", cursor ? { cursor } : {}, signal);
    if (!Array.isArray(listed.tools)) throw Error("GEA_MCP_TOOLS_INVALID");
    for (const raw of listed.tools) {
      const tool = record(raw);
      const name = METHODS.find((name) => name === tool?.name);
      if (!name) continue;
      const schema = record(tool?.inputSchema);
      if (!schema || schema.type !== "object" || tools.some((t) => t.name === name))
        throw Error("GEA_MCP_TOOLS_INVALID");
      const annotations = record(tool?.annotations);
      if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false)
        throw Error("GEA_MCP_READONLY_REQUIRED");
      tools.push({
        name,
        description: typeof tool?.description === "string" ? tool.description : name,
        inputSchema: schema,
      });
    }
    cursor = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
  } while (cursor);
  return {
    tools: () => structuredClone(tools),
    authorizedResources: transport.authorizedResources,
    async call(name, args, callSignal) {
      if (
        [
          "agentCode",
          "consumerCode",
          "consumerType",
          "sessionId",
          "conversationId",
          "delegationToken",
          "mcpCode",
          "tenantId",
          "_meta",
        ].some((key) => key in args)
      )
        throw Error("GEA_MCP_PLATFORM_ARGUMENT_REJECTED: 平台身份和路由不属于业务 arguments。");
      if (!tools.some((tool) => tool.name === name))
        throw Error(`GEA_MCP_TOOL_UNAVAILABLE: 当前业务会话未返回 ${name}`);
      if (name === "query_business_data") validateCubeQueryMembers(args);
      const { result, stringify, parseText } = await rpc(
        "tools/call",
        { name, arguments: args },
        callSignal,
      );
      if (name === "inspect_cube_model") {
        const structured = record(result.structuredContent);
        if (structured) return stringify(structured);
        const text = Array.isArray(result.content)
          ? result.content.map(record).find((part) => part?.type === "text")?.text
          : undefined;
        if (typeof text !== "string") throw Error("GEA_CUBE_NEW_INSPECT_RESULT");
        return text;
      }
      if (result.structuredContent !== undefined && result.structuredContent !== null) {
        validateCubeQueryResult(result.structuredContent, args, "inline");
        return stringify(result.structuredContent);
      }
      const texts: string[] = [];
      if (Array.isArray(result.content))
        for (const part of result.content) {
          const entry = record(part);
          if (entry?.type !== "text" || typeof entry.text !== "string") continue;
          const payload = parseText(entry.text);
          const candidate = record(payload);
          if (candidate?.action !== "query" && !candidate?.datasets) continue;
          validateCubeQueryResult(payload, args, "inline");
          texts.push(entry.text);
        }
      if (texts.length > 1)
        throw cubeQueryResultError("GEA_CUBE_NEW_QUERY_AMBIGUOUS", ["content.text"]);
      const [text] = texts;
      if (text !== undefined) return text;
      const links = Array.isArray(result.content)
        ? result.content.map(record).filter((part) => part?.type === "resource_link")
        : [];
      if (links.length === 0)
        throw cubeQueryResultError("GEA_CUBE_NEW_QUERY_RESULT_INVALID", [
          "structuredContent",
          "content",
        ]);
      const link = links[0];
      if (
        links.length !== 1 ||
        typeof link?.uri !== "string" ||
        !link.uri.startsWith("data-artifact://gateway/") ||
        link.mimeType !== "application/json"
      )
        throw cubeQueryResultError("GEA_CUBE_NEW_QUERY_RESOURCE_LINK", ["content.resource_link"]);
      const { result: read } = await rpc("resources/read", { uri: link.uri }, callSignal);
      const sha256 = record(link._meta)?.sha256;
      return cubeNewArtifact(
        read,
        { uri: link.uri, ...(typeof sha256 === "string" ? { sha256 } : {}) },
        args,
      );
    },
  };
}

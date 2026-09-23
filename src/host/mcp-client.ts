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
  /** 服务端原样返回的入参 schema：只在按工具名取完整定义时才展开给模型。 */
  inputSchema?: unknown;
};

export type McpModule = {
  tools(): McpTool[];
  /** 某个工具的完整入参定义（含类型、枚举、嵌套字段）；名字不存在返回 undefined。 */
  schema(name: string): string | undefined;
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /**
   * 读大结果制品的某一段。完整正文由宿主按制品 URI 缓存，模型按需一段段取，
   * 不用把几十万字符一次塞进上下文。
   */
  chunk(
    uri: string,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<string>;
};

/**
 * 协议版本按新到旧试一次：网关支持哪版由它决定，客户端不必写死一个版本号，
 * 否则服务端升级协议时我们会整体不可用。
 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const MAX_TOOLS = 40;
const MAX_RESULT_CHARS = 20_000;
/** 单条资源结果单次内联上限：够模型读出结论，又不至于把一次查询塞爆上下文。 */
const MAX_RESOURCE_INLINE_CHARS = 12_000;
/** 单个工具入参定义的上限：Schema 是服务端给的，不能让它把上下文吃爆。 */
const MAX_TOOL_SCHEMA_CHARS = 2_000;
/** 一次最多内联几个制品链接：其余的把 URI 报给模型，按需再读。 */
const MAX_RESOURCE_LINKS = 2;
/** 单个制品正文在宿主侧最多缓存多少字符（制品本身可能有 10MiB 上限，不能照单全收）。 */
const MAX_ARTIFACT_CHARS = 4_000_000;
/** 单个模块会话最多缓存多少字符：超了按最早读到的先丢。 */
const MAX_ARTIFACT_TOTAL_CHARS = 12_000_000;

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
    .map((raw): McpTool | null => {
      const tool = (raw ?? {}) as {
        name?: unknown;
        description?: unknown;
        annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
        inputSchema?: unknown;
      };
      // MCP annotations are advisory, but a module that explicitly marks a tool
      // destructive or non-read-only must never pass through this read-only client.
      if (
        (tool.annotations?.readOnlyHint !== undefined &&
          tool.annotations.readOnlyHint !== true) ||
        tool.annotations?.destructiveHint === true
      )
        return null;
      const schema = asRecord(tool.inputSchema) ?? {};
      const properties = asRecord(schema.properties);
      const required = Array.isArray(schema.required)
        ? schema.required.filter(
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
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
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

/** 结果里的资源链接（大结果以 `resource_link` 返回，正文要另读一次）。 */
type ResourceLink = { uri: string; ossUrl?: string };

/**
 * 把一个字段的 schema 压成一行：类型、枚举、嵌套字段名。
 * 服务端 schema 可能是空壳（例如 `queries.items.properties` 为空），如实写"未声明"，
 * 不要替服务端编一套契约。
 */
function fieldLine(name: string, schema: unknown, required: boolean): string {
  const value = asRecord(schema) ?? {};
  const types = [
    ...(typeof value.type === "string" ? [value.type] : []),
    ...(Array.isArray(value.type) ? value.type.filter((t): t is string => typeof t === "string") : []),
  ];
  const enumValues = Array.isArray(value.enum)
    ? value.enum.filter((item) => typeof item === "string" || typeof item === "number")
    : [];
  const items = asRecord(value.items);
  const itemProps = asRecord(items?.properties);
  const nested = itemProps ? Object.keys(itemProps) : [];
  const parts = [
    `- ${name}（${required ? "必填" : "可选"}${types.length ? `，${types.join("|")}` : ""}${
      enumValues.length ? `，枚举：${enumValues.join("|")}` : ""
    }）`,
  ];
  const description = str(value.description);
  if (description) parts.push(`：${description.replace(/\s+/g, " ").slice(0, 160)}`);
  if (items) {
    parts.push(
      nested.length
        ? `　[数组，元素字段：${nested.slice(0, 12).join("、")}]`
        : "　[数组，元素结构服务端未声明]",
    );
  } else if (value.properties && Object.keys(asRecord(value.properties) ?? {}).length) {
    parts.push(`　[对象，字段：${Object.keys(asRecord(value.properties)!).slice(0, 12).join("、")}]`);
  }
  return parts.join("");
}

/** 工具的完整入参定义：给模型看的可读文本，带上限。 */
export function describeToolSchema(tool: McpTool): string {
  const schema = asRecord(tool.inputSchema) ?? {};
  const properties = asRecord(schema.properties) ?? {};
  const required = new Set(tool.required);
  const lines = [
    `${tool.name}（${required.size ? `必填参数：${[...required].join("、")}` : "无必填参数"}）`,
    ...(tool.description ? [`说明：${tool.description}`] : []),
  ];
  const names = Object.keys(properties);
  if (names.length === 0) lines.push("入参：服务端没有声明 inputSchema（按工具说明调用）。");
  else
    for (const name of names)
      lines.push(fieldLine(name, properties[name], required.has(name)));
  const text = lines.join("\n");
  return text.length > MAX_TOOL_SCHEMA_CHARS
    ? `${text.slice(0, MAX_TOOL_SCHEMA_CHARS)}…（定义过长已截断；按上面列出的字段与枚举调用）`
    : text;
}

/**
 * 工具结果里的失败信封：HTTP 200、JSON-RPC 也没有 error，但正文里写着失败。
 *
 * 实测它有三种长相，都要认：
 * 1) 顶层 `{success:false, businessCode:"MCP_UPSTREAM_TOOL_ERROR", …}`；
 * 2) 藏在 `structuredContent` 里（`{"result":{"isError":true,"structuredContent":{…}}}`）；
 * 3) `content[].text` 是**对象**（不是字符串），内容同上。
 *
 * 只认顶层的代价就是：失败被原样当数据回给模型，界面上"报错都不展示了"。
 */
type ToolFailureKind = "validation" | "permission" | "upstream";

type ToolFailure = {
  code: string;
  message: string;
  kind: ToolFailureKind;
  retryable?: boolean;
  requestId?: string;
  traceId?: string;
  auditId?: string;
  suggestedAction?: string;
  /** 出错的字段路径，例如 queries[0].query.order。 */
  path?: string;
};

const POLICY_FAILURE_CODES = new Set([
  "AI_GATEWAY_DATA_PERMISSION_DENIED",
  "AGENT_ACCESS_DENIED",
  "GEA_PLUGIN_SESSION_REJECTED",
  "DATA_GRANTS_EMPTY",
]);

/** 失败码的形态：`OK` 这类正常码不能误判成失败。 */
const FAILURE_CODE =
  /(ERROR|FAILED|FAILURE|DENIED|REJECTED|INVALID|EXCEEDED|NOT_FOUND|EMPTY|UNKNOWN|UNAVAILABLE|TIMEOUT|EXPIRED|FORBIDDEN)/;

/**
 * 网关会把"查询写错"也标成 `AI_GATEWAY_DATA_PERMISSION_DENIED`/`AUTHORIZATION`。
 * 实测原样报文：
 * `{"businessCode":"AI_GATEWAY_DATA_PERMISSION_DENIED","category":"AUTHORIZATION",
 *   "message":"Cube 查询成员未唯一匹配数据目录资源；模型须与 dataAssetCode 一致，跨模型查询请分别调用"}`
 * 这条按"缺授权"去解释会把人带到沟里，必须按 message 认出来是写法问题。
 */
const QUERY_SHAPE_FAILURE =
  /未唯一匹配数据目录资源|dataAssetCode|跨模型|成员必须属于|分别调用/;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 对象，或者是 JSON 字符串；其它一律 undefined。 */
function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (direct) return direct;
  const text = str(value);
  if (!text || !text.trim().startsWith("{")) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** 一处候选对象是不是失败信封；不是就返回 undefined。 */
function failureOf(record: Record<string, unknown> | undefined): ToolFailure | undefined {
  if (!record) return undefined;
  const nested = asRecord(record.structuredContent);
  const code = [record.businessCode, record.code, nested?.businessCode, nested?.code]
    .map(str)
    .find((item): item is string => item !== undefined && FAILURE_CODE.test(item));
  const failed = record.isError === true || record.success === false || nested?.success === false;
  // success:false / isError:true 是明确的失败；没有它们时只看"失败形态的码"。
  if (!failed && !code) return undefined;
  const message =
    str(record.message) ?? str(nested?.message) ?? str(record.error) ?? "";
  if (!code && !message) return undefined;
  const details = asRecord(record.details) ?? asRecord(nested?.details);
  const category = str(record.category) ?? str(nested?.category);
  const suggestedAction = str(record.suggestedAction) ?? str(nested?.suggestedAction);
  const resolved = code ?? "GEA_MCP_TOOL_ERROR";
  // message 先说清是写法问题的，优先按写法问题分类（网关的码/category 会误导）。
  const queryShape = QUERY_SHAPE_FAILURE.test(`${message} ${details?.path ?? ""}`);
  const permission =
    !queryShape &&
    (POLICY_FAILURE_CODES.has(resolved) ||
      (/DENIED|FORBIDDEN/.test(resolved) && !/INVALID/.test(resolved)) ||
      /授权|权限/.test(message));
  const validation =
    !permission &&
    (queryShape ||
      resolved === "AI_SCHEMA_INVALID" ||
      category === "VALIDATION" ||
      suggestedAction === "FIX_ARGUMENTS" ||
      /参数|字段|格式|必须/.test(message));
  return {
    code: resolved,
    message,
    kind: permission ? "permission" : validation ? "validation" : "upstream",
    ...(typeof record.retryable === "boolean"
      ? { retryable: record.retryable }
      : typeof nested?.retryable === "boolean"
        ? { retryable: nested.retryable as boolean }
        : {}),
    ...(str(record.requestId) ?? str(nested?.requestId)
      ? { requestId: (str(record.requestId) ?? str(nested?.requestId))! }
      : {}),
    ...(str(record.traceId) ?? str(nested?.traceId)
      ? { traceId: (str(record.traceId) ?? str(nested?.traceId))! }
      : {}),
    ...(str(record.auditId) ?? str(nested?.auditId)
      ? { auditId: (str(record.auditId) ?? str(nested?.auditId))! }
      : {}),
    ...(suggestedAction ? { suggestedAction } : {}),
    ...(str(details?.path) ? { path: str(details?.path)! } : {}),
  };
}

/** 从整条工具结果里找失败：顶层 / structuredContent / content[].text（对象或 JSON 字符串）。 */
function toolFailure(result: unknown): ToolFailure | undefined {
  const top = asRecord(result);
  const fromTop = failureOf(top);
  if (fromTop) return fromTop;
  const content = (top?.content ?? (Array.isArray(result) ? result : undefined)) as unknown;
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const entry = asRecord(item);
    const fromText = failureOf(asJsonRecord(entry?.text));
    if (fromText) return fromText;
    const fromItem = failureOf(entry);
    if (fromItem) return fromItem;
  }
  return undefined;
}

/**
 * 把失败信封翻成人话：授权类如实回报（不是红色调用失败，延续"无权限要说清楚"的要求），
 * 真失败则抛错，界面上就是红色错误 + 可读原因 + requestId。
 */
/**
 * 按错误类型给修复动作（不再用一句"不要换参数重试"盖住所有情况）：
 * - 参数校验失败 → 指出字段与格式要求，允许改好参数后重新调用；
 * - 权限/授权 → 如实说明缺哪一项，不要换模块凑；
 * - 下游执行失败 → 展示原因与 requestId，并按 retryable 讲清能不能重试。
 */
function formatToolFailure(failure: ToolFailure): { text?: string; error?: Error } {
  const detail = [
    failure.code,
    failure.path ? `字段=${failure.path}` : undefined,
    failure.requestId ? `requestId=${failure.requestId}` : undefined,
    failure.traceId ? `traceId=${failure.traceId}` : undefined,
    failure.auditId ? `auditId=${failure.auditId}` : undefined,
    failure.suggestedAction ? `建议动作=${failure.suggestedAction}` : undefined,
  ]
    .filter(Boolean)
    .join("，");
  const queriesHint = /queries/i.test(failure.path ?? "") || /queries/i.test(failure.message)
    ? "（提示：Cube 查询要放在 arguments.queries 里，不要提到工具顶层。）"
    : "";
  const crossModelHint = QUERY_SHAPE_FAILURE.test(failure.message)
    ? "（提示：一次调用里的成员必须属于同一个模型/dataAssetCode——把不同模型的成员拆成两次调用再来一次。）"
    : "";
  if (failure.kind === "permission")
    return {
      text:
        `模块数据未授权：${failure.message || failure.code}（${detail}）。` +
        "这是当前账号/Agent 的权限或数据授权没配置，不是参数问题：说清缺哪一项授权，不要换模块或换写法重试。",
    };
  if (failure.kind === "validation")
    return {
      error: new Error(
        `GEA_MCP_TOOL_ERROR：入参没通过网关校验（${detail}）：${
          failure.message || failure.code
        }${queriesHint}${crossModelHint}。照它的提示改好参数后可以重新调用一次；不要用同一份参数原样重试。`,
      ),
    };
  return {
    error: new Error(
      `GEA_MCP_TOOL_ERROR：下游工具执行失败（${detail}）${
        failure.message ? `：${failure.message}` : ""
      }。这是网关下游的错误，不是参数问题；${
        failure.retryable === false
          ? "不要原样自动重试，修好参数或稍后可发起新的一次调用"
          : "可按同一参数重试一次"
      }；把 requestId 交给排查。`,
    ),
  };
}

/** 结果正文：`text` 可能是字符串，也可能是对象（实测网关两种都发过）。 */
function readableTexts(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const text = (item as { text?: unknown })?.text;
      if (typeof text === "string") return text;
      if (text !== null && typeof text === "object")
        return JSON.stringify(text);
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** 先判失败，再取正文：失败按类型分支处理，正常结果才原样返回。 */
function readableToolOutcome(result: unknown, text: string): string {
  const failure = toolFailure(result);
  if (!failure) {
    // 认不出信封但网关自己标了失败：至少别把原文当成功数据。
    if ((result as { isError?: unknown })?.isError === true)
      throw new Error(`GEA_MCP_TOOL_ERROR：${text || "工具返回失败但没给原因"}`);
    return text;
  }
  const outcome = formatToolFailure(failure);
  if (outcome.error) throw outcome.error;
  return outcome.text ?? text;
}

function resourceLinks(result: unknown): ResourceLink[] {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  const links: ResourceLink[] = [];
  for (const item of content) {
    const entry = item as {
      type?: unknown;
      uri?: unknown;
      _meta?: { oss_url?: unknown };
    };
    if (entry?.type !== "resource_link" || typeof entry.uri !== "string") continue;
    const ossUrl = entry._meta?.oss_url;
    links.push({
      uri: entry.uri,
      ...(typeof ossUrl === "string" ? { ossUrl } : {}),
    });
  }
  return links;
}

/** `resources/read` 返回的正文。 */
function resourceContentsText(result: unknown): string {
  const contents = (result as { contents?: unknown })?.contents;
  if (!Array.isArray(contents)) return "";
  return contents
    .map((part) => {
      const text = (part as { text?: unknown })?.text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
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
  /**
   * 制品正文缓存：大结果读一次放这里，模型用 chunk() 一段段取。
   * 只在本模块会话内有效——身份变化会换掉整个 McpModule，缓存跟着走。
   */
  const artifacts = new Map<string, string>();
  let artifactChars = 0;
  const rememberArtifact = (uri: string, text: string): void => {
    const kept = text.length > MAX_ARTIFACT_CHARS ? text.slice(0, MAX_ARTIFACT_CHARS) : text;
    artifactChars += kept.length - (artifacts.get(uri)?.length ?? 0);
    // 重新 set 一次保证 Map 顺序按"最近写入"排，淘汰时丢最早的。
    artifacts.delete(uri);
    artifacts.set(uri, kept);
    while (artifactChars > MAX_ARTIFACT_TOTAL_CHARS && artifacts.size > 1) {
      const oldest = artifacts.keys().next().value as string;
      artifactChars -= artifacts.get(oldest)?.length ?? 0;
      artifacts.delete(oldest);
    }
  };
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
  /** 读一个制品的完整正文（缓存优先）；读不回来就按原样抛，由调用方翻成人话。 */
  const readArtifact = async (uri: string, readSignal: AbortSignal): Promise<string> => {
    const cached = artifacts.get(uri);
    if (cached !== undefined) return cached;
    const readId = randomUUID();
    const readResponse = await post(
      { jsonrpc: "2.0", id: readId, method: "resources/read", params: { uri } },
      { ...(negotiated ? { version: negotiated } : {}) },
    );
    const text = resourceContentsText(
      await readReply(readResponse, readId, readSignal),
    );
    if (!text) throw new Error("GEA_MCP_RESOURCE_EMPTY");
    rememberArtifact(uri, text);
    return text;
  };
  return {
    tools: () => tools,
    schema: (name) => {
      const tool = tools.find((item) => item.name === name);
      return tool ? describeToolSchema(tool) : undefined;
    },
    chunk: async (uri, offset, length, chunkSignal) => {
      const text = await readArtifact(uri, chunkSignal);
      const start = Math.max(0, Math.min(Math.trunc(offset), text.length));
      const size = Math.max(1_000, Math.min(Math.trunc(length), MAX_RESOURCE_INLINE_CHARS));
      const body = text.slice(start, start + size);
      const end = start + body.length;
      const tail =
        end < text.length
          ? `\n（还有 ${text.length - end} 字符没读：继续读就再调一次，offset=${end}。）`
          : "\n（已到结尾。）";
      return `【制品片段 ${uri}｜字符 ${start}–${end} / 共 ${text.length}】\n${body}${tail}`.slice(
        0,
        MAX_RESULT_CHARS,
      );
    },
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
      const links = resourceLinks(result);
      if (links.length === 0)
        return readableToolOutcome(result, readableTexts(result) || resultText(result));
      // 线上实测：这类结果以 `data-artifact://gateway/…` 链接返回，模型得再调一次
      // 平台的读资源工具；它会把 server 猜成 browser（那个服务没连），整轮白跑。
      // 宿主在同一条 MCP 会话里读回来内联，模型一次调用就能看到内容。
      //
      // 大结果（例如 37 万字符的查询制品）不能整段塞进上下文：内联第一段，把"还有多少、
      // 怎么读下一段"写在正文里；完整正文留在宿主缓存里，按需 chunk() 取。
      const parts: string[] = [];
      const shown = links.slice(0, MAX_RESOURCE_LINKS);
      const skipped = links.slice(MAX_RESOURCE_LINKS);
      // 每段预留提示文字，保证整体不超过单次结果上限。
      const chunkChars = Math.max(
        2_000,
        Math.min(
          MAX_RESOURCE_INLINE_CHARS,
          Math.floor((MAX_RESULT_CHARS - 1_200) / Math.max(1, shown.length)),
        ),
      );
      for (const link of shown) {
        try {
          const text = await readArtifact(link.uri, callSignal);
          const head = text.slice(0, chunkChars);
          const more =
            head.length < text.length
              ? `\n\n（只内联了前 ${head.length} 字符，全文 ${text.length} 字符。` +
                `要下一段：再调一次 gea_module_mcp，带上 artifact="${link.uri}" 和 offset=${head.length}；` +
                "如果只是想要更少的行，也可以加 filters 或把 limit 调小重新查一次，不要重复整条大查询。）"
              : "";
          parts.push(`【结果内容 ${link.uri}】\n${head}${more}`);
        } catch (error) {
          parts.push(
            `【结果内容读不回来：${link.uri}（${
              error instanceof Error ? error.message : String(error)
            }）】不要再换别的工具去读这个链接：说明这次数据没取到，` +
              "需要行数据时改用 response_mode=inline_complete 再查一次。",
          );
        }
      }
      if (skipped.length)
        parts.push(
          `（这次还返回了 ${skipped.length} 个制品没有内联：${skipped
            .map((link) => link.uri)
            .join("、")}。要哪个就用 gea_module_mcp 带 artifact=<URI> 去读，别重新跑一遍查询。）`,
        );
      return parts.join("\n").slice(0, MAX_RESULT_CHARS);
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

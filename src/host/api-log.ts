import { randomUUID } from "node:crypto";
import { networkError } from "../shared/net-error.ts";

const DEFAULT_LIMIT = 500;
const BODY_LIMIT = 4 * 1024 * 1024;
const BODY_OMITTED = "[正文超过 4 MiB，未保存]";
const STREAM_OMITTED = "[流式响应正文未保存]";
const SENSITIVE_KEY =
  /^(?:authorization|proxy-authorization|cookies?|set-cookie|x-access-token|x-delegation-token|mcp[_-]?session[_-]?id|access[_-]?token|refresh[_-]?token|tokens?|secrets?|passwords?|client[_-]?(?:id|secret)|delegation[_-]?token|api[_-]?key|session[_-]?id|qrcode[_-]?id|credentials?|credential[_-]?id)$/i;
const SENSITIVE_QUERY =
  /^(?:token|secret|password|client_id|client_secret|qrcodeId|credentialId)$/i;

export type ApiReplayPolicy = "safe" | "idempotent" | "blocked";

export type ApiCatalogEntry = {
  id: string;
  group: string;
  name: string;
  method: string;
  path: string;
  description: string;
  requestFields: string[];
  replayPolicy: ApiReplayPolicy;
  replayNote: string;
};

type CatalogDefinition = ApiCatalogEntry & {
  matches(method: string, path: string): boolean;
};

const endpoint = (
  entry: Omit<CatalogDefinition, "matches">,
  pattern: RegExp,
): CatalogDefinition => ({
  ...entry,
  matches: (method, path) => {
    if (method !== entry.method) return false;
    const parts = path.split("/").filter(Boolean);
    return [
      path,
      ...parts.map((_, index) => "/" + parts.slice(index).join("/")),
    ].some((candidate) => pattern.test(candidate));
  },
});

const safe = "只读请求，可在当前登录身份内直接重发";
const blocked = "包含登录、临时凭证、会话或流式上下文，不允许从日志中心重发";
const idempotent = "写请求仅可二次确认后按原请求体、请求 ID 和幂等键重发";

const CATALOG: CatalogDefinition[] = [
  endpoint(
    {
      id: "auth.qrcode",
      group: "登录与身份",
      name: "获取登录二维码",
      method: "GET",
      path: "/sys/getLoginQrcode",
      description: "申请一次飞书扫码登录二维码。",
      requestFields: [],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/sys\/getLoginQrcode$/,
  ),
  endpoint(
    {
      id: "auth.poll",
      group: "登录与身份",
      name: "轮询扫码结果",
      method: "GET",
      path: "/sys/getQrcodeToken?qrcodeId={id}",
      description: "查询当前二维码的扫码与令牌状态。",
      requestFields: ["qrcodeId"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/sys\/getQrcodeToken$/,
  ),
  endpoint(
    {
      id: "identity.profile",
      group: "登录与身份",
      name: "读取当前用户",
      method: "GET",
      path: "/sys/user/getUserInfo",
      description: "读取当前登录用户、租户和头像资料。",
      requestFields: [],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sys\/user\/getUserInfo$/,
  ),
  endpoint(
    {
      id: "identity.permissions",
      group: "登录与身份",
      name: "读取权限代码",
      method: "GET",
      path: "/sys/permission/getPermCode",
      description: "读取当前用户实际拥有的权限代码。",
      requestFields: [],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sys\/permission\/getPermCode$/,
  ),
  endpoint(
    {
      id: "notifications.list",
      group: "通知",
      name: "通知列表",
      method: "GET",
      path: "/api/v1/notifications",
      description: "分页读取当前用户通知，可按状态筛选。",
      requestFields: ["pageNo", "pageSize", "state"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/api\/v1\/notifications$/,
  ),
  endpoint(
    {
      id: "notifications.detail",
      group: "通知",
      name: "通知详情",
      method: "GET",
      path: "/api/v1/notifications/{id}",
      description: "读取一条通知的完整内容。",
      requestFields: ["id"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/api\/v1\/notifications\/[^/]+$/,
  ),
  endpoint(
    {
      id: "plans.list",
      group: "销售计划",
      name: "计划列表",
      method: "GET",
      path: "/sales-plan/plans",
      description: "按周期、组织和状态分页查询销售计划。",
      requestFields: [
        "periodId",
        "planTypeCode",
        "dealerCode",
        "areaCode",
        "provinceCode",
        "orgCode",
        "baseName",
        "status",
        "pageNo",
        "pageSize",
      ],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sales-plan\/plans$/,
  ),
  endpoint(
    {
      id: "plans.version-skus",
      group: "销售计划",
      name: "版本 SKU",
      method: "GET",
      path: "/sales-plan/plans/versions/{versionId}/skus",
      description: "读取指定计划版本的完整 SKU 明细。",
      requestFields: ["versionId", "pageNo", "pageSize"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sales-plan\/plans\/versions\/[^/]+\/skus$/,
  ),
  endpoint(
    {
      id: "plans.action",
      group: "销售计划",
      name: "版本动作",
      method: "POST",
      path: "/sales-plan/plans/versions/{versionId}/actions",
      description: "保存、审批、驳回或提交节点纠偏决定。",
      requestFields: [
        "versionId",
        "expectedSnapshot",
        "expectedStatus",
        "action",
        "remark",
        "approvalRole",
        "adjustments",
      ],
      replayPolicy: "idempotent",
      replayNote: idempotent,
    },
    /^\/sales-plan\/plans\/versions\/[^/]+\/actions$/,
  ),
  endpoint(
    {
      id: "plans.versions",
      group: "销售计划",
      name: "计划版本",
      method: "GET",
      path: "/sales-plan/plans/{planId}/versions",
      description: "读取计划的历史版本。",
      requestFields: ["planId"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sales-plan\/plans\/[^/]+\/versions$/,
  ),
  endpoint(
    {
      id: "plans.logs",
      group: "销售计划",
      name: "审批日志",
      method: "GET",
      path: "/sales-plan/plans/{planId}/logs",
      description: "读取计划审批与操作日志。",
      requestFields: ["planId", "pageNo", "pageSize"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sales-plan\/plans\/[^/]+\/logs$/,
  ),
  endpoint(
    {
      id: "plans.compare",
      group: "销售计划",
      name: "版本比较",
      method: "GET",
      path: "/sales-plan/plans/{planId}/compare",
      description: "比较两个计划版本的 SKU 差异。",
      requestFields: ["planId", "fromVersionId", "toVersionId"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sales-plan\/plans\/[^/]+\/compare$/,
  ),
  endpoint(
    {
      id: "plans.detail",
      group: "销售计划",
      name: "计划详情",
      method: "GET",
      path: "/sales-plan/plans/{planId}",
      description: "读取当前版本、SKU、版本历史和审批上下文。",
      requestFields: ["planId"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/sales-plan\/plans\/[^/]+$/,
  ),
  endpoint(
    {
      id: "workflow.session",
      group: "工作流",
      name: "申请工作流会话",
      method: "POST",
      path: "/ai/gateway/agent/session",
      description: "按当前身份申请销售计划工作流读取会话。",
      requestFields: ["agentCode", "channel", "conversationId", "requestId"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/ai\/gateway\/agent\/session$/,
  ),
  endpoint(
    {
      id: "workflow.query",
      group: "工作流",
      name: "查询工作流配置",
      method: "POST",
      path: "/ai/gateway/sql/execute",
      description: "在临时委托会话中分页读取固定工作流配置。",
      requestFields: ["parameters", "pageNo", "pageSize", "includeTotal"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/ai\/gateway\/sql\/execute$/,
  ),
  endpoint(
    {
      id: "model.credentials",
      group: "个人模型",
      name: "模型凭证列表",
      method: "GET",
      path: "/aidata/user-agent-credential/my/list",
      description: "读取当前用户可用的 Agent 模型凭证记录。",
      requestFields: ["pageNo", "pageSize"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/aidata\/user-agent-credential\/my\/list$/,
  ),
  endpoint(
    {
      id: "model.claim",
      group: "个人模型",
      name: "领取模型凭证",
      method: "POST",
      path: "/aidata/user-agent-credential/my/claim",
      description: "领取一次短期模型访问凭证。",
      requestFields: ["id"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/aidata\/user-agent-credential\/my\/claim$/,
  ),
  endpoint(
    {
      id: "model.metadata",
      group: "个人模型",
      name: "模型元数据",
      method: "GET",
      path: "/airag/airagModel/queryById",
      description: "补充查询模型显示名称。",
      requestFields: ["id"],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/airag\/airagModel\/queryById$/,
  ),
  endpoint(
    {
      id: "model.list",
      group: "个人模型",
      name: "模型服务列表",
      method: "GET",
      path: "/models",
      description: "向个人模型服务读取可用模型列表。",
      requestFields: [],
      replayPolicy: "safe",
      replayNote: safe,
    },
    /^\/models$/,
  ),
  endpoint(
    {
      id: "model.chat",
      group: "个人模型",
      name: "模型流式推理",
      method: "POST",
      path: "/chat/completions",
      description: "向个人模型服务发起流式推理。",
      requestFields: ["model", "messages", "tools", "max_tokens"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/chat\/completions$/,
  ),
  endpoint(
    {
      id: "gateway.session",
      group: "MCP 网关",
      name: "申请 MCP 上下文",
      method: "POST",
      path: "/ai/gateway/session",
      description: "为 Agent 或客户端申请受控 MCP 网关上下文。",
      requestFields: [
        "consumerType",
        "consumerCode",
        "conversationId",
        "requestId",
        "channel",
      ],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/ai\/gateway\/session$/,
  ),
  endpoint(
    {
      id: "gateway.mcp",
      group: "MCP 网关",
      name: "MCP 代理",
      method: "POST",
      path: "/ai/gateway/mcp/proxy/mcp",
      description: "在已授权上下文中转发 MCP 协议消息。",
      requestFields: ["jsonrpc", "method", "params", "id"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/ai\/gateway\/mcp\/proxy\/mcp$/,
  ),
  endpoint(
    {
      id: 'gateway.authorized-resources', group: 'MCP 网关', name: '查询授权资源快照',
      method: 'POST', path: '/ai/gateway/mcp/proxy/resources',
      description: '在当前可信会话内读取指定工具的资源级授权快照。',
      requestFields: ['agentCode','mcpCode','toolName'], replayPolicy: 'blocked', replayNote: blocked,
    },
    /^\/ai\/gateway\/mcp\/proxy\/resources$/,
  ),
  endpoint(
    {
      id: "service.token",
      group: "服务账号重提",
      name: "交换服务令牌",
      method: "POST",
      path: "/api/v1/internal/auth/token",
      description: "为一次销售计划重提交换短期服务令牌。",
      requestFields: ["grant_type", "scope"],
      replayPolicy: "blocked",
      replayNote: blocked,
    },
    /^\/api\/v1\/internal\/auth\/token$/,
  ),
  endpoint(
    {
      id: "service.submit",
      group: "服务账号重提",
      name: "销售计划重提",
      method: "POST",
      path: "/api/v1/internal/sales-plans",
      description: "使用服务账号提交一份已完成来源校验的销售计划。",
      requestFields: [
        "planId",
        "versionId",
        "items",
        "periodMonth",
        "planTypeCode",
      ],
      replayPolicy: "idempotent",
      replayNote: idempotent,
    },
    /^\/api\/v1\/internal\/sales-plans$/,
  ),
];

export type ApiLogRecord = {
  id: string;
  sequence: number;
  catalogId: string | null;
  catalogName: string;
  group: string;
  environment: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome: "pending" | "success" | "error";
  replayPolicy: ApiReplayPolicy;
  replayAvailable: boolean;
  replayedFrom?: string;
  request: {
    method: string;
    url: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
  };
  error?: { name: string; message: string };
};

export type ApiLogSnapshot = {
  revision: number;
  limit: number;
  catalog: ApiCatalogEntry[];
  records: ApiLogRecord[];
};

type PrivateRecord = ApiLogRecord & {
  replay?: (
    signal: AbortSignal,
  ) => Promise<{ response: Response; recordId: string }>;
};

function sanitizeString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已脱敏]")
    .replace(
      /(client_secret|access_token|refresh_token|delegationToken|secret|password)=([^&\s]+)/gi,
      "$1=[已脱敏]",
    );
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return "[已脱敏]";
  if (depth > 12) return "[层级过深，未保存]";
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value))
    return value
      .slice(0, 1000)
      .map((item) => sanitizeValue(item, "", depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        sanitizeValue(item, name, depth + 1),
      ]),
    );
  return value;
}

function sanitizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [key, value] of new Headers(headers))
    result[key] = SENSITIVE_KEY.test(key) ? "[已脱敏]" : sanitizeString(value);
  return result;
}

function sanitizeUrl(raw: string): {
  url: string;
  path: string;
  query: Record<string, string>;
} {
  const parsed = new URL(raw);
  const query: Record<string, string> = {};
  for (const [key, value] of parsed.searchParams) {
    const safeValue = SENSITIVE_QUERY.test(key)
      ? "[已脱敏]"
      : sanitizeString(value);
    query[key] = safeValue;
    parsed.searchParams.set(key, safeValue);
  }
  return { url: parsed.toString(), path: parsed.pathname, query };
}

function bodyPreview(
  body: BodyInit | null | undefined,
  headers: Headers,
): unknown {
  if (body == null) return null;
  let text: string | undefined;
  if (typeof body === "string") text = body;
  else if (body instanceof URLSearchParams) text = body.toString();
  if (text === undefined) return "[二进制或流式请求正文未保存]";
  if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) return BODY_OMITTED;
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/x-www-form-urlencoded"))
    return sanitizeValue(Object.fromEntries(new URLSearchParams(text)));
  try {
    return sanitizeValue(JSON.parse(text));
  } catch {
    return sanitizeString(text);
  }
}

async function responsePreview(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("text/event-stream")) return STREAM_OMITTED;
  const body = response.clone().body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        // clone() 使用 tee；等待这一支 cancel 会等原响应也结束，形成返回前死锁。
        void reader.cancel();
        return BODY_OMITTED;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  try {
    return sanitizeValue(JSON.parse(text));
  } catch {
    return sanitizeString(text);
  }
}

function replayableBody(
  body: BodyInit | null | undefined,
): BodyInit | undefined | false {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  return false;
}

export class GeaApiLogCenter {
  private readonly records: PrivateRecord[] = [];
  private revision = 0;
  private sequence = 0;

  constructor(
    private readonly environment: () => string,
    private readonly limit = DEFAULT_LIMIT,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  readonly fetch: typeof fetch = (input, init) =>
    this.fetchRequest(input, init);

  private async fetchRequest(
    input: RequestInfo | URL,
    init?: RequestInit,
    replayedFrom?: string,
    onRecord?: (id: string) => void,
  ): Promise<Response> {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const originalHeaders =
      input instanceof Request ? input.headers : undefined;
    const requestHeaders = new Headers(originalHeaders);
    if (init?.headers)
      for (const [key, value] of new Headers(init.headers))
        requestHeaders.set(key, value);
    const requestBody = init?.body;
    const safeUrl = sanitizeUrl(rawUrl);
    const catalog = CATALOG.find((entry) =>
      entry.matches(method, safeUrl.path),
    );
    const started = Date.now();
    const record: PrivateRecord = {
      id: randomUUID(),
      sequence: ++this.sequence,
      catalogId: catalog?.id ?? null,
      catalogName: catalog?.name ?? "未登记接口",
      group: catalog?.group ?? "未登记",
      environment: this.environment(),
      startedAt: new Date(started).toISOString(),
      outcome: "pending",
      replayPolicy: catalog?.replayPolicy ?? "blocked",
      replayAvailable: false,
      ...(replayedFrom ? { replayedFrom } : {}),
      request: {
        method,
        ...safeUrl,
        headers: sanitizeHeaders(requestHeaders),
        body: bodyPreview(requestBody, requestHeaders),
      },
    };
    const body = replayableBody(requestBody);
    if (
      catalog &&
      catalog.replayPolicy !== "blocked" &&
      !(input instanceof Request) &&
      body !== false
    ) {
      const { signal: _originalSignal, ...stableInit } = init ?? {};
      const replayInit: RequestInit = {
        ...stableInit,
        headers: new Headers(requestHeaders),
        body,
      };
      record.replayAvailable = true;
      record.replay = (signal) =>
        this.fetchWithSource(
          rawUrl,
          {
            ...replayInit,
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          },
          record.id,
        );
    }
    this.prepend(record);
    onRecord?.(record.id);
    try {
      // 未注入实现时在调用时读取全局 fetch，保留测试、代理和运行时替换能力。
      const response = await (this.fetchImpl ?? globalThis.fetch)(input, init);
      record.response = {
        status: response.status,
        statusText: response.statusText,
        headers: sanitizeHeaders(response.headers),
        body: await responsePreview(response),
      };
      record.outcome = response.ok ? "success" : "error";
      this.finish(record, started);
      return response;
    } catch (error) {
      record.outcome = "error";
      record.error = {
        name: error instanceof Error ? error.name : "Error",
        message: sanitizeString(
          error instanceof Error ? error.message : String(error),
        ),
      };
      this.finish(record, started);
      // 线上实测：这类失败原样抛出去，界面只有 `fetch failed` + UNKNOWN（真实原因在 cause 里）。
      // 统一翻成可读、带 code 的错误，并把"在连哪个接口"写进去。
      throw networkError(error, {
        what: safeUrl.path,
        stage: "请求",
      });
    }
  }

  // 私有第三个参数只由重发闭包使用；保持公开调用仍兼容 typeof fetch。
  private async fetchWithSource(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    replayedFrom: string,
  ): Promise<{ response: Response; recordId: string }> {
    let recordId = "";
    const response = await this.fetchRequest(
      input,
      init,
      replayedFrom,
      (id) => {
        recordId = id;
      },
    );
    if (!recordId) throw new Error("API_LOG_REPLAY_RECORD_MISSING");
    return { response, recordId };
  }

  snapshot(): ApiLogSnapshot {
    return {
      revision: this.revision,
      limit: this.limit,
      catalog: CATALOG.map(({ matches: _matches, ...entry }) => ({ ...entry })),
      records: this.records.map(({ replay: _replay, ...record }) =>
        structuredClone(record),
      ),
    };
  }

  clear(): ApiLogSnapshot {
    this.records.length = 0;
    this.revision++;
    return this.snapshot();
  }

  invalidateReplays(): void {
    let changed = false;
    for (const record of this.records) {
      if (!record.replayAvailable && !record.replay) continue;
      record.replayAvailable = false;
      record.replay = undefined;
      changed = true;
    }
    if (changed) this.revision++;
  }

  async replay(
    id: string,
    confirmed: boolean,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ recordId: string }> {
    const target = this.records.find((record) => record.id === id);
    if (!target) throw new Error("API_LOG_NOT_FOUND");
    if (!target.replayAvailable || !target.replay)
      throw new Error("API_LOG_REPLAY_UNAVAILABLE");
    if (target.replayPolicy === "idempotent" && !confirmed)
      throw new Error("API_LOG_REPLAY_CONFIRMATION_REQUIRED");
    const { response, recordId } = await target.replay(signal);
    await response.body?.cancel();
    return { recordId };
  }

  private prepend(record: PrivateRecord): void {
    this.records.unshift(record);
    if (this.records.length > this.limit) this.records.length = this.limit;
    this.revision++;
  }

  private finish(record: PrivateRecord, started: number): void {
    record.endedAt = new Date().toISOString();
    record.durationMs = Date.now() - started;
    this.revision++;
  }
}

import { attachDesktopLogin } from "./host/desktop-login.ts";
import { createDesktopNavigation } from './host/desktop-navigation.ts';
import { attachWebLogin } from "./host/web-login.ts";
import { resolveWorkbench } from "../scripts/deployment.mjs";
/** GEA 外部 Fetch 能力和显式本地回执提供者的 DSH 插件入口。 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import {
  LlmAdapter,
  ReasoningEffortId,
  createUserMessage,
  type GenerateOptions,
  type LlmReasoningEffortInfo,
  type StreamChunk,
  attributionHeaders,
  type ContentBlock,
} from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { Business, object, type Deployment } from "./host/business.ts";
import { errorEnvelope } from "./host/error-envelope.ts";
import { surfacePromptLine } from "./host/workbench-surface.ts";
import { mountTurnAnchor } from "./host/turn-anchor.ts";
import { registerHtmlPlugins, type PageBridgeHost } from "./html-plugins.ts";
import { injectPageScan } from "./html-page-scan.ts";
import { registerGeaTools } from "./host/agent-tools.ts";
import {
  createPageBridge,
  createPageToolRegistry,
} from "./page-bridge/index.ts";
import { createCapabilityRegistry } from "./capability/registry.ts";
import { workbenchContract } from "./capability/contract.ts";
import { WORKBENCH_SURFACE } from "./shared/workbench-actions.ts";
import { transportSignal } from "./shared/transport-signal.ts";
import { geaTextStream } from "./shared/gea-stream.ts";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-agent-default-model";

export const inject = [
  "agents",
  "connection",
  "tools",
  "llm",
  "sessionController",
  "agentDefaultModel",
];
export const Config = z.object({
  geaBaseUrl: z.string().required(),
  pageSize: z.natural().min(1).max(100).required(),
  periodPageSize: z.natural().min(1).max(1000).required(),
  requestTimeoutMs: z.natural().min(1000).max(120000).required(),
  mcpRequestTimeoutMs: z.natural().min(1000).max(120000).default(60000),
  modelRequestTimeoutMs: z.natural().min(1000).max(600000).default(120000),
  maxSnapshotBytes: z.natural().min(1000).max(5000000).required(),
  runtimeDir: z.string().required(),
  analysisMode: z.union(["receipt", "model"]).required(),
  analysisModel: z.string().required(),
  inputByteBudget: z.natural().min(1).required(),
  /**
   * 问答侧是否允许调用受管只读 SQL（`/ai/gateway/sql/execute`）。
   * 默认关闭：问答取数只走模块 MCP + 页面证据，模型不再自己写 SQL。
   */
  agentSqlRead: z.boolean().default(false),
});

/** 执行标准模型调用，但不发起外部推理请求。 */
class ReceiptAdapter extends LlmAdapter {
  constructor(
    private readonly config: Deployment,
    private readonly runId: string,
  ) {
    super();
  }
  override providerInfo(id: string) {
    return { id, name: "GEA local receipt (no AI)" };
  }
  override async listModels(provider: string) {
    return [{ provider, id: "receipt", name: "Local receipt / 本地验证回执" }];
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const request = JSON.stringify(options.messages);
    const text =
      "本地验证回执（非 AI 分析）：业务资料已进入会话。\n\n这是数据传递验证，不构成审批意见。";
    await mkdir(this.config.runtimeDir, { recursive: true, mode: 0o700 });
    await appendFile(
      resolve(this.config.runtimeDir, "receipts.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        runId: this.runId,
        requestHash: createHash("sha256").update(request).digest("hex"),
        provider: options.provider,
        model: options.model,
      }) + "\n",
      { mode: 0o600 },
    );
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

/**
 * 可选推理档位。GEA 个人模型网关把 `extra_params` 的顶层键覆盖到模型配置的默认
 * extraParams，再由上游 provider 解析 `reasoning_effort`；平台本身不定义档位名，
 * 所以档位由客户端给出。上游只认接入手册里给过的那两个取值（`high` / `max`），
 * 因此这里只暴露这两档，默认 `high`；`off` 是 DSH 内部的 thinking 开关，不在
 * wire 协议里，不能透传。
 */
const GEA_REASONING_EFFORTS: readonly LlmReasoningEffortInfo[] = [
  {
    id: ReasoningEffortId("high"),
    name: "高",
    description: "默认档，适合大多数业务问题。",
  },
  {
    id: ReasoningEffortId("max"),
    name: "最高",
    description: "复核、对比与难取数任务，耗时更长。",
  },
];

/** 用户未选档位时materialize的默认档位。 */
const GEA_DEFAULT_REASONING_EFFORT = ReasoningEffortId("high");

/** 网关只接受非空字符串，且单次覆盖的键值有长度上限；不合法就保持改造前行为。 */
const GEA_EFFORT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * 把所选档位映射成网关契约里的 `extra_params`。取值不合法时返回 undefined，
 * 请求体不带该字段，服务端保持模型配置默认参数。未显式选择时，DSH 会先按模型声明的
 * `defaultEffort` 补上默认档位再调用，所以正常路径下这里总能拿到一个档位。
 */
function geaExtraParams(
  options: GenerateOptions,
): Record<string, string> | undefined {
  const effort = options.reasoningEffort;
  if (effort === undefined) return undefined;
  const value = String(effort);
  if (!GEA_EFFORT_PATTERN.test(value)) return undefined;
  return { reasoning_effort: value };
}

/**
 * `selectModel` 与 `saveSelection` 都是整体覆盖：不显式带上已选档位就会把它清掉。
 * 档位只存在默认选择里，这里读回来并在仍是本适配器声明的档位时沿用。
 */
function geaKeptReasoningEffort(current: {
  provider?: string;
  reasoningEffort?: ReasoningEffortId;
}): ReasoningEffortId | undefined {
  const effort = current.reasoningEffort;
  if (current.provider !== "gea-analysis" || effort === undefined)
    return undefined;
  return GEA_REASONING_EFFORTS.some((item) => String(item.id) === String(effort))
    ? effort
    : undefined;
}

/** 直接调用当前登录用户的 GEA 个人模型路由，不经过 AionUi 代理。 */
class GeaModelAdapter extends LlmAdapter {
  constructor(private readonly business: Business, private readonly htmlConsumer: (session?: string) => string | undefined = () => undefined) {
    super();
  }
  override providerInfo(id: string) {
    return { id, name: "GEA personal model" };
  }
  async listModels(provider: string) {
    const route = await this.business.modelRoute(
      new AbortController().signal,
      this.business.config.analysisAgentCode,
    );
    return route.models.map((id) => ({ provider, id, name: route.names[id] }));
  }
  async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    const route = await this.business.modelRoute(
      signal ?? new AbortController().signal,
      this.business.config.analysisAgentCode,
    );
    return {
      provider,
      id: model,
      name: route.names[model] ?? "GEA 模型（名称未提供）",
      // 声明默认档位：用户没显式选档位时，DSH 会补上它并按 extra_params 发给网关。
      reasoning: {
        efforts: GEA_REASONING_EFFORTS,
        defaultEffort: GEA_DEFAULT_REASONING_EFFORT,
      },
    };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const transport = transportSignal(
      AbortSignal.any([
        options.signal ?? new AbortController().signal,
        this.business.identitySignal(),
        AbortSignal.timeout(this.business.config.modelRequestTimeoutMs),
      ]),
    );
    const signal = transport.signal;
    try {
      const route = await this.business.modelRoute(
        signal,
        this.htmlConsumer(options.sessionId) ?? this.business.config.analysisAgentCode,
      );
      if (!route.models.includes(options.model))
        throw new Error("GEA_MODEL_NOT_FOUND");
      const requestBody = toGeaRequest(options);
      const response = await this.business.fetchExternal(route.baseUrl + "/chat/completions", {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...attributionHeaders(),
          Authorization: "Bearer " + route.secret,
          "X-GEA-Agent-Code": route.agentCode,
        },
        body: JSON.stringify(requestBody),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        if (response.status === 401) this.business.expireModelLogin();
        throw new Error("GEA_MODEL_HTTP_" + response.status);
      }
      if (!response.body) throw new Error("GEA_MODEL_HTTP_NO_BODY");
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("text/event-stream")
      )
        throw new Error("GEA_MODEL_NOT_SSE");
      yield* geaTextStream(response.body, signal, {
        names: options.tools?.map((tool) => tool.name) ?? [],
        maxBytes: this.business.config.maxSnapshotBytes,
      });
    } finally {
      transport.dispose();
    }
  }
}

type GeaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

function textContent(content: ContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

function toGeaMessages(options: GenerateOptions): GeaMessage[] {
  const messages: GeaMessage[] = [];
  if (options.system !== undefined)
    messages.push({ role: "system", content: options.system });
  for (const message of options.messages) {
    if (message.role === "system") {
      const content = textContent(message.content);
      if (content) messages.push({ role: "system", content });
      continue;
    }
    const toolResults = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool-result" }> =>
        block.type === "tool-result",
    );
    if (toolResults.length > 0) {
      for (const result of toolResults)
        messages.push({
          role: "tool",
          tool_call_id: result.toolCallId,
          content: textContent(result.content) || "(no output)",
        });
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.content
        .filter(
          (block): block is Extract<ContentBlock, { type: "tool-call" }> =>
            block.type === "tool-call",
        )
        .map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        }));
      messages.push({
        role: "assistant",
        content: textContent(message.content) || undefined,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    messages.push({ role: "user", content: textContent(message.content) });
  }
  return messages;
}

function toGeaRequest(options: GenerateOptions) {
  const extraParams = geaExtraParams(options);
  return {
    model: options.model,
    messages: toGeaMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    ...(extraParams === undefined ? {} : { extra_params: extraParams }),
    ...(options.tools && options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: tool,
          })),
        }
      : {}),
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined ? {} : { stop: options.stop }),
  };
}

/** 注册需要身份验证的 Web 路由；浏览器授权由标准 DSH connection 负责。 */
export async function apply(ctx: Context, config: Deployment): Promise<void> {
  resolveWorkbench(import.meta.url);
  const htmlPluginRoots: Record<string, string> = (() => {
    try { const value = JSON.parse(process.env.GEA_HTML_PLUGIN_ROOTS ?? "{}"); return value && typeof value === "object" ? value : {}; }
    catch { return {}; }
  })();
  for (const [id, root] of Object.entries(htmlPluginRoots)) {
    if (!/^[a-z0-9-]+$/.test(id) || typeof root !== "string") continue;
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/gea-html-plugin/${id}`, methods: ["GET"], requestBody: "buffered",
      fetch: async () => new Response(injectPageScan(await readFile(resolve(root, "index.html"), "utf8")), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "frame-ancestors 'self'" },
      }),
    }));
  }
  const workbenchHtml =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>GEA</title><link rel="stylesheet" href="/api/gea-proof/workbench.css"><style>html,body,#gea-workbench{height:100%;margin:0}</style></head><body><div id="gea-workbench"></div><script type="module" src="/api/gea-proof/workbench.js"></script></body></html>';
  for (const [path, type, content] of [
    [
      "workbench",
      "text/html; charset=utf-8",
      () => Promise.resolve(workbenchHtml),
    ],
    [
      "workbench.css",
      "text/css; charset=utf-8",
      () => readFile(new URL("./workbench.css", import.meta.url), "utf8"),
    ],
    [
      "workbench.js",
      "text/javascript; charset=utf-8",
      () => readFile(new URL("./workbench.js", import.meta.url), "utf8"),
    ],
  ] as const)
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: "/api/gea-proof/" + path,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async () =>
          new Response(await content(), {
            headers: {
              "Content-Type": type,
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "frame-ancestors 'self'",
            },
          }),
      }),
    );
  const pageBridge = createPageBridge();
  const business = new Business(config, pageBridge);
  const desktopLogin = await attachDesktopLogin(business);
  const webLogin = await attachWebLogin(business);
  const htmlRootConfig=JSON.parse(process.env.GEA_HTML_PLUGIN_ROOTS || "[]");
  const htmlRoots=Array.isArray(htmlRootConfig) ? htmlRootConfig : (htmlRootConfig && typeof htmlRootConfig === "object" ? Object.values(htmlRootConfig) : []);
  if(htmlRoots.some(root=>typeof root!=="string"))throw Error("INVALID_HTML_PLUGIN_ROOTS");
  // 迁移页面的页面桥入口：注册表建好后再接上（页面第一次轮询是 500ms 之后）。
  const pageBridgeHost: PageBridgeHost = {};
  const htmlPlugins=await registerHtmlPlugins(ctx,business,htmlRoots,pageBridgeHost);
  // 能力契约注册表：页面白名单、草稿白名单、只读模块清单全部由它产出，宿主不再按模块写分支。
  const capability = createCapabilityRegistry([
    ...htmlPlugins.capabilityContracts,
    workbenchContract({
      surface: WORKBENCH_SURFACE,
      pageIds: [WORKBENCH_SURFACE],
      keywords: ["区域计划", "审批", "销售计划", "计划量"],
    }),
  ]);
  // 受管只读的模块白名单也来自契约：不再在业务代码里维护一份模块清单。
  business.setPluginConsumers(
    capability
      .readModules()
      .map((contract) => contract.data!.consumerCode),
  );
  // 页面自述能力 -> 该会话专属的模型工具（页面关闭即注销）。
  const pageTools = createPageToolRegistry(ctx, pageBridge, {
    stateSnapshot: (sessionId) => business.workbenchStateSnapshot(sessionId),
    // 只有"随客户端安装、且契约里声明了页面"的模块才允许被对话操作。
    allowSurfaces: capability.surfaces(),
    // 契约声明到草稿及以上等级的页面，才允许通过对话写页面草稿。
    dataActionSurfaces: capability.draftSurfaces(),
    // 提交/审批类元素只有契约声明到该等级的页面才允许下发。
    allowsEffect: (surface, effect) => capability.allows(surface, effect),
    // 工作台会话里不让它用浏览器/MCP 去扒页面数据（普通对话不受影响）。
    denyGlobalToolsInWorkbench: [
      "mcp__browser__browser_find",
      "mcp__browser__browser_evaluate",
      "mcp__browser__browser_navigate",
      "mcp__browser__browser_snapshot",
    ],
  });
  // 身份变化后旧会话的页面工具一律注销；页面下一轮声明会重新注册。
  ctx.effect(() => business.watchIdentity(() => pageTools.disposeAll()));
  const desktopNavigation = createDesktopNavigation(business);
  ctx.effect(() => () => desktopNavigation.dispose());
  pageBridgeHost.declare = (sessionId, catalog, source) =>
    pageTools.declare(sessionId, catalog, source);
  ctx.provide("geaMcp", {
    version: 1 as const,
    defaultConsumer: { consumerType: "AGENT" as const, consumerCode: config.analysisAgentCode },
    authenticated: () => business.status().authenticated,
    watch: (listener: () => void) => business.watchIdentity(listener),
    open: (consumer: { consumerType: "AGENT" | "CLIENT_APP"; consumerCode: string }, signal: AbortSignal) => business.openMcpConnection(consumer, signal),
  });
  registerGeaTools(ctx, business, capability);
  // 登记 37：客户端所有 agent（含默认预设）都要能取到工作台之外的数据。
  // 网关 MCP 的工具描述由 GEA 侧给出，模型容易猜错调用形状（实测报
  // "queries.query 必须是 Cube 查询对象"、"成员未唯一匹配数据目录资源"、"Resource URI 不合法"），
  // 这里在系统提示里补一份最小取数协议，全局生效、不依赖某个预设。
  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: "gea:gateway-mcp-protocol",
      order: 120,
      text: [
        "GEA 网关 MCP 取数协议（只有工作台页面上看不到的数据才用它）：",
        "- 计划事实（提报状态、版本、明细、变更记录）优先用 gea_sales_plan_read；历史发货、经销商/分仓库存、货龄、补货周期、政策、节令、把握度，以及知识库类问题，用当前已加载的 GEA 网关 MCP 工具——**统一经 gea_module_mcp 调用**（给定 consumerCode + tool + arguments）。不要直接用平台直挂的 `mcp__gea-gateway__*` 工具：那条路的失败是原始报文，宿主不会把它翻成可读原因，也不会替你收口。",
        "- 先取语义模型目录再查询：调用 gea_gateway_catalog（需要看某个模型时带 model=模型名），拿到模型名与成员名；成员名照抄，不要凭业务名猜。**model 只填模型名（英文标识）或它的子串**；把业务词当模型名是命中不到的——这时目录不会报错，而是按内容把最像的模型和完整索引回给你，照它挑一个再调即可，不要重复猜名字。目录里的成员名形如 模型.字段，就是查询时要用的成员。成员名后的 [time]/[number] 是类型：`[time]` 取值要写完整日期，`[number]` 只是数值类型的维度（仍放 dimensions）。拿不准某个成员的值长什么样时，用 `members=[成员名…] + values=true` 先取一行真实值，照它的格式写查询。",
        '- 不要自己去读 inspect 的原始产物：它约 33 万字符，宿主只会内联前 30KB，剩下的存成本机文件，你没有读文件的工具。目录工具已经把它压到可一次读完的大小。',
        '- 再查询：action="query"，queries 放 1 到 8 个具名 Cube 查询对象，每项形如 {"name":"<别名>","query":{…}}，其中 query 必须是 Cube 查询对象（不能写成字符串或自然语言）；response_mode 默认 "resource"，只有需要直接看行时才用 "inline_complete"。',
        '- Cube 查询对象里**只放这几个键**：dimensions（成员名数组）、measures（成员名数组）、filters（[{"member":成员,"operator":"equals|contains|…","values":[…]}]）、order、limit。不确定形状时先 `tool=query_business_data` + `schema=true` 读服务端定义；服务端当前没声明到的嵌套形状（order 就是），以它返回的校验报错为准——这几行只是 schema 补全前的临时说明。',
        '- order 的写法：**推荐对象 {"<成员名>":"asc"|"desc"}**；要写成数组时，每个元素必须是 [成员, 方向] 两元组，例如 [["模型.字段","desc"]]。别用 {"member":…,"direction":…} 这类别的形状；网关回 AI_SCHEMA_INVALID 时，照它给的字段与格式要求改好再调一次，不要用同一份参数原样重试。',
        "- 一次只查一个模型：同一次调用的成员必须属于同一个 dataAssetCode，跨模型要分开调用；报“成员未唯一匹配数据目录资源”就是这条没满足。",
        "- 成员放 dimensions 还是 measures **由目录标出的类型决定**：只有目录里“度量”下列出的成员才写进 measures；标了“无度量”的模型（库存、库存快照、补货周期这几类基本都是）全部成员——数值字段也一样——只能放 dimensions。线上实测：把数值字段写进 measures，上游 Cube 会直接拒绝整批查询计划。",
        "- **要“合计 / 平均 / 最大最小 / 计数”时先用度量，不要拉明细本地算**：目录里列在“度量”下的成员（形如 模型.current_inventory_sum、模型.sku_count）直接写进 query.measures，一次调用出结果。线上实测：同一张库存表用明细求和要 100 行 ≈ 12 万字符，还可能撞到数据授权上限被拒；用度量只要 1 行、几百字节。",
        '- 用度量聚合前**先钉住口径**：像安全库存这种“快照 × 计划版本 × 目标月”的表，必须在 filters 里给 `inventory_snapshot_time` 和 `inventory_version`（能一起给 `target_month` 就给）；目录里标了“分段”的优先用它的分段（例如 segments 里放 agents_scm_safety_stock.latest_snapshot 表示只算最新快照）。不钉就会把月初/纠偏/多个快照重复累加，数会虚高。',
        "- 目录里标“无度量”的模型聚合不了：这时**只取必需的那几列**（2–4 列），再用时间/版本把范围钉小；不要一次取十几列、上百行。确实需要合计就如实说明“这张表当前没有可聚合度量”，不要拿前 N 行硬加出总数。",
        "- 极值分两种问法：“最大/最小是多少”用 max/min 度量；“哪个 SKU 最大、哪几行最高”用维度排序取 TopN（度量只给数值，不会告诉你行标识）。",
        "- 要明细清单时用 limit 分页；**行数正好等于 limit 时说明可能还有更多**（返回里的 totalRows/complete/hasMore 只描述这一次查询窗口，不代表业务全集），接着翻页确认，或者改用度量。",
        "- 如果 Cube 回 `'某个成员' not found for path '模型.某成员'`：先怀疑这个成员被放进了 measures（这些 cube 多数只有 dimensions）。成员在目录里列过就说明它存在，不要改去猜别的名字或换模型。",
        "- 日期/时间成员（snapshot_date、snapshot_time、target_month、stat_date、inventory_snapshot_time 这类）的值必须是完整日期 `YYYY-MM-DD`（带时间的用 `YYYY-MM-DD HH:mm:ss`）：写 `2026-09` 这种只有年月的值，Cube 会以 `invalid input syntax for type date` 报错。拿不准就先查一次该成员的现有值，再照抄格式。",
        '- 结果返回 `data-artifact://gateway/…` 链接时：**gea_module_mcp 的结果宿主已经把正文读回来内联了，不需要你再读一次**。**大结果只内联第一段**，正文里会写明"只内联了前 N 字符，全文 M 字符"；要接着看就再调一次 gea_module_mcp（consumerCode 同上 + `artifact="`原样的 data-artifact:// URI`"` + `offset=`上一段结尾给的位置），**不要重复跑整条大查询**，也不要自己拼 URI、不要当 HTTP 链接去抓。正文里若写"还有几个制品没有内联"，同样用 `artifact=<URI>` 去读那几个。万一是平台直挂的网关工具返回链接，才用 read_mcp_resource，且 server 必须是网关那一个（gea-gateway）——**绝不要用 browser**（那个服务没连，只会报 server is disconnected，白跑一轮）。',
        "- 报错先按错误文本改参数再试一次；同一错误不要连续重试，更不要改用编造的数据或改写用户的问题。",
      ].join("\n"),
    });
    // 每个模型步骤都把"这个对话在不在业务工作台、在哪一页菜单"作为宿主事实注入。
    // 位置判定(host/workbench-surface.ts)本身是对的，但模型看不到，只能先调页面
    // 工具去问一次——那一次必然白跑。这里让它第一步就知道该走哪条通道。
    promptCtx.systemPrompt.section({
      name: "gea:workbench-surface",
      order: 121,
      text: (assembly) => {
        const sessionId = (assembly as { agent?: { id?: string } }).agent?.id;
        return sessionId
          ? surfacePromptLine(business.surfaceFor(sessionId))
          : "";
      },
    });
  });
  // 每步把"用户这一轮问的是什么"钉在消息末尾：系统提示里的位置段只能劝阻，
  // 长轮次（一轮 17 次工具调用）里模型会把用户那条消息丢掉，最后说自己"没收到提问"。
  ctx.effect(() => mountTurnAnchor(ctx));
  ctx.effect(() => async () => { await desktopLogin.dispose(); await webLogin.dispose(); business.dispose(); });
  if (config.analysisMode === "receipt")
    ctx.effect(() =>
      ctx.llm.registerAdapter(
        ["gea-proof"],
        new ReceiptAdapter(config, business.runId),
      ),
    );
  if (config.analysisMode === "model" && config.analysisSource === "gea")
    ctx.effect(() =>
      ctx.llm.registerAdapter(["gea-analysis"], new GeaModelAdapter(business, htmlPlugins.consumerForSession)),
    );
  let submission:
    | {
        id: string;
        sessionId: SessionId;
        result?: Promise<{ sessionId: SessionId }>;
      }
    | undefined;
  function submit(payload: Record<string, unknown>, requestSignal: AbortSignal) {
    if (
      Object.keys(payload).some(
        (key) => key !== "previewId" && key !== "workbenchContext",
      )
    )
      throw new Error("INVALID_PAYLOAD");
    const preview = business.prepared(payload.previewId);
    const workbenchContext =
      payload.workbenchContext === undefined
        ? undefined
        : object(payload.workbenchContext);
    requestSignal.throwIfAborted();
    if (submission?.id !== preview.previewId)
      submission = {
        id: preview.previewId,
        sessionId: brandString<SessionId>(`session-${randomUUID()}`),
      };
    const attempt = submission;
    if (workbenchContext)
      business.updateVisibleWorkbenchContext(attempt.sessionId, workbenchContext);
    if (attempt.result) return attempt.result;
    const signal = business.admissionSignal(requestSignal);
    attempt.result = (async () => {
      signal.throwIfAborted();
      let selectedModel = config.analysisModel;
      if (config.analysisMode === "model" && config.analysisSource === "gea") {
        const route = await business.modelRoute(
          signal,
          config.analysisAgentCode,
        );
        selectedModel = route.models.includes(config.analysisModel)
          ? config.analysisModel
          : route.models[0]!;
      }
      const session = await ctx.sessionController.create({
        sessionId: attempt.sessionId,
        cwd: resolve(config.runtimeDir, "workspace"),
        agentPreset: "gea-readonly",
      });
      signal.throwIfAborted();
      business.prepared(preview.previewId);
      // selectModel 同样是整体覆盖，不带上档位会把它清掉。
      const keptEffort =
        config.analysisMode === "model" && config.analysisSource === "gea"
          ? geaKeptReasoningEffort(ctx.agentDefaultModel.currentSelection())
          : undefined;
      await ctx.sessionController.selectModel({
        sessionId: session.sessionId,
        provider:
          config.analysisMode === "model" ? "gea-analysis" : "gea-proof",
        model: selectedModel,
        ...(keptEffort === undefined ? {} : { reasoningEffort: keptEffort }),
      });
      signal.throwIfAborted();
      business.prepared(preview.previewId);
      await business.archivePreview(session.sessionId, preview);
      signal.throwIfAborted();
      business.prepared(preview.previewId);
      const agent = ctx.agents.get(session.sessionId);
      if (!agent) throw new Error("SESSION_NOT_FOUND");
      agent.followup(
        createUserMessage({
          source: {
            kind: "plugin",
            plugin: "gea-proof",
            form: "notice",
            summary:
              config.analysisMode === "receipt"
                ? "已提交只读快照，正在验证数据传递"
                : "已提交只读分析：对比所选计划的数量和金额差异",
          },
          content: [{ type: "text", text: preview.prompt }],
        }),
      );
      return session;
    })().catch((error: unknown) => {
      // admission 可能已在失败前成功，因此保留已生成的身份标识。
      attempt.result = undefined;
      throw error;
    });
    return attempt.result;
  }
  const endpoints = [
    "navigation/poll",
    "navigation/finish",
    "navigation/retry",
    "status",
    "notifications",
    "workflow/config",
    // 界面刷新时重新解析账号角色（管理员刚改完权限不必重新登录）。
    "approval/roles",
    "sales-plan/action",
    "sales-plan/draft",
    "sales-plan/submit",
    "environment/select",
    "model/discover",
    "model/advice",
    "logout",
    "login/start",
    "login/poll",
    "periods",
    "plans",
    "detail",
    "versions",
    "skus",
    "prepare",
    "submit",
    "workbench/query",
    "plugin/sql",
    "workbench/prepare",
    "workbench/context",
    "agui/workbench",
    // 前端上报"这个对话现在停在哪一页菜单"（默认主对话，点菜单时带菜单名）。
    "surface",
    "api-log/snapshot",
    "api-log/replay",
    "api-log/clear",
    // 只在显式打开调试开关时注册：逐个模块真跑一遍 MCP，并把原始报文带回来。
    ...(process.env.GEA_DEBUG_PROBE === "1" ? ["debug/mcp-probe"] : []),
  ];
  for (const endpoint of endpoints)
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: "/api/gea-proof/" + endpoint,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request: Request) => {
          try {
            const payload = object(await request.json());
            let value: unknown;
            switch (endpoint) {
              case "navigation/poll":
              case "navigation/retry":
                if (Object.keys(payload).length) throw Error('NAVIGATION_REQUEST_INVALID');
                value = endpoint === 'navigation/poll' ? await desktopNavigation.poll() : await desktopNavigation.retry();
                break;
              case "navigation/finish":
                value = await desktopNavigation.finish(payload);
                break;
              case "api-log/snapshot":
                value = business.apiLogSnapshot(payload);
                break;
              case "api-log/replay":
                value = await business.apiLogReplay(payload, request.signal);
                break;
              case "api-log/clear":
                value = business.apiLogClear(payload);
                break;
              case "debug/mcp-probe":
                value = await business.debugProbeModuleMcp(
                  String(payload.consumerCode ?? ""),
                  request.signal,
                );
                break;
              case "workbench/query":
                value = await business.workbenchQuery(payload, request.signal);
                break;
              case "plugin/sql":
                value = await business.pluginSql(payload, request.signal);
                break;
              case "workbench/prepare":
                value = await business.prepareWorkbench(
                  payload,
                  request.signal,
                );
                break;
              case "agui/workbench": {
                if (
                  Object.keys(payload).some(
                    (key) =>
                      key !== "sessionId" &&
                      key !== "toolMessages" &&
                      key !== "catalog",
                  )
                )
                  throw new Error("INVALID_AGUI_REQUEST");
                if (typeof payload.sessionId !== "string")
                  throw new Error("INVALID_WORKBENCH_SESSION");
                try {
                  // 审批工作台是自述型页面：目录由页面自己报。
                  pageTools.declare(payload.sessionId, payload.catalog, "self-report");
                } catch (error) {
                  // 页面声明无效（例如说明超长）会让工具注册不上，页面侧又是静默重试，
                  // 必须留一条日志，避免"功能突然不可用但没有任何线索"。
                  console.log(
                    `[page-bridge] declare rejected session=${payload.sessionId} code=${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
                value = business.pullPageBridgeEvents(
                  payload.sessionId,
                  payload.toolMessages,
                );
                break;
              }
              case "workbench/context": {
                if (
                  Object.keys(payload).some(
                    (key) => key !== "sessionId" && key !== "context",
                  )
                )
                  throw new Error("INVALID_WORKBENCH_CONTEXT");
                if (typeof payload.sessionId !== "string")
                  throw new Error("INVALID_WORKBENCH_SESSION");
                const sessionId = payload.sessionId;
                if (payload.context === null) {
                  business.clearVisibleWorkbenchContext(sessionId);
                  value = { synced: false };
                } else {
                  business.updateVisibleWorkbenchContext(sessionId, object(payload.context));
                  value = { synced: true };
                }
                break;
              }
              case "sales-plan/submit":
                value = await business.salesPlanSubmit(payload, request.signal);
                break;
              case "surface": {
                // 菜单状态只有"哪个会话 + 哪个菜单"两件事，多一个字段都拒掉，防止被当成旁路写入。
                if (
                  Object.keys(payload).some(
                    (key) =>
                      key !== "sessionId" && key !== "menu" && key !== "title",
                  )
                )
                  throw new Error("INVALID_SURFACE_REQUEST");
                if (typeof payload.sessionId !== "string")
                  throw new Error("INVALID_WORKBENCH_SESSION");
                const surface = business.setSurface(payload.sessionId, {
                  menu: payload.menu,
                  title: payload.title,
                });
                console.log(
                  `[workbench-surface] session=${payload.sessionId} menu=${surface.menu} title=${surface.title}`,
                );
                value = { synced: true, menu: surface.menu, title: surface.title };
                break;
              }
              case "sales-plan/draft":
                value = await business.salesPlanDraft(payload, request.signal);
                break;
              case "sales-plan/action":
                value = await business.salesPlanAction(payload, request.signal);
                break;
              case "workflow/config":
                value = await business.workflowConfig(payload, request.signal);
                break;
              // 界面上的「刷新」会走这里：重新解析当前账号角色，管理员刚改完权限的人也
              // 不用重新登录就能看到新的可审批节点。
              case "approval/roles":
                await business.refreshApprovalRoles(request.signal, { force: true });
                value = { roles: business.status().roles ?? [] };
                break;
              case "notifications":
                value = await business.notifications(payload, request.signal);
                break;
              case "status":
                await Promise.all([
                  business.refreshMissingAvatar(request.signal),
                  business.refreshPermissions(request.signal),
                  business.refreshApprovalRoles(request.signal),
                ]);
                // 前端不写死"哪个页面属于哪个模块"：模块索引由能力契约产出。
                value = {
                  ...business.status(),
                  htmlPlugins: htmlRoots.length > 0,
                  modules: capability.modules(),
                };
                break;
              case "model/advice": {
                if (!business.status().authenticated) throw new Error("LOGIN_REQUIRED");
                if (config.analysisMode !== "model") throw new Error("GEA_ADVICE_MODEL_REQUIRED");
                if (typeof payload.question !== "string" || !payload.question.trim() || Buffer.byteLength(payload.question) > config.inputByteBudget)
                  throw new Error("INVALID_ADVICE_INPUT");
                const signal = AbortSignal.any([request.signal, business.identitySignal(), AbortSignal.timeout(config.modelRequestTimeoutMs)]);
                let model = config.analysisModel;
                if (config.analysisSource === "gea") {
                  const route = await business.modelRoute(signal, config.analysisAgentCode);
                  model = route.models.includes(model) ? model : route.models[0]!;
                }
                let answer = "";
                let finished = false;
                for await (const chunk of ctx.llm.stream({ provider: "gea-analysis", model,
                  messages: [createUserMessage({ source: {kind: "user"}, content: [{ type: "text", text: payload.question }] })],
                  maxTokens: 4096, signal })) {
                  signal.throwIfAborted();
                  if (chunk.type === "text-delta") answer += chunk.text;
                  if (Buffer.byteLength(answer) > config.maxSnapshotBytes) throw new Error("GEA_ADVICE_TOO_LARGE");
                  if (chunk.type === "finish") finished = chunk.reason.kind === "stop";
                }
                signal.throwIfAborted();
                if (!finished) throw new Error("GEA_ADVICE_INCOMPLETE");
                value = {status: answer.trim() ? "ok" : "noAnswer", provider_id: "gea-analysis", model, answer};
                break;
              }
              case "model/discover": {
                if (!business.status().authenticated) throw new Error('LOGIN_REQUIRED');
                const route = config.analysisSource === 'direct' ? {models:[config.analysisModel],names:{[config.analysisModel]:config.analysisModel}} : await business.modelRoute(
                  request.signal,
                  config.analysisAgentCode,
                );
                const selected = route.models.includes(config.analysisModel)
                  ? config.analysisModel
                  : route.models[0]!;
                request.signal.throwIfAborted();
                // saveSelection 是整体覆盖：不带上已选档位就会把用户的档位选择清掉。
                const kept = geaKeptReasoningEffort(
                  ctx.agentDefaultModel.currentSelection(),
                );
                await ctx.agentDefaultModel.saveSelection({
                  provider: "gea-analysis",
                  model: selected,
                  ...(kept === undefined ? {} : { reasoningEffort: kept }),
                });
                value = {
                  models: route.models,
                  selected,
                  names: route.names,
                  selectedName: route.names[selected],
                };
                break;
              }
              case "environment/select":
                value = business.selectEnvironment(payload);
                break;
              case "logout":
                value = business.logout(payload);
                break;
              case "login/start":
                value = await business.loginStart(request.signal, payload);
                break;
              case "login/poll":
                value = await business.loginPoll(payload, request.signal);
                break;
              case "plans":
                value = await business.plans(payload, request.signal);
                break;
              case "periods":
                value = await business.periods(request.signal);
                break;
              case "detail":
                value = await business.detail(payload, request.signal);
                break;
              case "versions":
                value = await business.versions(payload, request.signal);
                break;
              case "skus":
                value = await business.skus(payload, request.signal);
                break;
              case "prepare":
                value = business.prepare(payload);
                break;
              case "submit":
                value = await submit(payload, request.signal);
                break;
              default:
                throw new Error("UNKNOWN_ENDPOINT");
            }
            await desktopLogin.flush(); await webLogin.flush();
            return Response.json(
              { ok: true, value },
              { headers: { "Cache-Control": "no-store" } },
            );
          } catch (error) {
            // 业务操作失败时也可能同时发现登录过期并清除身份。
            try { await desktopLogin.flush(); await webLogin.flush(); } catch (storageError) { error = storageError; }
            return Response.json(
              { ok: false, error: errorEnvelope(error) },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
        },
      }),
    );
}

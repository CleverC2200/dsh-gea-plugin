import { NATIVE_REFERENCE_MENUS } from "./business-navigation.ts";
import { TOOL_DESCRIPTIONS, profileFor, installPromptProfile } from "./host/prompt-policy.ts";
import { businessIdentityKey, sessionConsumer } from "./host/business-identity.ts";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHtmlSessions } from "./html-sessions.ts";
import { isHtmlPluginRetired } from "./html-plugin-selection.ts";
import {readHtmlBatch} from "./html-query-batch.ts";
import type { Business } from "./host/business.ts";
import {
  contractFromPlugin,
  type CapabilityContract,
} from "./capability/contract.ts";
import { htmlPageCatalog } from "./html-page-catalog.ts";
import { readPluginContract } from "./capability/declarations.ts";
import { createCapabilityRegistry } from "./capability/registry.ts";
import { PAGE_TOOL } from "./host/page-identity.ts";
import { LAYER_POLICY } from "./capability/layers.ts";
import { compressForModel, MODEL_PAYLOAD_BUDGET } from "@cleverc2200/dsh-agent-workbench/page-interaction/payload-budget";

/**
 * 页面上下文进模型前先收窄：带 focus 只留相关行/字段，不带就只给摘要；
 * 超预算继续收紧，并如实说明省略了多少、下一步怎么取。避免整屏 17KB 反复塞进上下文。
 */
function compressPageContext(
  result: unknown,
  options: { focus?: string },
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result;
  const value = result as Record<string, unknown>;
  const source = value.context as {parts?: Record<string, unknown>} | null;
  // Preserve query choices and computed scope facts; focus narrows result rows, including top objects.
  const controls = source?.parts?.pageFilters === undefined ? undefined
    : compressForModel(source.parts.pageFilters, {budgetBytes: 2000});
  const insight = source?.parts?.inventoryInsight as {evidence?: Record<string, unknown>} | undefined;
  const evidence = insight?.evidence;
  const riskFacts = evidence && typeof evidence === "object" && !Array.isArray(evidence)
    ? compressForModel({...evidence, top:undefined}, {budgetBytes: 4000}) : undefined;
  const payload = controls || riskFacts ? {...source, parts:{
    ...source?.parts,
    ...(controls ? {pageFilters: undefined} : {}),
    ...(riskFacts ? {inventoryInsight:{...insight, evidence:{top:evidence?.top}}} : {}),
  }} : value.context ?? null;
  const metadataBytes = [controls, riskFacts].reduce((total, item) => total + (item ? Buffer.byteLength(item.json, "utf8") + 100 : 0), 0);
  const compressed = compressForModel(payload, {
    budgetBytes: MODEL_PAYLOAD_BUDGET - metadataBytes,
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });
  let context: unknown = value.context ?? null;
  try {
    context = JSON.parse(compressed.json);
  } catch {
    // 压缩结果不是合法 JSON 时退回原值：宁可大一点，也不能让上下文消失。
  }
  if ((controls || riskFacts) && context && typeof context === "object" && !Array.isArray(context)) {
    const record = context as Record<string, unknown>;
    const parts = {...record.parts as Record<string, unknown>};
    if (controls) parts.pageFilters = JSON.parse(controls.json);
    if (riskFacts) {
      const narrowed = parts.inventoryInsight as typeof insight;
      parts.inventoryInsight = {...narrowed, evidence:{...narrowed?.evidence, ...JSON.parse(riskFacts.json)}};
    }
    context = {...record, parts};
  }
  const actions = Array.isArray(value.actions) ? value.actions : [];
  return {
    ...value,
    context,
    ...(actions.length > 10
      ? { actions: actions.slice(0, 10), actionsTotal: actions.length }
      : {}),
    ...(compressed.compressed || controls?.compressed || riskFacts?.compressed
      ? { contextNote: [compressed.note, controls?.note, riskFacts?.note].filter(Boolean).join("；"), contextOmitted: compressed.omitted + (controls?.omitted ?? 0) + (riskFacts?.omitted ?? 0) }
      : {}),
  };
}

/**
 * 页面桥的宿主入口：由 host.ts 在页面工具注册表建好后接上。
 * 迁移过来的页面通过它声明"这一屏有什么"并取走待执行的调用。
 */
export type PageBridgeHost = {
  declare?: (
    sessionId: string,
    catalog: unknown,
    source: "self-report",
  ) => void;
};

export async function registerHtmlPlugins(
  ctx: any,
  business: Business,
  packages: readonly HtmlPackage[],
  pageBridgeHost: PageBridgeHost = {},
) {
  const localConfig = process.env.GEA_HTML_LOCAL_QUERY_CONFIG;
  const local = localConfig ? await (async () => {
    const config = JSON.parse(await readFile(localConfig, "utf8"));
    const provider = await import(pathToFileURL(config.module).href);
    return provider.createProvider(config);
  })() : null;
  if (local) ctx.effect(() => () => local.close());
  /** 上一次给模型的页面上下文：内容没变就不重复发送。 */
  const lastPageContext = new Map<string, string>();
  const sessions = createHtmlSessions((plugin, session) => {
    lastPageContext.delete(session + ":" + plugin);
    const current = business.currentPageIdentity?.(session);
    if (current && current.pluginId !== plugin) return;
    business.clearPageIdentity?.(session, plugin);
    pageBridgeHost.declare?.(session, null, "self-report");
  });
  const lifetime = new AbortController();
  const items: any[] = [];
  /** A page Session cannot be reopened under a different GEA principal in this host lifetime. */
  const sessionPrincipals = new Map<string, string>();
  const capabilities: Record<string, string> = await (async () => {
    try {
      return JSON.parse(
        await readFile(new URL("../presets/agent-capabilities.json", import.meta.url), "utf8"),
      );
    } catch {
      return {};
    }
  })();
  // 预设显示名、顺序与隐藏清单：plugin.json 由别的仓库发布，改选择器不必重发插件包。
  const presetLabels: { hidden: string[]; order: string[]; labels: Record<string, { name?: string }> } =
    await (async () => {
      try {
        const value = JSON.parse(
          await readFile(new URL("../presets/agent-presets.json", import.meta.url), "utf8"),
        );
        return {
          hidden: Array.isArray(value?.hidden)
            ? value.hidden.filter((id: unknown) => typeof id === "string")
            : [],
          order: Array.isArray(value?.order)
            ? value.order.filter((id: unknown) => typeof id === "string")
            : [],
          labels:
            value?.labels && typeof value.labels === "object" ? value.labels : {},
        };
      } catch {
        return { hidden: [], order: [], labels: {} };
      }
    })();
  for (const resource of packages) {
    const { directory, htmlPath: path, manifest } = resource;
    const mock = manifest.mode === "mock";
    const pages = manifest.pages ?? [{ id: manifest.id, name: manifest.name, view: "" }];
    if (
      manifest.schemaVersion !== 1 ||
      !/^inventory-[a-z]+$/.test(manifest.id) ||
      (manifest.mode !== undefined && !mock) ||
      manifest.gea?.contract !== "gea-html-v2" ||
      manifest.gea?.readonly !== true ||
      (typeof manifest.gea.consumerCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(manifest.gea.consumerCode)) ||
      manifest.html !== "index.html"
    )
      throw Error(`INVALID_HTML_PLUGIN [source: ${directory}/plugin.json]`);
    if (
      !Array.isArray(pages) ||
      pages.length < 1 ||
      pages.length > 12 ||
      pages.some((page: any) =>
        !page ||
        !/^inventory-[a-z]+$/.test(page.id) ||
        typeof page.name !== "string" ||
        !page.name.trim() ||
        typeof page.view !== "string" ||
        !/^[a-z]*$/.test(page.view),
      ) ||
      new Set(pages.map((page: any) => page.id)).size !== pages.length
    )
      throw Error(`INVALID_HTML_PLUGIN_PAGES [source: ${directory}/plugin.json]`);
    const mcpPath = await realpath(resolve(directory, manifest.mcp ?? ""));
    if (!mcpPath.startsWith(directory + sep)) throw Error("INVALID_MCP_PATH");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    if (
      mcp.provider !== "gea" ||
      mcp.transport !== "host-provided" ||
      mcp.contract !== "gea-html-v2" ||
      mcp.consumer?.consumerCode !== manifest.gea.consumerCode ||
      mcp.consumer?.consumerType !== "AGENT" ||
      JSON.stringify(mcp.capabilities) !== JSON.stringify(["governed-sql-read"])
    )
      throw Error(`INVALID_GEA_CAPABILITY [source: ${mcpPath}]`);
    if (items.some((item) => item.id === manifest.id))
      throw Error(`DUPLICATE_HTML_PLUGIN [source: ${items.find(item => item.id === manifest.id)?.htmlDirectory}/plugin.json; ${directory}/plugin.json]`);
    if (!manifest.declarations || manifest.agentResources?.provider !== 'dsh-agent-manage')
      throw Error(`UNSUPPORTED_HTML_RESOURCE_PROTOCOL [source: ${directory}/plugin.json]`);
    const preset = "gea-html-" + manifest.id;
    const profile = profileFor(preset) ?? {label:manifest.name,consumerCode:manifest.gea.consumerCode,skills:[manifest.id]};
    if (profile.consumerCode !== manifest.gea.consumerCode) throw Error("INVALID_AGENT_RESOURCE_IDENTITY");
    ctx.effect(() => installPromptProfile(preset,profile));
    const releaseResources = await ctx.agentResources.register([{
      id:preset,label:manifest.name,root:directory,prompt:manifest.agentResources.prompt,profile,
      enabled:!mock && !isHtmlPluginRetired(manifest.id,mock,presetLabels.hidden),
      skillFiles:{[manifest.id]:manifest.skills?.[0]}
    }]);
    ctx.effect(() => releaseResources);
    const retired = isHtmlPluginRetired(manifest.id, mock, presetLabels.hidden);
    const presetHidden = mock || retired;
    items.push({
      ...manifest,

      pageAgents: [preset],
      capabilityContract: await readPluginContract(directory, manifest.declarations, contractFromPlugin({
        id: manifest.id, label: manifest.name, consumerCode: manifest.gea.consumerCode,
        pageIds: pages.map((page: { id: string }) => page.id), description: manifest.name, mock, maxEffect: "view",
        sources: [],
      })),
      pages,
      mock,
      retired,
      presetHidden,
      skillName: manifest.id,
      skillDescription: manifest.name,
      htmlPath: path,
      htmlDirectory: directory,
    });
  }
  const capabilityContracts: CapabilityContract[] = items.map(item => item.capabilityContract);
  createCapabilityRegistry(capabilityContracts);
  const presetRegistry = ctx.get?.("agentPresets");
  let identityScope = business.pageSessionScope();
  const unwatch = business.watchIdentity(() => {
    const next = business.pageSessionScope();
    if (next === identityScope) return;
    identityScope = next;
    sessions.clear();
    lastPageContext.clear();
  });
  ctx.effect(() => () => {
    lifetime.abort();
    unwatch();
    sessions.clear();
  });
  const json = (value: any, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  /** The page declaration narrows choices; the installed preset and GEA Gateway authorize each choice. */
  const pageAgent = async (item: any, preset: unknown, signal: AbortSignal, conversationId?: string) => {
    if (typeof preset !== "string" || !ctx.agentResources.interpreters("gea-html-"+item.id).includes(preset))
      throw Error("PAGE_AGENT_PRESET_NOT_ALLOWED");
    const target = items.find((candidate) => `gea-html-${candidate.id}` === preset && !candidate.presetHidden && !candidate.mock);
    const profile = profileFor(preset);
    if (!target || !profile || profile.consumerCode !== target.gea.consumerCode)
      throw Error("PAGE_AGENT_MISSING");
    if (typeof presetRegistry?.resolve !== "function" || (await presetRegistry.resolve(preset)).id !== preset)
      throw Error("PAGE_AGENT_MISSING");
    const credentials = await business.htmlLaunch(profile.consumerCode, signal, conversationId);
    signal.throwIfAborted();
    return { preset, label: profile.label, consumerCode: profile.consumerCode, credentials };
  };
  const register = (
    path: string,
    methods: string[],
    handler: (request: Request) => Promise<Response> | Response,
    requireGea = true,
  ) =>
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path,
        methods,
        requestBody: "buffered",
        fetch: async (request: Request) => {
          try {
            if (requireGea && !business.status().authenticated)
              return json({ error: "请先登录 GEA" }, 401);
            const identity = requireGea ? business.identitySignal() : undefined;
            const response = await handler(request);
            if (identity?.aborted) throw Error("PAGE_IDENTITY_CHANGED");
            return response;
          } catch (error) {
            return json(
              {
                error:
                  error instanceof Error ? error.message : "GEA_HTML_FAILED",
                code:
                  typeof (error as any)?.code === "string"
                    ? (error as any).code
                    : undefined,
                retryable: (error as any)?.retryable === true,
              },
              400,
            );
          }
        },
      }),
    );
  register(
    "/api/gea-html/plugins",
    ["GET"],
    () =>
      json(
        items.map(
          ({ htmlPath, htmlDirectory, capabilityContract, ...manifest }) => manifest,
        ),
      ),
    false,
  );
  register("/api/gea-html/identity", ["GET"], () => {
    const { environment, authenticated, loginState, user } = business.status();
    return json({ scope: business.pageSessionScope() ?? null, status: { environment, authenticated, loginState, user } });
  }, false);
  for (const item of items) {
    const prefix = "/api/gea-html/" + item.id;
    register(prefix + "/agents", ["GET"], async (request) => {
      const agents = [];
      for (const preset of ctx.agentResources.interpreters("gea-html-"+item.id)) {
        try {
          const { credentials: _credentials, ...entry } = await pageAgent(item, preset, AbortSignal.any([request.signal, business.identitySignal()]));
          agents.push(entry);
        }
        catch (error) { if (request.signal.aborted) throw error; }
      }
      return json(agents);
    });
    register(prefix + "/open", ["POST"], async (request) => {
      lifetime.signal.throwIfAborted();
      const started = item.mock ? undefined : business.identitySignal();
      const { session, agentPreset, scope } = await request.json();
      if (
        typeof session !== "string" ||
        !/^session-[a-z0-9-]{20,80}$/.test(session)
      )
        throw Error("INVALID_CONVERSATION");
      const principal = businessIdentityKey(business);
      const principalKey = principal && `${principal}:${business.pageSessionScope()}`;
      if (!item.mock && !principalKey) throw Error("GEA_IDENTITY_INCOMPLETE");
      if (!item.mock && sessionPrincipals.has(session) && sessionPrincipals.get(session) !== principalKey)
        throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
      if (!item.mock && scope !== business.pageSessionScope())
        throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
      let authorizedAgent: Awaited<ReturnType<typeof pageAgent>> | undefined;
      if (!item.mock) {
        const preset = agentPreset ?? `gea-html-${item.id}`;
        const agent = ctx.agents?.get(session);
        if (!agent) throw Error("PAGE_AGENT_MISSING");
        if (ctx.sessionProjections.stateOf(agent.session, "agentPreset") !== preset)
          throw Error("PAGE_AGENT_SESSION_MISMATCH");
        authorizedAgent = await pageAgent(item, preset, AbortSignal.any([request.signal, business.identitySignal(), lifetime.signal]), session.slice(8));
      }
      let credentials: any;
      let access: any;
      if (item.mock) {
        // Static demo pages deliberately have no GEA identity, gateway or data source.
        credentials = { sessionId: "mock-" + session.slice(8) };
        access = { principalId: "mock-browser", trusted: false, mode: "mock" };
      } else if (local?.pluginId === item.id) {
        const user = business.status().user;
        if (!user?.id) throw Error("GEA_IDENTITY_INCOMPLETE");
        credentials = { sessionId: "local-" + session.slice(8) };
        access = { principalId: user.id, trusted: true, mode: "local-database", workspaceQuery: !!local.workspace };
      } else {
        const identity = business.identitySignal();
        credentials = authorizedAgent && authorizedAgent.consumerCode === item.gea.consumerCode
          ? authorizedAgent.credentials
          : await business.htmlLaunch(item.gea.consumerCode, AbortSignal.any([identity, request.signal, lifetime.signal]), session.slice(8));
        identity.throwIfAborted();
        const user = business.status().user;
        if (!user?.id) throw Error("GEA_IDENTITY_INCOMPLETE");
        access = {
          principalId: user.id,
          trusted: true,
          gatewayScopeRef: credentials.sessionId,
          ...(credentials.roleProfile ?? {}),
        };
      }
      started?.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (!item.mock && scope !== business.pageSessionScope())
        throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
      const lease = sessions.open(item.id, session, credentials, access);
      // Replacing a lease withdraws the old projection before the new page owns it.
      business.touchPageIdentity?.(session, {
        pluginId: item.id,
        consumerCode: item.gea.consumerCode,
        label: item.name,
        pageTool: PAGE_TOOL,
        mock: item.mock === true,
      });
      if (!item.mock && principalKey) sessionPrincipals.set(session, principalKey);
      return json({
        lease,
        plugin: item.id,
      });
    }, !item.mock);
    register(prefix + "/call", ["POST"], async (request) => {
      const input = await request.json(),
        page = sessions.get(input.lease, item.id);
      if (JSON.stringify(input).length > 500000)
        throw Error("REQUEST_TOO_LARGE");
      // 页面每一次调用都证明它还停在那一屏：身份跟着最近活动的页面走，切页后自然换人，
      // 不会出现"人已经在另一页、会话还绑着旧页面"的情况。
      if (input.method !== "close")
        business.touchPageIdentity?.(page.session, {
          pluginId: item.id,
          consumerCode: item.gea.consumerCode,
          label: item.name,
          pageTool: PAGE_TOOL,
          mock: item.mock === true,
        });
      switch (input.method) {
        case "access":
          return json(page.access);
        case "workspace":
          if (local?.pluginId !== item.id || !local.workspace) throw Error("METHOD_NOT_ALLOWED");
          return json(await local.workspace(input.parameters, page.access,
            AbortSignal.any([request.signal, business.identitySignal(), page.controller.signal])));
        case "sql":
          if (item.mock) throw Error("MOCK_DATA_ONLY");
          if (input.parameters?.queries !== undefined) {
            const signal = AbortSignal.any([request.signal, business.identitySignal(), page.controller.signal]);
            return json(await readHtmlBatch(input.parameters.queries, query=>
              local?.pluginId === item.id ? local.read(query, page.access, signal) :
              business.pluginSql({...query, consumerCode:item.gea.consumerCode}, signal),
              {compactRows: input.parameters.responseFormat === 'rows'}));
          }
          if (local?.pluginId === item.id) return json(await local.read(input.parameters,
            AbortSignal.any([request.signal, business.identitySignal(), page.controller.signal])));
          // HTML pages use the same Agent-scoped delegation flow as the native
          // inventory workbenches.  A generic MCP launch can establish a page
          // lease, but it does not grant the SQL resource permissions that the
          // page's declared Agent Consumer owns.
          return json(
            await business.pluginSql(
              { ...input.parameters, consumerCode: item.gea.consumerCode },
              AbortSignal.any([
                request.signal,
                business.identitySignal(),
                page.controller.signal,
              ]),
            ),
          );
        case "register":
          if (!["refresh", "filter", "draft"].includes(input.parameters.name))
            throw Error("ACTION_NOT_ALLOWED");
          page.actions = page.actions.filter(
            (a: any) => a.name !== input.parameters.name,
          );
          page.actions.push({
            name: input.parameters.name,
            description: String(input.parameters.description).slice(0, 300),
          });
          return json({ ok: true });
        case "context":
          if (JSON.stringify(input.parameters).length > 100000)
            throw Error("PAGE_CONTEXT_TOO_LARGE");
          page.context = input.parameters;
          return json({ ok: true });
        case "events":
          return json(page.queue.splice(0));
        case "page-bridge": {
          // 页面桥：页面报"这一屏有什么"，宿主按契约注册工具，并把待执行的调用交回页面。
          const parameters =
            input.parameters && typeof input.parameters === "object"
              ? input.parameters
              : {};
          const catalog = htmlPageCatalog({
            pluginId: item.id,
            label: item.name,
            elements:
              parameters.catalog && typeof parameters.catalog === "object"
                ? (parameters.catalog as { elements?: unknown }).elements
                : undefined,
          });
          if (parameters.pageSource !== undefined && parameters.pageSource !== "self-report")
            throw Error("UNSUPPORTED_PAGE_CATALOG_SOURCE");
          try {
            pageBridgeHost.declare?.(page.session, catalog, "self-report");
          } catch (error) {
            // 页面报的元素超出宿主上限：留一条日志，页面下一轮还会重报。
            console.log(
              `[page-bridge] declare rejected plugin=${item.id} session=${
                page.session
              } code=${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return json(
            await business.pullPageBridgeEvents(
              page.session,
              parameters.toolMessages,
            ),
          );
        }
        case "reply":
          sessions.reply(input.lease, input.parameters);
          return json({ ok: true });
        case "close":
          sessions.close(input.lease);
          return json({ ok: true });
        default:
          throw Error("METHOD_NOT_ALLOWED");
      }
    }, !item.mock);
  }
  // 页面入口只注册一个工具，按当前页身份路由（见 host/page-identity.ts）。
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: PAGE_TOOL,
        description: TOOL_DESCRIPTIONS.gea_page!,
        parameters: {
          action: {
            type: "string",
            required: true,
            enum: ["context", "refresh", "filter", "draft"],
            description: "context 读这一屏；其余为页面自述动作。",
          },
          focus: {
            type: "string",
            description:
              "只取与这些关键词相关的行或字段（用户提到的对象名、编码、字段名）。",
          },
          parameters: {
            type: "string",
            description: "页面动作自己的 JSON 参数对象；没有就不传。",
          },
        },
        output: {
          schema: { type: "string" },
          render: (_a: any, value: string) => [{ type: "text", text: value }],
        },
        // 页面工具要覆盖最慢的一层（提交/审批）再加一点余量，数值来自能力层策略表。
        timeoutMs: Math.max(
          LAYER_POLICY.read.timeoutMs,
          LAYER_POLICY.submit.timeoutMs + 5_000,
        ),
        isConcurrencySafe: () => false,
        execute: async (args: any, exec: any) => {
          const owner = exec.agent?.id;
          if (!owner) throw Error("CONVERSATION_REQUIRED");
          const identity = business.currentPageIdentity?.(owner);
          if (!identity)
            return JSON.stringify({
              source: "GEA_PAGE",
              availability: "not-in-workbench",
              code: "PAGE_NOT_IN_WORKBENCH",
              action: args.action,
              reason:
                "这个对话现在不在业务工作台（没有打开业务页面）：读不到页面证据，也不去打开页面。数据类问题请改用 gea_module_mcp 调对应模块的受管查询工具，不要因此拒答或让用户先去开页面。",
            });
          const item = items.find((entry) => entry.id === identity.pluginId);
          if (!item)
            return JSON.stringify({
              source: "GEA_PAGE",
              availability: "module-not-installed",
              code: "PAGE_MODULE_NOT_INSTALLED",
              currentPage: { pluginId: identity.pluginId, label: identity.label },
              action: args.action,
              reason: `当前页「${identity.label}」这个模块没有装在本客户端：只能读它的页面，不能读数据。`,
            });
          if (!item.mock && !business.status().authenticated)
            throw Error("请先登录 GEA");
          if (!sessions.has(item.id, owner))
            return JSON.stringify({
              source: "GEA_PAGE",
              availability: "not-in-workbench",
              code: "PAGE_NOT_IN_WORKBENCH",
              page: item.name,
              action: args.action,
              reason: `这个对话还没有打开「${item.name}」页面。数据类问题请改用 gea_module_mcp 调该模块的受管查询工具，不要因为页面没打开就拒答或让用户先去开页面。`,
            });
          const parameters =
            typeof args.parameters === "string" && args.parameters.trim()
              ? JSON.parse(args.parameters)
              : {};
          const focus =
            typeof args.focus === "string"
              ? args.focus
              : typeof parameters?.focus === "string"
                ? parameters.focus
                : undefined;
          const result = await sessions.invoke(
            item.id,
            owner,
            args.action,
            parameters,
            exec.signal,
          );
          if (args.action !== "context") return JSON.stringify(result);
          // 页面上下文按"问到什么"收窄 + 压到预算内。
          const payload = JSON.stringify(
            compressPageContext(result, {
              ...(focus === undefined ? {} : { focus }),
            }),
          );
          // 同一屏第二次要就只回"没变"，不把整包再塞进历史。
          const key = owner + ":" + item.id;
          if (lastPageContext.get(key) === payload)
            return JSON.stringify({
              source: "GEA_PAGE",
              availability: "unchanged",
              page: item.name,
              unchanged: true,
              note: "这一屏与上一次读取完全相同：沿用上一次内容，未重复发送。",
            });
          lastPageContext.set(key, payload);
          return payload;
        },
      }),
    ),
  );

  return {
    authorizeReference(input: unknown): void {
      if (!input || typeof input !== "object") throw Error("PAGE_REFERENCE_ACCESS_DENIED");
      const value = input as { sessionId?: string; surface?: string; lease?: string };
      if (typeof value.sessionId !== "string" || typeof value.surface !== "string" || !ctx.agents?.get(value.sessionId))
        throw Error("PAGE_REFERENCE_ACCESS_DENIED");
      const identity = businessIdentityKey(business);
      const principal = identity && `${identity}:${business.pageSessionScope()}`;
      const owner = sessionPrincipals.get(value.sessionId);
      if (owner !== undefined && owner !== principal) throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
      if (value.surface.startsWith("gea-html-")) {
        if (typeof value.lease !== "string") throw Error("PAGE_REFERENCE_LEASE_REQUIRED");
        const page = sessions.get(value.lease);
        if (page.session !== value.sessionId || value.surface !== `gea-html-${page.plugin}`)
          throw Error("PAGE_REFERENCE_ACCESS_DENIED");
        if (page.access.mode !== "mock" && (!principal || owner !== principal))
          throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
        return;
      }
      // A registered HTML owner cannot escape its lease by claiming a Native surface.
      if (owner !== undefined) throw Error("PAGE_REFERENCE_ACCESS_DENIED");
      const menu = Object.hasOwn(NATIVE_REFERENCE_MENUS, value.surface) ? NATIVE_REFERENCE_MENUS[value.surface] : undefined;
      if (!menu) throw Error("PAGE_REFERENCE_ACCESS_DENIED");
      if (!principal) throw Error("PAGE_REFERENCE_LOGIN_REQUIRED");
      if (business.surfaceFor(value.sessionId)?.menu !== menu)
        throw Error("PAGE_REFERENCE_CONTEXT_MISMATCH");
    },
    consumerForSession: (session?: string) => sessionConsumer(ctx, business, session),
    capabilityContracts,
  };
}

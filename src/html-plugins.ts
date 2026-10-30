import { readConfiguredHtmlQuery } from "./host/configured-html-query.ts";
import { profileFor, installPromptProfile, type PromptProfile } from "./host/prompt-policy.ts";
import {
  businessIdentityKey,
  sessionConsumer,
  assertSessionResourceAvailable,
} from "./host/business-identity.ts";
import type { HtmlPackage } from "@cleverc2200/dsh-agent-workbench";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isHtmlPluginRetired } from "./html-plugin-selection.ts";
import { readHtmlBatch } from "./html-query-batch.ts";
import type { Business } from "./host/business.ts";
import { contractFromPlugin, type CapabilityContract } from "./capability/contract.ts";
import { readPluginContract } from "./capability/declarations.ts";
import { createCapabilityRegistry } from "./capability/registry.ts";
import { PAGE_TOOL } from "./host/page-identity.ts";
import { bindModulePage } from "./host/module-page-scope.ts";
import { assertHtmlMcp } from "./capability/html-mcp.mjs";
import { createDashboardInsightGenerator } from "./host/dashboard-insight.ts";

export async function registerHtmlPlugins(
  ctx: any,
  business: Business,
  packages: readonly HtmlPackage[],
) {
  // Reject duplicate installed declarations before publishing resources or effects.
  const declarationSources = new Map<string, string>();
  for (const { directory, manifest } of packages) {
    const previous = declarationSources.get(manifest.id);
    if (previous !== undefined)
      throw Error(
        `DUPLICATE_HTML_PLUGIN [source: ${previous}/plugin.json; ${directory}/plugin.json]`,
      );
    declarationSources.set(manifest.id, directory);
  }
  const localConfig = process.env.GEA_HTML_LOCAL_QUERY_CONFIG;
  const local = localConfig
    ? await (async () => {
        const config = JSON.parse(await readFile(localConfig, "utf8"));
        const provider = await import(pathToFileURL(config.module).href);
        return provider.createProvider(config);
      })()
    : null;
  if (local) ctx.effect(() => () => local.close());
  const lifetime = new AbortController();
  const generateInsight = createDashboardInsightGenerator({
    authorize: async (owner, signal) => {
      signal.throwIfAborted();
      if (business.config.analysisMode !== "model" || business.config.analysisSource !== "gea")
        throw Error("GEA_ADVICE_MODEL_REQUIRED");
      await assertSessionResourceAvailable(ctx, owner.session, signal);
      if (sessionConsumer(ctx, business, owner.session) !== owner.consumer)
        throw Error("PAGE_AGENT_SESSION_MISMATCH");
      business.assertExecutionAllowed(owner.consumer, "view", owner.session);
      if (`${businessIdentityKey(business)}:${business.pageSessionScope()}` !== owner.principal)
        throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
    },
    prompt: async (path) => {
      if ((await realpath(path)) !== path) throw Error("INVALID_INSIGHT_PROMPT_PATH");
      return readFile(path, "utf8");
    },
    model: async (owner, signal) => {
      const route = await business.modelRoute(signal, owner.consumer, owner.session);
      return route.models.includes(business.config.analysisModel)
        ? business.config.analysisModel
        : route.models[0]!;
    },
    stream: (options) => ctx.llm.stream(options),
  });
  const items: any[] = [];
  const incompatible: { id: string; code: "INVALID_AGENT_RESOURCE_IDENTITY" }[] = [];
  /** A page Session cannot be reopened under a different GEA principal in this host lifetime. */
  const sessionPrincipals = new Map<string, string>();
  // 预设显示名、顺序与隐藏清单：plugin.json 由别的仓库发布，改选择器不必重发插件包。
  const presetLabels: {
    hidden: string[];
    order: string[];
    labels: Record<string, { name?: string }>;
  } = await (async () => {
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
        labels: value?.labels && typeof value.labels === "object" ? value.labels : {},
      };
    } catch {
      return { hidden: [], order: [], labels: {} };
    }
  })();
  for (const resource of packages) {
    const { directory, htmlPath: path, manifest } = resource;
    const mock = manifest.mode === "mock";
    const reportStore =
      manifest.id === "inventory-orderworkbench" &&
      manifest.gea?.consumerCode === "order" &&
      manifest.reportStore === "order" &&
      !mock;
    const pages = manifest.pages ?? [{ id: manifest.id, name: manifest.name, view: "" }];
    if (
      manifest.schemaVersion !== 1 ||
      !/^[a-z][a-z0-9-]{0,119}$/.test(manifest.id) ||
      (manifest.mode !== undefined && !mock) ||
      manifest.gea?.contract !== "gea-html-v2" ||
      manifest.gea?.readonly !== !reportStore ||
      typeof manifest.gea.consumerCode !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(manifest.gea.consumerCode) ||
      manifest.html !== "index.html"
    )
      throw Error(`INVALID_HTML_PLUGIN [source: ${directory}/plugin.json]`);
    if (
      !Array.isArray(pages) ||
      pages.length < 1 ||
      pages.length > 12 ||
      pages.some(
        (page: any) =>
          !page ||
          !/^[a-z][a-z0-9-]{0,119}$/.test(page.id) ||
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
    try {
      assertHtmlMcp(mcp, manifest.gea.consumerCode, mock, reportStore);
    } catch {
      throw Error(`INVALID_GEA_CAPABILITY [source: ${mcpPath}]`);
    }
    if (!manifest.declarations || manifest.agentResources?.provider !== "dsh-agent-manage")
      throw Error(`UNSUPPORTED_HTML_RESOURCE_PROTOCOL [source: ${directory}/plugin.json]`);
    const preset = "gea-html-" + manifest.id;
    const profile: PromptProfile = profileFor(preset) ?? {
      label: manifest.name,
      consumerCode: manifest.gea.consumerCode,
      skills: [manifest.id],
    };
    if (profile.consumerCode !== manifest.gea.consumerCode) {
      incompatible.push({ id: manifest.id, code: "INVALID_AGENT_RESOURCE_IDENTITY" });
      ctx.logger.warn("HTML_RESOURCE_INCOMPATIBLE: %s", manifest.id);
      for (const page of pages)
        ctx.effect(() =>
          ctx.workbenchPages.registerBusinessPage(
            {
              id: page.id,
              kind: "html",
              label: page.name,
              pluginId: manifest.id,
              resourceId: preset,
              catalog: { surface: page.id, tool: "gea_plugin_page_apply" },
            },
            async () => {
              throw Error("配套插件版本不兼容，请更新 Workbench 后重启应用。");
            },
          ),
        );
      continue;
    }
    const capabilityContract = await readPluginContract(directory, manifest.declarations, {
      ...contractFromPlugin({
        id: manifest.id,
        label: manifest.name,
        consumerCode: manifest.gea.consumerCode,
        pageIds: pages.map((page: { id: string }) => page.id),
        description: manifest.name,
        mock,
        maxEffect: reportStore ? "submit" : "view",
        sources: [],
      }),
      skills: [...profile.skills],
    });
    ctx.effect(() => installPromptProfile(preset, profile));
    const retired = isHtmlPluginRetired(manifest.id, mock, presetLabels.hidden);
    const presetHidden = mock || retired;
    const releaseResources = await ctx.agentResources.register([
      {
        id: preset,
        cube: !mock && !retired && capabilityContract.data?.mock !== true,
        label: manifest.name,
        presetName: profile.presetName,
        description: profile.description,
        root: directory,
        prompt: manifest.agentResources.prompt,
        publishPreset: !presetHidden,
        capability: manifest.declarations.capability,
        profile,
        enabled: capabilityContract.enabled !== false && !retired,
        skillFiles: Object.fromEntries(
          profile.skills.flatMap((name, index) =>
            manifest.skills?.[index] ? [[name, manifest.skills[index]]] : [],
          ),
        ),
      },
    ]);
    ctx.effect(() => releaseResources);
    items.push({
      ...manifest,

      pageAgents: [preset],
      capabilityContract,
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
  const capabilityContracts: CapabilityContract[] = items.map((item) => item.capabilityContract);
  const capability = createCapabilityRegistry(capabilityContracts);
  const presetRegistry = ctx.get?.("agentPresets");
  ctx.effect(() => () => lifetime.abort());
  const json = (value: any, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
  /** The page declaration narrows choices; the installed preset and GEA Gateway authorize each choice. */
  const pageAgent = async (
    item: any,
    preset: unknown,
    signal: AbortSignal,
    conversationId?: string,
  ) => {
    if (
      typeof preset !== "string" ||
      !ctx.agentResources.interpreters("gea-html-" + item.id).includes(preset)
    )
      throw Error("PAGE_AGENT_PRESET_NOT_ALLOWED");
    const target = items.find(
      (candidate) =>
        `gea-html-${candidate.id}` === preset &&
        candidate.capabilityContract.enabled !== false &&
        !candidate.presetHidden &&
        !candidate.mock,
    );
    const profile = profileFor(preset);
    if (!target || !profile || profile.consumerCode !== target.gea.consumerCode)
      throw Error("PAGE_AGENT_MISSING");
    if (
      typeof presetRegistry?.resolve !== "function" ||
      (await presetRegistry.resolve(preset)).id !== preset
    )
      throw Error("PAGE_AGENT_MISSING");
    const credentials = await business.htmlLaunch(profile.consumerCode, signal, conversationId);
    signal.throwIfAborted();
    return {
      preset,
      label: profile.label,
      consumerCode: profile.consumerCode,
      credentials,
    };
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
                error: error instanceof Error ? error.message : "GEA_HTML_FAILED",
                code: typeof (error as any)?.code === "string" ? (error as any).code : undefined,
                retryable: (error as any)?.retryable === true,
              },
              400,
            );
          }
        },
      }),
    );
  register("/api/gea-html/compatibility", ["GET"], () => json(incompatible), false);
  for (const item of items) {
    for (const page of item.pages)
      ctx.effect(() =>
        ctx.workbenchPages.registerBusinessPage(
          {
            id: page.id,
            kind: "html",
            label: page.name,
            pluginId: item.id,
            resourceId: "gea-html-" + item.id,
            catalog: {
              surface: item.capabilityContract.view.surface,
              tool: "gea_plugin_page_apply",
            },
          },
          async (session: string, resourceId: string, signal: AbortSignal) => {
            lifetime.signal.throwIfAborted();
            if (!item.mock && !business.status().authenticated)
              throw Error("PAGE_REFERENCE_LOGIN_REQUIRED");
            const started = item.mock ? lifetime.signal : business.identitySignal();
            const scope = business.pageSessionScope();
            const request = { signal };
            if (typeof session !== "string" || !/^session-[a-z0-9-]{20,80}$/.test(session))
              throw Error("INVALID_CONVERSATION");
            const principal = businessIdentityKey(business);
            const principalKey = principal && `${principal}:${business.pageSessionScope()}`;
            if (!item.mock && !principalKey) throw Error("GEA_IDENTITY_INCOMPLETE");
            if (
              !item.mock &&
              sessionPrincipals.has(session) &&
              sessionPrincipals.get(session) !== principalKey
            )
              throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
            if (!item.mock && scope !== business.pageSessionScope())
              throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
            let authorizedAgent: Awaited<ReturnType<typeof pageAgent>> | undefined;
            if (!item.mock) {
              const agent = ctx.agents?.get(session);
              if (!agent) throw Error("PAGE_AGENT_MISSING");
              const preset = ctx.sessionProjections.stateOf(agent.session, "agentPreset");
              if (typeof preset !== "string" || !preset) throw Error("PAGE_AGENT_SESSION_MISMATCH");
              authorizedAgent = await pageAgent(
                item,
                preset,
                AbortSignal.any([request.signal, business.identitySignal(), lifetime.signal]),
                session.slice(8),
              );
            }
            let credentials: any;
            let access: any;
            if (item.mock) {
              // Static demo pages deliberately have no GEA identity, gateway or data source.
              credentials = { sessionId: "mock-" + session.slice(8) };
              access = {
                principalId: "mock-browser",
                trusted: false,
                mode: "mock",
              };
            } else if (local?.pluginId === item.id) {
              const user = business.status().user;
              if (!user?.id) throw Error("GEA_IDENTITY_INCOMPLETE");
              credentials = { sessionId: "local-" + session.slice(8) };
              access = {
                principalId: user.id,
                trusted: true,
                mode: "local-database",
                workspaceQuery: !!local.workspace,
              };
            } else {
              const identity = business.identitySignal();
              credentials =
                authorizedAgent && authorizedAgent.consumerCode === item.gea.consumerCode
                  ? authorizedAgent.credentials
                  : await business.htmlLaunch(
                      item.gea.consumerCode,
                      AbortSignal.any([identity, request.signal, lifetime.signal]),
                      session.slice(8),
                    );
              identity.throwIfAborted();
              const user = business.status().user;
              if (!user?.id) throw Error("GEA_IDENTITY_INCOMPLETE");
              access = {
                principalId: user.id,
                trusted: true,
                gatewayScopeRef: credentials.sessionId,
                ...credentials.roleProfile,
              };
            }
            started?.throwIfAborted();
            lifetime.signal.throwIfAborted();
            if (!item.mock && scope !== business.pageSessionScope())
              throw Error("PAGE_SESSION_IDENTITY_MISMATCH");
            signal.throwIfAborted();
            const surface = business.setSurface(session, {
              menu: page.id,
              title: page.name,
            });
            const pageIdentity = {
              pluginId: item.id,
              consumerCode: item.gea.consumerCode,
              label: item.name,
              pageTool: PAGE_TOOL,
              mock: item.mock === true,
            };
            business.touchPageIdentity(session, pageIdentity);
            let projection = business.currentPageIdentity(session);
            if (!item.mock && principalKey) sessionPrincipals.set(session, principalKey);
            const grantSignal = AbortSignal.any([started!, lifetime.signal]);
            const modulePage = bindModulePage(business, session, item.id, grantSignal);
            return {
              signal: grantSignal,
              referenceScope: item.mock ? "mock-browser" : principal!,
              access,
              observe: (context: Record<string, unknown>) => {
                grantSignal.throwIfAborted();
                if (business.surfaceFor(session) !== surface) throw Error("PAGE_OWNER_RELEASED");
                business.touchPageIdentity(session, pageIdentity);
                projection = business.currentPageIdentity(session);
                modulePage.observe(context);
              },
              allowsEffect: (
                effect: import("@cleverc2200/dsh-agent-workbench").PageBusinessGrant extends {
                  allowsEffect(effect: infer E): boolean;
                }
                  ? E
                  : never,
              ) => capability.allows("gea-html-" + item.id, effect),
              ...(item.id === "inventory-fc" && !item.mock
                ? {
                    branchStorage: (parameters: any, requestSignal: AbortSignal) => {
                      if (business.surfaceFor(session) !== surface)
                        throw Error("PAGE_OWNER_RELEASED");
                      return business.branchStorage(
                        parameters,
                        AbortSignal.any([requestSignal, grantSignal]),
                      );
                    },
                    branchDms: (parameters: any, requestSignal: AbortSignal) => {
                      if (business.surfaceFor(session) !== surface)
                        throw Error("PAGE_OWNER_RELEASED");
                      return business.branchDms(
                        parameters,
                        AbortSignal.any([requestSignal, grantSignal]),
                      );
                    },
                  }
                : {}),
              readSql: async (parameters: any, requestSignal: AbortSignal) => {
                if (item.mock) throw Error("MOCK_DATA_ONLY");
                const activeSignal = AbortSignal.any([requestSignal, grantSignal]);
                activeSignal.throwIfAborted();
                if (item.sqlConfig !== undefined)
                  return readConfiguredHtmlQuery(
                    { directory: item.htmlDirectory, manifest: item },
                    parameters,
                    business,
                    activeSignal,
                    item.gea.consumerCode,
                    true,
                  );
                if (parameters?.queries !== undefined)
                  return readHtmlBatch(
                    parameters.queries,
                    (query: any) =>
                      local?.pluginId === item.id
                        ? local.read(query, access, activeSignal)
                        : business.pluginSql(
                            { ...query, consumerCode: item.gea.consumerCode },
                            activeSignal,
                            false,
                            undefined,
                            false,
                            true,
                          ),
                    { compactRows: parameters.responseFormat === "rows" },
                  );
                if (local?.pluginId === item.id)
                  return local.read(parameters, access, activeSignal);
                return business.pluginSql(
                  { ...parameters, consumerCode: item.gea.consumerCode },
                  activeSignal,
                  false,
                  undefined,
                  false,
                  true,
                );
              },
              ...(["inventory-aqkc", "inventory-fc"].includes(item.id) && !item.mock
                ? {
                    insight: (parameters: unknown, requestSignal: AbortSignal) => {
                      if (business.surfaceFor(session) !== surface)
                        throw Error("PAGE_OWNER_RELEASED");
                      return generateInsight(
                        {
                          session,
                          principal: principalKey!,
                          consumer: item.gea.consumerCode,
                          promptPath: resolve(item.htmlDirectory, "insight-prompt.md"),
                        },
                        parameters,
                        AbortSignal.any([requestSignal, grantSignal]),
                      );
                    },
                  }
                : {}),
              ...(item.id === "inventory-orderfulfillment" &&
              item.gea.consumerCode === "order01" &&
              !item.mock
                ? {
                    workspace: (parameters: unknown, requestSignal: AbortSignal) => {
                      if (business.surfaceFor(session) !== surface)
                        throw Error("PAGE_OWNER_RELEASED");
                      return business.orderSalesConfirmation(
                        parameters,
                        AbortSignal.any([requestSignal, grantSignal]),
                      );
                    },
                  }
                : {}),
              ...(item.id === "inventory-orderworkbench" &&
              item.gea.consumerCode === "order" &&
              item.reportStore === "order" &&
              !item.mock
                ? {
                    workspace: (parameters: any, requestSignal: AbortSignal) =>
                      business.orderReport(
                        parameters,
                        AbortSignal.any([requestSignal, grantSignal]),
                      ),
                  }
                : {}),
              ...(local?.pluginId === item.id && local.workspace
                ? {
                    workspace: (parameters: any, requestSignal: AbortSignal) =>
                      local.workspace(
                        parameters,
                        access,
                        AbortSignal.any([requestSignal, grantSignal]),
                      ),
                  }
                : {}),
              release: () => {
                modulePage.release();
                if (business.currentPageIdentity(session) === projection)
                  business.clearPageIdentity(session, item.id);
                if (business.surfaceFor(session) === surface)
                  business.clearSurface(session, surface.menu);
              },
            };
          },
        ),
      );
  }

  return {
    modelAccessForSession: async (session?: string, signal?: AbortSignal) => {
      await assertSessionResourceAvailable(ctx, session, signal);
      const agent = session ? ctx.agents.get(session) : undefined;
      const preset = agent
        ? ctx.sessionProjections.stateOf(agent.session, "agentPreset")
        : undefined;
      const association =
        agent && !profileFor(preset ?? undefined) ? ctx.userAgents?.cubeFor(agent) : undefined;
      const source = ctx.agentResources.cubeSource(association?.sourceRef ?? preset);
      return {
        consumerCode: sessionConsumer(ctx, business, session),
        signal: AbortSignal.any([
          business.identitySignal(),
          lifetime.signal,
          ...(source ? [source.signal] : []),
          ...(association ? [association.signal] : []),
        ]),
      };
    },
    capabilityContracts,
  };
}

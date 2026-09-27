import { TOOL_DESCRIPTIONS, profileFor } from "./host/prompt-policy.ts";
import { sessionConsumer } from "./host/business-identity.ts";
import { readFile, readdir, realpath, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHtmlSessions } from "./html-sessions.ts";
import { selectHtmlPlugins } from "./html-plugin-selection.ts";
import {readHtmlBatch} from "./html-query-batch.ts";
import type { Business } from "./host/business.ts";
import {
  contractFromPlugin,
  type CapabilityContract,
} from "./capability/contract.ts";
import { injectPageScan, pageCatalogFromScan } from "./html-page-scan.ts";
import { PAGE_TOOL } from "./host/page-identity.ts";
import { LAYER_POLICY } from "./capability/layers.ts";
import { compressForModel } from "./shared/payload-budget.ts";

/** 已经挂到 DSH 技能根下的业务技能目录，用于插件卸载时回收。 */
const publishedSkillDirs: string[] = [];

/**
 * 老版本客户端装过、现在已下线的预设目录：插件包升级后源码不再生成它们，
 * 但 native-presets 是启动器按目录复用的派生目录，不会自己消失，得顺手清掉。
 */
const RETIRED_LEGACY_PRESETS = ["gea-agent-hub"];

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
  const compressed = compressForModel(value.context ?? null, {
    ...(options.focus === undefined ? {} : { focus: options.focus }),
  });
  let context: unknown = value.context ?? null;
  try {
    context = JSON.parse(compressed.json);
  } catch {
    // 压缩结果不是合法 JSON 时退回原值：宁可大一点，也不能让上下文消失。
  }
  const actions = Array.isArray(value.actions) ? value.actions : [];
  return {
    ...value,
    context,
    ...(actions.length > 10
      ? { actions: actions.slice(0, 10), actionsTotal: actions.length }
      : {}),
    ...(compressed.compressed
      ? { contextNote: compressed.note, contextOmitted: compressed.omitted }
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
    source: "self-report" | "dom-scan",
  ) => void;
};

/** 契约从模块自己的代码里派生：只看会写受管 SQL 的文件，不看说明文档。 */
const CONTRACT_SOURCE_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
]);
const CONTRACT_SOURCE_MAX_FILE_BYTES = 2_000_000;
const CONTRACT_SOURCE_MAX_TOTAL_BYTES = 8_000_000;

/** 读模块自带的前端代码，用来静态导出"这个模块能读哪些业务表"。 */
async function readContractSources(directory: string): Promise<string[]> {
  const sources: string[] = [];
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 2 || total >= CONTRACT_SOURCE_MAX_TOTAL_BYTES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (total >= CONTRACT_SOURCE_MAX_TOTAL_BYTES) return;
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(path, depth + 1);
        continue;
      }
      if (!CONTRACT_SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase()))
        continue;
      try {
        const size = (await stat(path)).size;
        if (size === 0 || size > CONTRACT_SOURCE_MAX_FILE_BYTES) continue;
        total += size;
        sources.push(await readFile(path, "utf8"));
      } catch {
        // 读不到的附属文件不影响模块本身可用。
      }
    }
  };
  await walk(directory, 1);
  return sources;
}

/**
 * 业务页面自带的 SKILL.md 不只是该页面 agent 的提示词，也要让主对话（标准 agent）能按需加载：
 * 复制到 DSH 用户技能根 `<DSH_HOME>/skills/<插件id>/SKILL.md`，由 skill-filesystem 扫描。
 */
async function publishAgentSkill(id: string, content: string, managed = false, references: Record<string, string> = {}): Promise<void> {
  const home = process.env.DSH_HOME;
  if (!home) return;
  const directory = resolve(home, "skills", id);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "SKILL.md"), content, { mode: 0o600 });
  publishedSkillDirs.push(directory);
  if (managed) {
    const managedDirectory = resolve(home, 'gea-business-skills', id);
    await mkdir(managedDirectory, { recursive: true });
    await writeFile(resolve(managedDirectory, 'SKILL.md'), content, { mode: 0o600 });
    publishedSkillDirs.push(managedDirectory);
  }
  for (const target of [directory, ...(managed ? [resolve(home, 'gea-business-skills', id)] : [])]) {
    if (!Object.keys(references).length) continue;
    await mkdir(resolve(target, 'references'), {recursive:true});
    for (const [name, text] of Object.entries(references))
      await writeFile(resolve(target, 'references', name), text, {mode:0o600});
  }
}

export async function registerHtmlPlugins(
  ctx: any,
  business: Business,
  roots: string[],
  pageBridgeHost: PageBridgeHost = {},
) {
  const localConfig = process.env.GEA_HTML_LOCAL_QUERY_CONFIG;
  const local = localConfig ? await (async () => {
    const config = JSON.parse(await readFile(localConfig, "utf8"));
    const provider = await import(pathToFileURL(config.module).href);
    return provider.createProvider(config);
  })() : null;
  if (local) ctx.effect(() => () => local.close());
  const sessions = createHtmlSessions(),
    items: any[] = [];
  /** 上一次给模型的页面上下文：内容没变就不重复发送。 */
  const lastPageContext = new Map<string, string>();
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
  const candidates = await Promise.all(roots.map(async root => {
    const directory = await realpath(root);
    const manifest = JSON.parse(await readFile(resolve(directory, "plugin.json"), "utf8"));
    return { ...manifest, directory };
  }));
  for (const candidate of selectHtmlPlugins(candidates)) {
    const root = candidate.directory;
    const directory = await realpath(root),
      manifest = JSON.parse(
        await readFile(resolve(directory, "plugin.json"), "utf8"),
      ),
      mock = manifest.mode === "mock";
    const pages = manifest.pages ?? [{ id: manifest.id, name: manifest.name, view: "" }];
    if (
      manifest.schemaVersion !== 1 ||
      !/^inventory-[a-z]+$/.test(manifest.id) ||
      (manifest.mode !== undefined && !mock) ||
      manifest.gea?.contract !== "gea-html-v1" ||
      manifest.gea?.readonly !== true ||
      (typeof manifest.gea.consumerCode !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(manifest.gea.consumerCode)) ||
      manifest.html !== "index.html"
    )
      throw Error("INVALID_HTML_PLUGIN");
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
      throw Error("INVALID_HTML_PLUGIN_PAGES");
    const mcpPath = await realpath(resolve(directory, manifest.mcp ?? ""));
    if (!mcpPath.startsWith(directory + sep)) throw Error("INVALID_MCP_PATH");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    if (
      mcp.provider !== "gea" ||
      mcp.transport !== "host-provided" ||
      mcp.contract !== "gea-html-v1" ||
      mcp.consumer?.consumerCode !== manifest.gea.consumerCode ||
      mcp.consumer?.consumerType !== "AGENT" ||
      JSON.stringify(mcp.capabilities) !== JSON.stringify(["governed-sql-read"])
    )
      throw Error("INVALID_GEA_CAPABILITY");
    if (items.some((item) => item.id === manifest.id))
      throw Error("DUPLICATE_HTML_PLUGIN");
    const path = await realpath(resolve(directory, manifest.html));
    if (!path.startsWith(directory + sep)) throw Error("INVALID_HTML_PATH");
    const html = await readFile(path, "utf8");
    if (Buffer.byteLength(html) > 5000000) throw Error("HTML_TOO_LARGE");
    const skillPath = await realpath(
      resolve(directory, manifest.skills?.[0] ?? ""),
    );
    if (!skillPath.startsWith(directory + sep))
      throw Error("INVALID_SKILL_PATH");
    // 宿主管理真实库存模块的 Agent 指令；保留已安装页面包和演示模块的原始边界。
    const managedConsumers: Record<string, string> = {'inventory-aqkc':'base-safety-stock','inventory-dealer':'dealer-inventory-replenishment','inventory-fc':'branch-inventory','inventory-qll':'full-chain-inventory','inventory-apsplan':'aps'};
    const managedSkill = !mock && managedConsumers[manifest.id] === manifest.gea.consumerCode;
    const skill = await readFile(managedSkill
      ? new URL(`../presets/${manifest.id}.skill.md`, import.meta.url)
      : skillPath, 'utf8');
    await publishAgentSkill(manifest.id, skill, managedSkill);
    if (managedSkill && manifest.id === 'inventory-apsplan') {
      const references = Object.fromEntries(await Promise.all(['metric-definitions.md', 'data-mapping.md'].map(async name =>
        [name, await readFile(new URL(`../business-skills/aps/references/${name}`, import.meta.url), 'utf8')])));
      for (const name of ['sales-forecast-result-analysis', 'sales-ops-problem-analysis'])
        await publishAgentSkill(name, await readFile(new URL(`../business-skills/aps/${name}.skill.md`, import.meta.url), 'utf8'), true, references);
    }
    const frontmatter = (key: string) =>
      new RegExp(`^${key}:\\s*(.+)$`, "m").exec(skill)?.[1]?.trim();
    const preset = resolve(
      business.config.runtimeDir,
      "native-presets",
      "gea-html-" + manifest.id,
    );
    // 演示和已下架模块仍可展示页面，但不进入新会话的 Agent 选择器。
    const retired = mock || presetLabels.hidden.includes(manifest.id);
    if (retired) {
      await rm(preset, { recursive: true, force: true });
    } else {
      const name = presetLabels.labels[manifest.id]?.name ?? manifest.name;
      const description =
        capabilities[manifest.id] ??
        frontmatter("description") ??
        manifest.name;
      const orderIndex = presetLabels.order.indexOf(manifest.id);
      const writePreset = async (directory: string) => {
        await mkdir(directory, { recursive: true });
        await writeFile(
          resolve(directory, "preset.yml"),
          JSON.stringify({ name, description, ...(orderIndex < 0 ? {} : { order: orderIndex + 1 }) }),
        );
        await writeFile(
          resolve(directory, "agent.cordis.yml"),
          JSON.stringify([
            {
              id: "persona",
              name: "@deepseek-ai/dsh-persona",
              config: {
                prefix: profileFor("gea-html-" + manifest.id)?.persona ?? skill,
                complete: false,
                includeRuntimeContext: false,
              },
            },
            ...(managedSkill ? [{id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem", config: {
              includeDefaultRoots: false, customSkillDirs: [resolve(process.env.DSH_HOME || business.config.runtimeDir, "gea-business-skills")],
            }}] : []),
          ]),
        );
      };
      await writePreset(preset);
    }
    items.push({
      ...manifest,
      pages,
      mock,
      retired,
      skillName: frontmatter("name") ?? manifest.id,
      skillDescription: frontmatter("description") ?? manifest.name,
      skillText: skill,
      htmlSource: html,
      htmlPath: path,
      htmlDirectory: directory,
    });
  }
  // Retire old APS routes, tools and panels together, regardless of root order.
  items.splice(0, items.length, ...selectHtmlPlugins(items));
  // 只留"当前应当存在的预设"：下架、演示（mock）以及被合并替代的模块都不会再生成目录，
  // 但老版本装过的那份还在 native-presets 里，光靠上面的 rm 清不掉（插件可能已经
  // 被 selectHtmlPlugins 剔除，甚至整包卸载，注册循环根本走不到），会一直留在预设选择器里。
  const presetHome = resolve(business.config.runtimeDir, "native-presets");
  const expectedPresets = new Set<string>();
  for (const item of items) {
    if (item.retired === true) continue;
    expectedPresets.add("gea-html-" + item.id);
  }
  for (const entry of await readdir(presetHome, { withFileTypes: true }).catch(() => [])) {
    const name = entry.name;
    if (RETIRED_LEGACY_PRESETS.includes(name)) {
      await rm(resolve(presetHome, name), { recursive: true, force: true });
      continue;
    }
    if (!name.startsWith("gea-html-") || expectedPresets.has(name)) continue;
    await rm(resolve(presetHome, name), { recursive: true, force: true });
  }
  const unwatch = business.watchIdentity(() => {
    sessions.clear();
    lastPageContext.clear();
  });
  // 每个模块一份能力契约：页面范围、只读数据范围与口径、允许的最大改动等级。
  // 模块自己声明，宿主不再按模块写分支（工单 #7）。
  const capabilityContracts: CapabilityContract[] = await Promise.all(
    items.map(async (item) =>
      contractFromPlugin({
        id: item.id,
        label: item.name,
        consumerCode: item.gea.consumerCode,
        pageIds: (item.pages as Array<{ id: string }>).map((page) => page.id),
        skill: item.skillText,
        // 演示模块要在契约里标出来：它没有真实数据通道，别再去试模块 MCP。
        mock: item.mock === true,
        // All accepted HTML modules declare gea.readonly=true; keep that
        // manifest fact in the capability contract instead of defaulting to draft.
        maxEffect: "view",
        sources: await readContractSources(item.htmlDirectory),
      }),
    ),
  );
  ctx.effect(() => () => {
    unwatch();
    sessions.clear();
    publishedSkillDirs.splice(0).forEach((directory) => {
      void rm(resolve(directory, "SKILL.md"), { force: true });
    });
  });
  const json = (value: any, status = 200) =>
    Response.json(value, { status, headers: { "cache-control": "no-store" } });
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
            return await handler(request);
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
          ({ htmlSource, htmlPath, htmlDirectory, ...manifest }) => manifest,
        ),
      ),
    false,
  );
  for (const item of items) {
    const prefix = "/api/gea-html/" + item.id;
    register(prefix + "/html", ["GET"], async () => {
      const path = await realpath(item.htmlPath);
      if (!path.startsWith(item.htmlDirectory + sep))
        throw Error("INVALID_HTML_PATH");
      const html = await readFile(path, "utf8");
      if (Buffer.byteLength(html) > 5000000) throw Error("HTML_TOO_LARGE");
      // 页面本身不用改：宿主把"读这一屏 / 收改单"的适配器注入进去。
      // CSS modules are minified in release HTML. Resolve exported names instead of
      // guessing a development-only class suffix.
      const toolbarMaps = html.match(/\{[^{}]*workspaceToolbar:["'][A-Za-z_][\w-]*["'][^{}]*\}/g) ?? [];
      const toolbarClasses = [...toolbarMaps.join("\n").matchAll(/(?:workspaceToolbar|boardHeader|header):["']([A-Za-z_][\w-]*)["']/g)]
        .map((match) => "." + match[1]);
      const toolbarSelectors = [".agent-topbar", ".top-header", ...toolbarClasses].join(",");
      const toolbarStyle = `<style data-gea-toolbar-alignment>
${toolbarSelectors} {
  box-sizing:border-box!important;height:58px!important;min-height:58px!important;max-height:58px!important;
  flex-shrink:0!important;flex-wrap:nowrap!important;margin-top:0!important;
  overflow-x:auto!important;overflow-y:hidden!important;
}
</style>`;
      // Release HTML may omit optional </head>; append so the rule is always present.
      const alignedHtml = html + toolbarStyle;
      return new Response(injectPageScan(alignedHtml), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
        },
      });
    });
    register(prefix + "/open", ["POST"], async (request) => {
      const { session } = await request.json();
      if (
        typeof session !== "string" ||
        !/^session-[a-z0-9-]{20,80}$/.test(session)
      )
        throw Error("INVALID_CONVERSATION");
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
        credentials = await business.htmlLaunch(
          item.gea.consumerCode,
          AbortSignal.any([identity, request.signal]),
          session.slice(8),
        );
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
      // 打开页面即确立"当前页"：mock 页也要记，否则演示页会被当成没打开。
      business.touchPageIdentity?.(session, {
        pluginId: item.id,
        consumerCode: item.gea.consumerCode,
        label: item.name,
        pageTool: PAGE_TOOL,
        mock: item.mock === true,
      });
      return json({
        lease: sessions.open(item.id, session, credentials, access),
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
          const catalog = pageCatalogFromScan({
            pluginId: item.id,
            label: item.name,
            elements:
              parameters.catalog && typeof parameters.catalog === "object"
                ? (parameters.catalog as { elements?: unknown }).elements
                : undefined,
          });
          try {
            // 页面自己实现自述协议时按自述算，否则是宿主扫出来的。
            const source =
              parameters.pageSource === "self-report" ? "self-report" : "dom-scan";
            pageBridgeHost.declare?.(page.session, catalog, source);
          } catch (error) {
            // 页面报的元素超出宿主上限：留一条日志，页面下一轮还会重报。
            console.log(
              `[page-bridge] scan declare rejected plugin=${item.id} session=${
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
          business.clearPageIdentity?.(page.session, item.id);
          lastPageContext.delete(page.session + ":" + item.id);
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
    consumerForSession: (session?: string) => sessionConsumer(ctx, business, session),
    capabilityContracts,
  };
}

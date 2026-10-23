import { CURRENT_SHORTAGE_ROUTING, currentShortageResource } from "./current-shortage-contract.ts";
import { BRANCH_INVENTORY_ROUTING } from "./branch-inventory-tool.ts";
import { hasPageReferences } from "@cleverc2200/dsh-agent-workbench/page-interaction/reference";
import { sessionConsumer, assertSessionResourceAvailable } from "./business-identity.ts";
import { businessToolDisplay } from "./business-tool-display.ts";
import { salesSourceIssueForTurns } from "./sales-result-contract.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolve } from "node:path";
import type { Business } from "./business.ts";
import type { CapabilityRegistry } from "../capability/registry.ts";
import { isMainSurface } from "./workbench-surface.ts";
import { allowedTools, profileFor, promptMeasurement, TOOL_DESCRIPTIONS } from "./prompt-policy.ts";
import { cubeAllowed, resolveCubeAccess } from "./cube-access.ts";
import { PromptExecutionState } from "./prompt-execution-state.ts";
import { modulePagePrompt } from "./module-page-scope.ts";
import { orchestrationInventoryAllowed } from "./orchestration-inventory-access.ts";

const fixedInventoryMethod = (name: string) =>
  name === "gea_branch_inventory" || name === "gea_current_shortage";

const gatewayMethod = (name: string) =>
  name === "mcp__gea-gateway__inspect_cube_model" ||
  name === "mcp__gea-gateway__query_business_data" ||
  name === "mcp__gea-gateway__weknora_list_knowledge_bases" ||
  name === "mcp__gea-gateway__weknora_ask";
const businessMethod = (name: string) =>
  (name.startsWith("gea_") && name !== "gea_runtime_diagnose") || gatewayMethod(name);
const businessSourceRecovery =
  "请选用已安装并启用的对应业务资源；使用个人 Agent 时，在其 MCP 配置中选择并启用 GEA Workbench。独立业务查询无需打开或绑定页面，服务端仍按当前 Consumer 校验权限。Skill、角色名称和页面可见不授予 Consumer 权限。";

type AdmissionState = {
  pageReferences?: boolean;
  preset: string;
  dispose?: () => void;
  mask: string;
};

/** Session-scoped prompt composition and execution gates share the same capability set. */
export function mountBusinessPrompts(
  ctx: Context,
  business: Business,
  capability: CapabilityRegistry,
): () => void {
  const states = new Map<Agent, AdmissionState>();
  const presetOf = (agent: Agent) => ctx.sessionProjections.stateOf(agent.session, "agentPreset");
  const profileOf = (agent: Agent | undefined) =>
    agent ? profileFor(presetOf(agent) ?? undefined) : undefined;
  const pageBound = (agent: Agent) =>
    !isMainSurface(business.surfaceFor(agent.id)) && !!business.currentPageIdentity?.(agent.id);
  const executionState = new PromptExecutionState(
    resolve(business.config.runtimeDir, "prompt-evidence"),
    (agent) => presetOf(agent) ?? undefined,
    (preset) => !!profileFor(preset),
    { ctx, business },
  );
  const stateOf = (agent: Agent) => {
    let state = states.get(agent);
    const preset = presetOf(agent) ?? "";
    if (state && state.preset !== preset) {
      state.dispose?.();
      states.delete(agent);
      state = undefined;
    }
    if (!state) {
      state = {
        preset,
        mask: "",
      };
      states.set(agent, state);
      agent.ctx.effect(() => () => {
        state?.dispose?.();
        states.delete(agent);
        executionState.forget(agent);
      });
    }
    return state;
  };
  const namesFor = (agent: Agent, state = stateOf(agent)) => {
    const names = allowedTools(
      profileOf(agent)!,
      pageBound(agent) ? business.currentPageIdentity(agent.id)?.pageTool : undefined,
    );
    if (state.pageReferences || hasPageReferences(agent.session.snapshotEvents()))
      names.add("page_reference_read");
    if (business.config.agentSqlRead === true) names.add("gea_plugin_read");
    return names;
  };
  const refreshMask = (agent: Agent) => {
    const state = stateOf(agent);
    const names = profileOf(agent) ? namesFor(agent, state) : new Set<string>();
    if (orchestrationInventoryAllowed(ctx, business, agent.id)) {
      names.add("gea_branch_inventory");
      names.add("gea_current_shortage");
    }
    if (cubeAllowed(ctx, business, agent.id)) {
      names.add("mcp__gea-gateway__inspect_cube_model");
      names.add("mcp__gea-gateway__query_business_data");
      names.add("mcp__gea-gateway__weknora_list_knowledge_bases");
      names.add("mcp__gea-gateway__weknora_ask");
    } else {
      names.delete("mcp__gea-gateway__inspect_cube_model");
      names.delete("mcp__gea-gateway__query_business_data");
      names.delete("mcp__gea-gateway__weknora_list_knowledge_bases");
      names.delete("mcp__gea-gateway__weknora_ask");
    }
    const deny = ctx.tools
      .schemas()
      .map((tool) => tool.name)
      .filter((name) => businessMethod(name) && !names.has(name));
    const signature = deny.sort().join("|");
    if (signature === state.mask) return;
    // Business masks do not choose official or optional plugin capabilities.
    const next = deny.length ? agent.ctx.tools.restrict({ deny }) : undefined;
    state.dispose?.();
    state.dispose = next;
    state.mask = signature;
  };
  const clean = () => {
    executionState.clear();
  };
  const refreshAll = () => {
    for (const agent of ctx.agents.list()) refreshMask(agent);
  };
  const offs: Array<() => void> = [
    business.watchIdentity(() => {
      clean();
      refreshAll();
    }),
  ];
  if (ctx.agentResources?.watch) offs.push(ctx.agentResources.watch(refreshAll));
  if (ctx.userAgents) offs.push(ctx.userAgents.watch(refreshAll));
  offs.push(
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/start") return;
      const agent = ctx.agents.get(session.id);
      if (!agent || (!profileOf(agent) && !cubeAllowed(ctx, business, agent.id))) return;
      executionState.startTurn(agent);
    }),
  );
  offs.push(
    ctx.on("agent/pre-step", async ({ agent, messages = [], signal }, next) => {
      if (profileOf(agent)) {
        await assertSessionResourceAvailable(ctx, agent.id, signal);
        business.assertExecutionAllowed(sessionConsumer(ctx, business, agent.id), "view", agent.id);
      }
      if (
        hasPageReferences(
          messages
            .filter((message) => message.source.kind === "user")
            .map((data) => ({ type: "user/message", data })),
        )
      )
        stateOf(agent).pageReferences = true;
      refreshMask(agent);
      return next();
    }),
  );
  offs.push(
    ctx.tools.guard((exec) => {
      const agent = exec.agent;
      const independentTool =
        !!agent &&
        !profileOf(agent) &&
        ((gatewayMethod(exec.name) && cubeAllowed(ctx, business, agent.id)) ||
          (fixedInventoryMethod(exec.name) &&
            orchestrationInventoryAllowed(ctx, business, agent.id)));
      if (!agent || (!profileOf(agent) && !independentTool)) {
        if (businessMethod(exec.name))
          return agent
            ? `GEA_BUSINESS_PROFILE_REQUIRED: 当前实际会话未接入所需的业务资源或 GEA 工具来源。${businessSourceRecovery}`
            : "GEA_BUSINESS_PROFILE_REQUIRED: reason=CALLING_AGENT_MISSING。工具调用未绑定实际Core Agent，无法判定业务身份；需核对调用归属。";
        return;
      }
      const state = stateOf(agent);
      if (!businessMethod(exec.name)) return;
      if (!independentTool && !namesFor(agent, state).has(exec.name))
        return ["gea_page", "gea_workbench_apply"].includes(exec.name) && !pageBound(agent)
          ? "GEA_BUSINESS_TOOL_NOT_ALLOWED: reason=PAGE_NOT_BOUND。当前业务会话未绑定页面；打开相应业务页面并连接当前会话后再读取页面证据。独立查询结果不能代替页面确定性结果。"
          : "GEA_BUSINESS_TOOL_NOT_ALLOWED: 当前业务角色未声明此工具能力。";
      if (exec.name === "gea_sales_plan_read") {
        const questions = agent.session
          .snapshotEvents()
          .filter((event) => event.type === "user/message" && event.data.source.kind === "user")
          .map((event) =>
            event.type === "user/message"
              ? event.data.content
                  .filter((b) => b.type === "text")
                  .map((b) => (b.type === "text" ? b.text : ""))
                  .join("\n")
              : "",
          );
        const issue = salesSourceIssueForTurns(questions);
        if (issue) return issue;
      }
      if (
        exec.name === "gea_evidence_read" &&
        business.turnStopKind(agent.id) === "session-expired"
      )
        return "GEA_GATEWAY_SESSION_EXPIRED: 本轮网关会话已过期，不能通过证据回读重建会话；下一轮重新验证。";
    }),
  );
  offs.push(
    ctx.on("tools/execute", async (exec, next) => {
      if (
        exec.agent &&
        profileOf(exec.agent) &&
        (businessMethod(exec.name) || exec.name === "forecast_compute")
      ) {
        // Capture before resource admission awaits; old calls never acquire a new turn's owner.
        executionState.begin(exec.agent, exec.token, exec);
      }
      try {
        await assertSessionResourceAvailable(ctx, exec.agent?.id, exec.signal);
        executionState.admitted(executionState.execution(exec.token));
        return await next();
      } catch (error) {
        // Official around-dispatch failures bypass post-execute; retire this execution's metadata here.
        executionState.take(exec.token);
        throw error;
      }
    }),
  );
  offs.push(
    ctx.on("tools/post-execute", async (exec, result, next) => {
      // Tool dispatch has ended. This hook is the sole consumer of these receipts, even if a later policy throws.
      const execution = executionState.take(exec.token);
      const decision = await next();
      return executionState.finish(execution, result, decision);
    }),
  );

  const output = {
    schema: { type: "string" } as const,
    render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
  };
  offs.push(
    ctx.tools.register(
      defineTool({
        name: "gea_runtime_diagnose",
        description:
          "只读核对实际会话、业务资源、GEA 工具来源和恢复路径。独立查询看 independentQuery 与 mcpAccess，不能仅凭 businessProfileDeclared=false 或 pageBound=false 判断不可用；本地接入就绪不代表服务端授权。不会查询业务数据、读取凭据或授予权限。",
        parameters: {},
        output,
        isConcurrencySafe: () => true,
        async execute(_args, exec) {
          exec.signal.throwIfAborted();
          const agent = exec.agent;
          const profile = profileOf(agent);
          const preset = agent ? (presetOf(agent) ?? null) : null;
          const resource =
            profile && preset
              ? (await ctx.agentResources.list({ signal: exec.signal })).find(
                  (item) => item.id === preset && item.kind === "prompt",
                )
              : undefined;
          exec.signal.throwIfAborted();
          let mcpAccess: { sourceRef: string; consumerCode: string } | { error: string } | null =
            null;
          if (agent) {
            try {
              const access = resolveCubeAccess(ctx, business, agent.id);
              mcpAccess = {
                sourceRef: access.sourceRef,
                consumerCode: access.consumerCode,
              };
            } catch (error) {
              mcpAccess = {
                error:
                  (error instanceof Error && error.message.match(/^GEA_[A-Z0-9_]+/)?.[0]) ||
                  "GEA_MCP_ACCESS_UNAVAILABLE",
              };
            }
          }
          const events = agent?.session.snapshotEvents() ?? [];
          const calls = new Map(
            events.flatMap((event) =>
              event.type === "tool/call" ? [[event.data.callId, event.data.name] as const] : [],
            ),
          );
          const recentToolErrors = events
            .flatMap((event) => {
              if (event.type !== "tool/result" || !event.data.message.isError) return [];
              const raw = event.data.error?.code;
              const code =
                raw && /^[A-Z][A-Z0-9_]{2,80}$/.test(raw)
                  ? raw
                  : (event.data.message.content
                      .filter((part) => part.type === "text")
                      .map((part) => (part.type === "text" ? part.text : ""))
                      .join("\n")
                      .match(/\b(?:GEA|AI_GATEWAY|MODEL|MCP|TOOL)_[A-Z0-9_]{2,72}\b/)?.[0] ??
                    "UNCLASSIFIED_TOOL_ERROR");
              return [
                {
                  toolName: calls.get(event.data.message.toolCallId) ?? null,
                  code,
                },
              ];
            })
            .slice(-20);
          const independentQueryAvailable = !!mcpAccess && "consumerCode" in mcpAccess;
          let recovery =
            "当前 GEA 工具来源不可用，请核对所选来源是否已安装、启用及其错误状态；恢复后重试，保留原拒权码，不更换 Consumer。";
          if (!agent)
            recovery =
              "工具调用未绑定实际 Core Agent，请核对调用归属；无法判断当前会话的资源和业务身份。";
          else if (!business.status().authenticated)
            recovery =
              "请通过 GEA 账户入口登录后重试；登录后仍需核对当前会话所选资源与 Consumer 授权。";
          else if (profile && (!resource?.installed || !resource.enabled || resource.error))
            recovery =
              "请在资源目录核对当前业务资源的安装、启用及错误状态，恢复后重新选用；不要更换 Consumer 绕过拒权。";
          else if (independentQueryAvailable)
            recovery =
              "当前会话已接入 GEA 工具来源，独立查询无需打开或绑定页面。仅页面读取或动作需要绑定相应业务页面；实际数据权限仍由服务端按当前 Consumer 校验。";
          else if (
            mcpAccess &&
            "error" in mcpAccess &&
            mcpAccess.error === "GEA_BUSINESS_PROFILE_REQUIRED"
          )
            recovery = businessSourceRecovery;
          return JSON.stringify({
            readOnly: true,
            callingAgentPresent: !!agent,
            sessionId: agent?.id ?? null,
            parentSessionId: agent?.session.header.parentSession ?? null,
            preset,
            businessProfileDeclared: !!profile,
            resourceAvailability: profile
              ? {
                  installed: resource?.installed === true,
                  enabled: resource?.enabled === true,
                  hasError: !!resource?.error,
                }
              : null,
            consumerCode:
              agent && profile
                ? sessionConsumer(ctx, business, agent.id)
                : mcpAccess && "consumerCode" in mcpAccess
                  ? mcpAccess.consumerCode
                  : null,
            mcpAccess,
            independentQuery: {
              available: independentQueryAvailable,
              pageRequired: false,
            },
            recovery,
            pageBound: agent ? pageBound(agent) : false,
            authenticated: business.status().authenticated === true,
            businessAuthorization: "not-checked",
            toolNames: agent ? ctx.tools.schemas(agent).map((tool) => tool.name) : [],
            recentToolErrors,
          });
        },
      }),
    ),
    ctx.tools.register(
      defineTool({
        name: "gea_capabilities",
        description:
          "查看已配置的 GEA 业务模块和当前会话证据索引。证据编号可交给 gea_evidence_read 读取；配置与工具可见不代表业务授权。",
        parameters: {},
        output,
        isConcurrencySafe: () => false,
        async execute(_args, exec) {
          if (!exec.agent || !profileOf(exec.agent)) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          exec.signal.throwIfAborted();
          const snapshot = executionState.snapshot(exec.agent);
          return JSON.stringify({
            preset: presetOf(exec.agent),
            modulesAreConfiguredNotAuthorized: true,
            evidence: snapshot.evidence.map((evidenceId) => ({
              evidenceId,
              tool: JSON.parse(snapshot.receipts.get(evidenceId)!).tool,
            })),
            modules: capability
              .readModules()
              .filter((module) => !module.data?.mock)
              .map((module) => ({
                name: module.label,
                consumerCode: module.data!.consumerCode,
              })),
          });
        },
      }),
    ),
  );
  offs.push(
    ctx.tools.register(
      defineTool({
        name: "gea_evidence_read",
        description:
          "仅在nextRead非空时续读未展示业务行；完整结果直接使用。缺少证据编号时通过 gea_capabilities 获取当前会话证据索引。默认结构化结果，原始审计需format=raw。回读不重新查询，不改变权限或数据覆盖。",
        parameters: {
          format: {
            type: "string",
            enum: ["structured", "raw"],
            description: "默认structured；raw仅审计原始包，不能用它替代已展示的业务行。",
          },
          reload: {
            type: "boolean",
            description: "明确需要重新展示已读视图时使用，不重新查询。",
          },
          dataset: {
            type: "string",
            description:
              "使用evidenceDatasets的key/nextRead读取业务行；省略时返回结构化业务结果或索引。",
          },
          datasetId: {
            type: "string",
            description: "dataset的兼容别名，取evidenceDatasets.key；优先直接照nextRead调用。",
          },
          rowOffset: {
            type: "integer",
            description: "dataset模式的0起点行偏移，默认0；不与字符offset混用。",
          },
          rowLimit: {
            type: "integer",
            description: "dataset模式每次1–100行，默认30；仍受响应大小限制。",
          },
          evidenceId: { type: "string", required: true },
          offset: { type: "integer", description: "字符偏移，0起点；默认0。" },
          limit: {
            type: "integer",
            description: "字符数1–6000；默认4000，不可传更大值。优先使用返回的nextRead。",
          },
        },
        output,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          return JSON.stringify(
            await executionState.read(executionState.execution(exec.token), args),
          );
        },
      }),
    ),
  );

  ctx.inject(["systemPrompt"], (promptCtx) => {
    promptCtx.on("system-prompt/assemble", async (_assembly, context, next) => {
      const assembled = await next();
      const agent = context.agent as Agent | undefined;
      const profile = profileOf(agent);
      if (!agent) return assembled;
      if (!profile) {
        const inventory = orchestrationInventoryAllowed(ctx, business, agent.id);
        refreshMask(agent);
        return {
          ...assembled,
          tools: assembled.tools.filter(
            (tool) =>
              !businessMethod(tool.name) ||
              (gatewayMethod(tool.name) && cubeAllowed(ctx, business, agent.id)) ||
              (fixedInventoryMethod(tool.name) && inventory),
          ),
        };
      }
      const state = executionState.snapshot(agent);
      refreshMask(agent);
      const visible = new Set(ctx.tools.schemas(agent).map((tool) => tool.name));
      const tools = assembled.tools
        .filter((tool) => visible.has(tool.name))
        .map((tool) =>
          businessToolDisplay({
            ...tool,
            description: TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
          }),
        );
      const sections = currentShortageResource(profile.consumerCode)
        ? [
            ...assembled.sections,
            {
              name: "gea-current-shortage",
              text:
                CURRENT_SHORTAGE_ROUTING +
                (profile.consumerCode === "branch-inventory"
                  ? "\n\n" + BRANCH_INVENTORY_ROUTING
                  : ""),
            },
          ]
        : assembled.sections;
      const measurement = promptMeasurement(
        sections.map((section) => section.text).join("\n\n"),
        tools,
      );
      console.info(
        JSON.stringify({
          event: "GEA_PROMPT_BUDGET",
          preset: presetOf(agent),
          ...measurement,
          resultChars: state.returned,
        }),
      );
      const pageContext = modulePagePrompt(business, agent.id);
      return {
        ...assembled,
        tools,
        sections: pageContext
          ? [...sections, { name: "current-module-page", text: pageContext }]
          : sections,
      };
    });
  });
  return () => {
    for (const off of offs.reverse()) off();
    for (const state of states.values()) state.dispose?.();
    states.clear();
    executionState.dispose();
  };
}

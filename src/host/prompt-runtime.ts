import {
  forecastSourceProof,
  forecastBaselineHash,
  hasUserForecastInput,
  FORECAST_VERSION,
} from "dsh-agent-manage/forecast-source";
import { hasPageReferences } from "@cleverc2200/dsh-agent-workbench/page-interaction/reference";
import { sessionConsumer, assertSessionResourceAvailable } from "./business-identity.ts";
import { businessToolDisplay } from "./business-tool-display.ts";
import { catalogFactSummary } from "./gateway-catalog.ts";
import { salesSourceIssueForTurns, requestedOutputScope } from "./sales-result-contract.ts";
import { prefersBusinessCards } from "./business-presentation.ts";
import {
  resultView,
  resultReceipt,
  transientResult,
  permissionDenied,
  resultOutcome,
  datasetIndex,
  indexProjection,
  readDataset,
  compactDatasetProjection,
} from "./prompt-result.ts";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Business } from "./business.ts";
import type { CapabilityRegistry } from "../capability/registry.ts";
import { surfacePromptLine, isMainSurface } from "./workbench-surface.ts";
import {
  allowedTools,
  businessUiIssue,
  COMMON_PROMPT,
  profileFor,
  PROMPT_BUDGET,
  promptMeasurement,
  TOOL_DESCRIPTIONS,
} from "./prompt-policy.ts";
import { stopExpiredGateway } from "./agent-tools.ts";
import {
  projectEvidence,
  withoutHistoricalEvidence,
  exactResult,
  type EvidenceGrant,
} from "./prompt-evidence.ts";

import { PromptExecutionState } from "./prompt-execution-state.ts";

const cubeMethod = (name: string) =>
  name === "mcp__gea-gateway__inspect_cube_model" ||
  name === "mcp__gea-gateway__query_business_data";
const businessMethod = (name: string) =>
  (name.startsWith("gea_") && name !== "gea_runtime_diagnose") || cubeMethod(name);

const UI_RULES =
  '业务概览、多指标、预测/库存结构或对比优先轻量卡片；简单事实或明确纯文字不用。用dsh-ui JSON围栏，根对象{"title":"标题","items":[节点]}；stat={type:"stat",label,value}、table={type:"table",columns,rows}、callout={type:"callout",content}。先1句结论，再1组卡片；结论、表格、说明各说一次，卡片后不重复数字和长篇解释。stat只放已核实数字，最多2项；版本名、未知量和缺口原因用短说明，不能放大成指标。按窄聊天栏设计：表格优先2列，最多3个短列，遵守前N；来源、日期范围、单位和版本放表外短注，不塞长列。标题和标签用业务中文，原始字段/表名仅排查时展示。缺数据说明影响，不补0；记录数不能改叫预测量。禁total:true自动合计、差额delta自动着色。复杂图表才读genui并校验；简单卡片无需通读Skill。按钮不授予写权限。';
type AdmissionState = {
  pageReferences?: boolean;
  preset: string;
  calls: number;
  readCalls: number;
  limit: number;
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
  const executionGrants = new Map<symbol, EvidenceGrant>();
  const runtimeId = randomUUID();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const owner = () => {
    const status = business.status();
    return hash([
      status.source,
      status.environment,
      status.user?.id,
      status.user?.tenantId,
      status.permissionCodes,
      status.roles,
    ]);
  };
  const ephemeral = (agent: Agent) =>
    `${runtimeId}:${business.readTurnRevision(agent.id)}:${business.surfaceFor(agent.id)?.menu ?? ""}`;
  const resourceProof = async (
    consumer: string,
    tool: string,
    signal: AbortSignal,
    scope: string,
  ) => {
    try {
      const module = await business.moduleMcp(consumer, signal);
      const snapshot = await module.authorizedResources(tool, signal);
      if (!snapshot.resources.length) throw Error("GEA_EVIDENCE_AUTHORIZATION_CHANGED");
      return hash(snapshot.resources.map((resource) => JSON.stringify(resource)).sort());
    } catch (error) {
      throw stopExpiredGateway(business, consumer, scope, error) ?? error;
    }
  };
  const valueHash = (text: string) => {
    const result = exactResult(text) as { value?: unknown };
    return hash(result.value ?? result);
  };

  const presetOf = (agent: Agent) => ctx.sessionProjections.stateOf(agent.session, "agentPreset");
  const profileOf = (agent: Agent | undefined) =>
    agent ? profileFor(presetOf(agent) ?? undefined) : undefined;
  const pageBound = (agent: Agent) =>
    !isMainSurface(business.surfaceFor(agent.id)) && !!business.currentPageIdentity?.(agent.id);
  const executionState = new PromptExecutionState(
    resolve(business.config.runtimeDir, "prompt-evidence"),
    (agent) => presetOf(agent) ?? undefined,
    (preset) => !!profileFor(preset),
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
        calls: 0,
        readCalls: 0,
        limit: PROMPT_BUDGET.calls,
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
    for (const state of states.values()) {
      state.calls = 0;
      state.readCalls = 0;
    }
  };
  const offs: Array<() => void> = [business.watchIdentity(clean)];
  offs.push(
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/start") return;
      const agent = ctx.agents.get(session.id);
      if (!agent || !profileOf(agent)) return;
      const state = stateOf(agent);
      state.calls = 0;
      state.readCalls = 0;
      executionState.startTurn(agent);
      state.limit = PROMPT_BUDGET.calls;
    }),
  );
  offs.push(
    ctx.on("agent/pre-step", async ({ agent, messages = [], signal }, next) => {
      if (profileOf(agent)) {
        await assertSessionResourceAvailable(ctx, agent.id, signal);
        business.assertExecutionAllowed(sessionConsumer(ctx, business, agent.id));
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
      if (!profileOf(agent) || !agent) {
        if (businessMethod(exec.name))
          return agent
            ? "GEA_BUSINESS_PROFILE_REQUIRED: 当前实际会话预设未声明业务身份。请使用基地库存 Agent 分析入口或选用相应已启用业务资源；Skill、角色名称和页面可见不授予Consumer权限。"
            : "GEA_BUSINESS_PROFILE_REQUIRED: reason=CALLING_AGENT_MISSING。工具调用未绑定实际Core Agent，无法判定业务身份；需核对调用归属。";
        return;
      }
      const state = stateOf(agent);
      // Evidence exhaustion closes GEA calls, and all tools of the active Core driver.
      if (
        state.readCalls >= PROMPT_BUDGET.evidenceCalls &&
        (businessMethod(exec.name) || agent.status === "running")
      )
        return "GEA_EVIDENCE_BUDGET: 本轮证据读取额度已用完，请交付已读范围并说明未读部分。";
      if (["render_ui", "validate_dsh_ui"].includes(exec.name)) {
        const issue = businessUiIssue(exec.arguments);
        if (issue) return issue;
      }
      if (!businessMethod(exec.name)) return;
      if (!namesFor(agent, state).has(exec.name))
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
      // Reserve before dispatch: parallel calls must not all pass against the same stale counter.
      if (exec.name === "gea_evidence_read") {
        state.readCalls++;
      } else {
        if (state.calls >= state.limit)
          return "GEA_CALL_BUDGET: 业务查询/业务能力调用额度已用完；仍可沿nextRead读取已取得证据，然后交付已有结果。";
        state.calls++;
      }
      if (
        exec.name === "mcp__gea-gateway__inspect_cube_model" &&
        executionState.snapshot(agent).catalogStalls >= 2
      )
        return "GEA_CATALOG_NO_PROGRESS: 目录连续未提供新信息；使用已返回成员执行最小query_business_data或说明具体缺口，查询后可按错误修正目录。本轮其它工具仍可用。";
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
        executionState.begin(exec.agent, exec.token);
      }
      try {
        await assertSessionResourceAvailable(ctx, exec.agent?.id, exec.signal);
        executionState.admitted(executionState.execution(exec.token), exec.name);
        if (
          exec.agent &&
          profileOf(exec.agent) &&
          (businessMethod(exec.name) || exec.name === "forecast_compute")
        ) {
          const args = exec.arguments as Record<string, unknown>;
          const grant: EvidenceGrant = {
            owner: owner(),
            ephemeral: ephemeral(exec.agent),
          };
          if (exec.name === "forecast_compute") grant.kind = "local";
          if (exec.name === "gea_sales_plan_read") grant.query = args;
          executionGrants.set(exec.token, grant);
        }
        return await next();
      } catch (error) {
        // Official around-dispatch failures bypass post-execute; retire this execution's metadata here.
        executionState.take(exec.token);
        executionGrants.delete(exec.token);
        throw error;
      }
    }),
  );
  offs.push(
    ctx.on("tools/post-execute", async (exec, result, next) => {
      // Tool dispatch has ended. This hook is the sole consumer of these receipts, even if a later policy throws.
      const execution = executionState.take(exec.token);
      const grant = executionGrants.get(exec.token);
      executionGrants.delete(exec.token);
      const decision = await next();
      const agent = exec.agent;
      if (
        agent &&
        profileOf(agent) &&
        (businessMethod(exec.name) || exec.name === "forecast_compute")
      ) {
        const args = exec.arguments as Record<string, unknown>;
        const texts = result.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n");
        let read: { key: string; text: string } | undefined;
        if (!result.isError && exec.name === "gea_evidence_read") {
          try {
            const part = JSON.parse(texts);
            read = {
              key: `${part.evidenceId}:${part.dataset ?? "raw"}`,
              text: JSON.stringify({
                evidenceId: part.evidenceId,
                dataset: part.dataset,
                name: part.name,
                display: part.projection ?? part.representation,
                rowOffset: part.rowOffset,
                returnedRows: part.returnedRows,
                readOffset: part.offset,
                nextOffset: part.nextOffset,
              }),
            };
          } catch {}
        }
        executionState.recordOutcome(execution, {
          failure:
            result.isError || resultOutcome(texts) === "blocked"
              ? {
                  key: hash([exec.name, exec.arguments]),
                  text: JSON.stringify({
                    tool: exec.name,
                    status: "blocked",
                    code:
                      texts.match(/GEA_[A-Z_]+|AI_GATEWAY_[A-Z_]+|DATA_QUERY_[A-Z_]+/)?.[0] ??
                      "TOOL_FAILED",
                    note: "本次未取得有效结果；不撤销其它成功证据",
                  }),
                }
              : undefined,
          read,
          deniedConsumer:
            cubeMethod(exec.name) && permissionDenied(texts)
              ? typeof args.consumerCode === "string" && args.consumerCode.trim()
                ? args.consumerCode.trim()
                : sessionConsumer(ctx, business, agent.id)
              : undefined,
          catalog:
            exec.name === "mcp__gea-gateway__inspect_cube_model" &&
            decision.kind === "accept" &&
            !result.isError &&
            !permissionDenied(texts)
              ? {
                  fingerprint: hash(texts),
                  reused: texts.includes('"source":"GEA_CATALOG_REUSED"'),
                  model: String(args.model ?? "catalog"),
                  facts: catalogFactSummary(texts),
                }
              : undefined,
        });
      }

      if (
        !agent ||
        !profileOf(agent) ||
        result.isError ||
        decision.kind !== "accept" ||
        "value" in decision ||
        !(
          exec.name === "forecast_compute" ||
          /^gea_(?:sales_plan_read|page|visible_workbench_context)$/.test(exec.name)
        )
      )
        return decision;
      const content = decision.content ?? result.content;
      if (content.some((block) => block.type !== "text")) return decision;
      const rawText = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      const text = withoutHistoricalEvidence(rawText);
      if (!text) return decision;
      if (resultOutcome(text) === "blocked")
        return {
          ...decision,
          content: [{ type: "text", text: transientResult(text, PROMPT_BUDGET.result) }],
        };
      // Without the exact query's authorization receipt, preserve the original one-time result.
      // Never invent a reusable permission from an empty snapshot or page/turn identity.
      if (grant?.kind === "mcp" && !grant.resources)
        return {
          ...decision,
          content: [
            {
              type: "text",
              text: transientResult(
                text,
                PROMPT_BUDGET.result,
                String((exec.arguments as Record<string, unknown>).tool ?? "").startsWith(
                  "lightrag_",
                ),
              ),
            },
          ],
        };
      if (exec.name === "forecast_compute" && grant) {
        const baseline = await ctx.skills.get("sinian-demand-baseline", {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec.signal,
        });
        exec.signal.throwIfAborted();
        const proof = forecastSourceProof(
          exec.arguments,
          agent.session
            .snapshotEvents()
            .filter((event) => event.type === "user/message")
            .map((event) => event.data),
          baseline,
        );
        const original = exactResult(text) as {
          source?: Record<string, unknown>;
        };
        if (
          original.source?.inputHash !== proof.inputHash ||
          original.source?.calculatorVersion !== proof.calculatorVersion ||
          original.source?.baselineHash !== proof.baselineHash ||
          original.source?.userInputVerified !== proof.userInputVerified ||
          original.source?.businessAuthorization !== false
        )
          return {
            kind: "block",
            feedback: [
              {
                type: "text",
                text: "GEA_CALCULATION_SOURCE_CHANGED: 当前计算输入、原生规则或用户来源已改变，旧结果不可复用。",
              },
            ],
          };
        grant.baselineHash = proof.baselineHash;
        grant.calculatorVersion = proof.calculatorVersion;
        if (proof.userInputVerified) {
          grant.inputHash = proof.inputHash;
          delete grant.ephemeral;
        }
      }
      if (grant?.query) {
        try {
          grant.valueHash = valueHash(text);
        } catch {
          delete grant.query;
        }
      }
      const published = await executionState.publishEvidence(
        execution,
        exec.name,
        text,
        grant,
        (id, alreadyDelivered) => {
          const compact =
            !alreadyDelivered && grant?.kind === "mcp"
              ? compactDatasetProjection(text, id, PROMPT_BUDGET.result)
              : undefined;
          let projected = alreadyDelivered
            ? JSON.stringify({
                evidenceId: id,
                projection: "reference",
                note: "同一结果已返回，需要正文用 gea_evidence_read 回读。",
              })
            : (compact ??
              projectEvidence(
                text,
                id,
                PROMPT_BUDGET.result,
                grant?.kind === "mcp" ? resultView(text) : undefined,
              ));
          if (grant?.kind === "mcp" && compact === undefined)
            projected = indexProjection(
              projected,
              id,
              datasetIndex(text, id),
              PROMPT_BUDGET.result,
            );
          let display = "complete";
          if (projected !== text) {
            try {
              display = JSON.parse(projected).projection ?? "complete";
            } catch {
              display = "partial";
            }
          }
          return {
            text: projected,
            receipt: resultReceipt(
              exec.name,
              exec.arguments as Record<string, unknown>,
              id,
              text,
              display,
            ),
          };
        },
      );
      if (published.kind === "identity-changed")
        return {
          kind: "block",
          feedback: [
            {
              type: "text",
              text: "GEA_EVIDENCE_IDENTITY_CHANGED: 身份已改变，旧结果不能作为当前证据。",
            },
          ],
        };
      if (published.kind === "stale-context") return decision;
      return {
        ...decision,
        content: [{ type: "text" as const, text: published.text }],
      };
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
          "只读核对本次调用的实际会话预设、父会话、业务身份声明、页面绑定及工具名称。不会查询业务数据、读取凭据或授予权限。",
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
            consumerCode: agent && profile ? sessionConsumer(ctx, business, agent.id) : null,
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
          "查看已配置的 GEA 业务模块和本轮执行预算。配置与工具可见不代表业务授权。复杂任务可选择 complex 额度。",
        parameters: { complex: { type: "boolean" } },
        output,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (!exec.agent || !profileOf(exec.agent)) throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          exec.signal.throwIfAborted();
          const state = stateOf(exec.agent);
          if (args.complex) state.limit = PROMPT_BUDGET.complexCalls;
          return JSON.stringify({
            preset: presetOf(exec.agent),
            callLimit: state.limit,
            modulesAreConfiguredNotAuthorized: true,
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
          "仅在nextRead非空时续读未展示业务行；完整结果直接使用。默认结构化结果，原始审计需format=raw。回读不重新查询，不改变权限或数据覆盖。",
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
          const agent = exec.agent;
          if (!agent) throw Error("SESSION_REQUIRED");
          const unknown = Object.keys(args).filter(
            (key) =>
              ![
                "evidenceId",
                "dataset",
                "datasetId",
                "rowOffset",
                "rowLimit",
                "offset",
                "limit",
                "format",
                "reload",
              ].includes(key),
          );
          if (unknown.length)
            throw Error(
              "GEA_EVIDENCE_ARGUMENT: 未支持的参数 " +
                unknown.join(",") +
                "；请按nextRead调用，不会忽略参数退回原文模式。",
            );
          if (args.dataset && args.datasetId && args.dataset !== args.datasetId)
            throw Error("GEA_EVIDENCE_ARGUMENT: dataset与datasetId不能不同。");
          if (args.datasetId && !args.dataset) args = { ...args, dataset: args.datasetId };
          if (args.dataset && args.format === "raw")
            throw Error("GEA_EVIDENCE_READ_MODE: dataset和raw不能混用。");

          if (!args.dataset && (args.rowOffset !== undefined || args.rowLimit !== undefined))
            throw Error(
              "GEA_EVIDENCE_READ_MODE: rowOffset/rowLimit必须指定dataset；不会忽略行参数退回原文模式。",
            );
          if (args.dataset && (args.offset !== undefined || args.limit !== undefined))
            throw Error(
              "GEA_EVIDENCE_READ_MODE: dataset模式使用rowOffset/rowLimit，原文模式使用offset/limit，按nextRead调用。",
            );
          let trackView = true;
          const read = await executionState.readEvidence(
            executionState.execution(exec.token),
            agent,
            args.evidenceId,
            args.offset,
            args.limit,
            async (grant, tool) => {
              if (
                /^gea_(cube_query|module_mcp)$/.test(tool) &&
                (!grant.consumer || !grant.resources)
              )
                throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
              if (grant.owner !== owner()) throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
              if (grant.kind === "local" && tool === "forecast_compute") {
                const baseline = await ctx.skills.get("sinian-demand-baseline", {
                  scope: agent,
                  cwd: agent.session.header.cwd,
                  signal: exec.signal,
                });
                exec.signal.throwIfAborted();
                if (
                  grant.calculatorVersion !== FORECAST_VERSION ||
                  grant.baselineHash !== forecastBaselineHash(baseline)
                )
                  throw Error("GEA_CALCULATION_SOURCE_CHANGED: 计算版本或当前原生规则已变化。");
                if (grant.inputHash) {
                  if (
                    !hasUserForecastInput(
                      agent.session
                        .snapshotEvents()
                        .filter((event) => event.type === "user/message")
                        .map((event) => event.data),
                      grant.inputHash,
                    )
                  )
                    throw Error("GEA_EVIDENCE_STALE: 当前Session缺少原用户结构化输入。");
                } else if (grant.ephemeral !== ephemeral(agent))
                  throw Error("GEA_EVIDENCE_STALE: 模型生成输入只能在当前轮次使用。");
              } else if (grant.consumer && grant.resourceTool && grant.resources) {
                if (
                  (await resourceProof(
                    grant.consumer,
                    grant.resourceTool,
                    exec.signal,
                    agent.id,
                  )) !== grant.resources
                )
                  throw Error("GEA_EVIDENCE_AUTHORIZATION_CHANGED");
              } else if (grant.kind === "mcp") throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
              else if (grant.query && grant.valueHash) {
                // Direct sales reads have no resource-version endpoint. Revalidate the exact query under current row permissions.
                const current = await business.agentQuery(grant.query, exec.signal);
                if (valueHash(current) !== grant.valueHash)
                  throw Error("GEA_EVIDENCE_STALE: 数据或权限范围已改变，请取得新的结果。");
              } else if (grant.ephemeral !== ephemeral(agent))
                throw Error("GEA_EVIDENCE_STALE: 页面或临时结果需要重新读取。");
            },
            args.format === "raw" || (args.format === undefined && Number(args.offset) > 0)
              ? undefined
              : (raw) => {
                  const index = datasetIndex(raw, args.evidenceId);
                  // Old non-Cube consumers use character slices (e.g. calculation drafts).
                  if (
                    !index.length &&
                    args.format === undefined &&
                    (args.offset !== undefined || args.limit !== undefined)
                  ) {
                    trackView = false;
                    const offset = args.offset ?? 0,
                      limit = args.limit ?? 4000,
                      nextOffset = offset + limit < raw.length ? offset + limit : null;
                    return {
                      projection: offset === 0 && raw.length <= limit ? "complete" : "partial",
                      offset,
                      totalChars: raw.length,
                      nextOffset,
                      content: raw.slice(offset, offset + limit),
                      nextRead:
                        nextOffset === null
                          ? null
                          : {
                              tool: "gea_evidence_read",
                              args: {
                                evidenceId: args.evidenceId,
                                format: "raw",
                                offset: nextOffset,
                                limit,
                              },
                            },
                    };
                  }
                  const view = args.dataset
                    ? readDataset(raw, args.evidenceId, args.dataset, args.rowOffset, args.rowLimit)
                    : (exactResult(
                        compactDatasetProjection(raw, args.evidenceId) ??
                          (index.length
                            ? JSON.stringify({
                                evidenceDatasets: index,
                                projection: "index",
                                nextRead: index[0]?.nextRead,
                              })
                            : projectEvidence(raw, args.evidenceId)),
                      ) as Record<string, unknown>);
                  return view;
                },
            args.format === "raw" || (args.format === undefined && Number(args.offset) > 0)
              ? undefined
              : {
                  viewId: (view) => (trackView ? hash(view) : undefined),
                  visible: (viewId) =>
                    JSON.stringify(agent.session.deriveMessages()).includes(viewId),
                  reload: args.reload,
                },
          );
          return JSON.stringify(read);
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
      if (!profile)
        return {
          ...assembled,
          tools: assembled.tools.filter((tool) => !businessMethod(tool.name)),
          sections: [
            ...assembled.sections,
            {
              name: "gea:admission",
              text: "当前实际会话预设未声明 GEA 业务身份。Skill 可用于规则说明，但实际库存取数需点击工作台的‘使用基地库存 Agent 分析’入口或选用相应业务资源。子智能体的角色名和提示词不改变其实际父会话的业务身份。GEA 工具当前不可用；其它 MCP 结果应标明独立来源，不证明 GEA 页面或授权恢复。",
            },
          ],
        };
      const state = { ...stateOf(agent), ...executionState.snapshot(agent) };
      const date = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const consumer = sessionConsumer(ctx, business, agent.id);
      const user = agent.session
        .snapshotEvents()
        .findLast((event) => event.type === "user/message" && event.data.source.kind === "user");
      const outputScope = requestedOutputScope(
        user?.type === "user/message"
          ? user.data.content
              .filter((b) => b.type === "text")
              .map((b) => (b.type === "text" ? b.text : ""))
              .join("\n")
          : "",
      );
      const facts = `日期：${date}；时区：Asia/Shanghai。Agent：${profile.label}；业务编码：${consumer}。\n${surfacePromptLine(business.surfaceFor(agent.id))}`;
      const sections = [
        // Host GUI orientation remains authoritative; business presentation only refines GenUI output.
        ...assembled.sections.map((section) =>
          section.name === "genui:fence"
            ? {
                ...section,
                text: "GenUI 的当前协议使用 dsh-ui 围栏展示内联 UI；render_ui 是工具行卡片通道，仅在本步实际工具清单提供时调用。展示方式遵循 GEA 业务输出规则和用户指定格式，简单事实或明确纯文字请求使用文字，不因出现数字、步骤或并列项强制 UI。需要 UI 时先用当前原生 skill 加载 genui 的协议与组件参考，遵循当前工具 schema，不猜组件或参数；Skill、工具或界面能力缺失时如实说明呈现缺口，已取得证据仍可用文字交付。展示和页面动作不授予业务权限，也不证明业务保存、提交或审批成功。",
              }
            : section,
        ),
        { name: "gea:common", text: COMMON_PROMPT },
        { name: "gea:facts", text: facts },
        ...(outputScope ? [{ name: "gea:output-scope", text: outputScope }] : []),
        ...(state.catalogFacts.size
          ? [
              {
                name: "gea:confirmed-semantics",
                text:
                  "本轮已成功返回的字段、单位和规则（不是新的授权；猜测列名不存在不等于无对应业务字段）：\n" +
                  [...state.catalogFacts.values()].join("\n"),
              },
            ]
          : []),
        ...(state.catalogStalls >= 2
          ? [
              {
                name: "gea:query-progress",
                text: "目录连续未提供新信息，暂不继续探索目录。已有成员用于最小query_business_data，原结果用nextRead按数据集续读；执行查询后可再按具体错误核对目录。规则题直接用已核验规则，数据缺口明确记录，不换关键词或加载知识来代替取数。",
              },
            ]
          : []),
        {
          name: "gea:evidence-index",
          text: state.evidence.length
            ? `本轮已返回证据：${state.evidence.join("、")}。它们是数据引用，不是授权；需要正文可用 gea_evidence_read。`
            : "",
        },
        ...(state.receipts.size
          ? [
              {
                name: "gea:result-status",
                text:
                  "本轮历史回执（不等于任务完成或当前授权）。display=complete表示已返回正文完整展示，无需为读外层封装重读原文；partial用数据集nextRead补行。两者都不证明业务全量。其它范围失败不抹掉历史成功事实，权限撤销的原范围不可复用。交付核对范围，不说这些结果从未取得：\n" +
                  [...state.receipts.values()]
                    .slice(0, 4)
                    .concat([...state.receipts.values()].slice(4).slice(-4))
                    .join("\n") +
                  (state.receipts.size > 8
                    ? "\n另有已取得引用：" + [...state.receipts.keys()].slice(4, -4).join("、")
                    : ""),
              },
            ]
          : []),
        ...(state.reads.size
          ? [
              {
                name: "gea:read-status",
                text:
                  "本轮证据回读状态（index只表示已看索引；partial只表示已读片段；业务覆盖与正文读取分别判断）：" +
                  [...state.reads.values()].slice(-4).join("\n"),
              },
            ]
          : []),
        ...(state.failures.size
          ? [
              {
                name: "gea:read-gaps",
                text: "本轮失败/缺口（不覆盖成功回执）：" + [...state.failures.values()].join("\n"),
              },
            ]
          : []),
        ...(prefersBusinessCards(
          user?.type === "user/message"
            ? user.data.content
                .filter((b) => b.type === "text")
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("\n")
            : "",
        )
          ? [{ name: "gea:ui", text: UI_RULES }]
          : []),
        ...(state.readCalls >= PROMPT_BUDGET.evidenceCalls || state.calls >= state.limit
          ? [
              {
                name: "gea:budget",
                text:
                  state.readCalls >= PROMPT_BUDGET.evidenceCalls
                    ? agent.status === "running"
                      ? "本轮业务证据读取额度已用完，本轮全部工具已停止。直接用已展示数据交付结论、实际覆盖范围和未完成项；保留已有证据，未读结果保持未知，不重建查询或继续执行。下一轮重新核对身份、授权与额度。"
                      : "本轮业务证据读取额度已用完。停止新业务查询、业务能力加载和证据回读；直接用已展示数据交付结论、实际覆盖范围和未完成项。未读结果保持未知，不重建业务查询；通用文件、规划、任务和协作能力仍按官方规则可用。"
                    : "本轮业务查询额度已用完，不再发起业务查询。必要时在读取额度内沿nextRead读已取得证据，然后交付业务答复及未完成项；通用文件、规划、任务和协作能力仍按官方规则可用。",
              },
            ]
          : []),
      ];
      refreshMask(agent);
      const visible = new Set(ctx.tools.schemas(agent).map((tool) => tool.name));
      const tools = assembled.tools
        .filter((tool) => {
          if (!visible.has(tool.name)) return false;
          if (
            state.readCalls >= PROMPT_BUDGET.evidenceCalls &&
            (businessMethod(tool.name) || agent.status === "running")
          )
            return false;
          if (!businessMethod(tool.name)) return true;
          return state.calls < state.limit || tool.name === "gea_evidence_read";
        })
        .map((tool) =>
          businessToolDisplay({
            ...tool,
            description: TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
          }),
        );
      const measurement = promptMeasurement(
        sections.map((section) => section.text).join("\n\n"),
        tools,
      );
      console.info(
        JSON.stringify({
          event: "GEA_PROMPT_BUDGET",
          preset: presetOf(agent),
          ...measurement,
          calls: state.calls,
          resultChars: state.returned,
        }),
      );
      return { ...assembled, sections, tools };
    });
  });
  return () => {
    for (const off of offs.reverse()) off();
    for (const state of states.values()) state.dispose?.();
    states.clear();
    executionGrants.clear();
    executionState.dispose();
  };
}

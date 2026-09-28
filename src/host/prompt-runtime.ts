import { hasPageReferences } from "../../packages/page-interaction/src/reference.ts";
import { sessionConsumer } from "./business-identity.ts";
import { catalogFactSummary } from './gateway-catalog.ts';
import { salesSourceIssueForTurns, requestedOutputScope } from './sales-result-contract.ts';
import { prefersBusinessCards } from './business-presentation.ts';
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
import type {} from "@deepseek-ai/dsh-skill";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Business } from "./business.ts";
import type { CapabilityRegistry } from "../capability/registry.ts";
import { surfacePromptLine, isMainSurface } from "./workbench-surface.ts";
import {
  allowedTools,
  businessUiIssue,
  businessSections,
  COMMON_PROMPT,
  profileFor,
  PROFILES,
  PROMPT_BUDGET,
  promptMeasurement,
  shortSkillCatalog,
  TOOL_DESCRIPTIONS,
  TOOL_PACKS,
  type ToolPack,
} from "./prompt-policy.ts";
import { stopExpiredGateway } from "./agent-tools.ts";
import { forecastTool, FORECAST_VERSION } from "./forecast-compute.ts";
import { forecastInputHash, hasUserForecastInput } from "./forecast-source.ts";
import {
  PromptEvidenceStore,
  projectEvidence,
  withoutHistoricalEvidence,
  exactResult,
  type EvidenceGrant,
} from "./prompt-evidence.ts";

const UI_RULES =
  '业务概览、多指标、预测/库存结构或对比优先轻量卡片；简单事实或明确纯文字不用。用dsh-ui JSON围栏，根对象{"title":"标题","items":[节点]}；stat={type:"stat",label,value}、table={type:"table",columns,rows}、callout={type:"callout",content}。先1句结论，再1组卡片；结论、表格、说明各说一次，卡片后不重复数字和长篇解释。stat只放已核实数字，最多2项；版本名、未知量和缺口原因用短说明，不能放大成指标。按窄聊天栏设计：表格优先2列，最多3个短列，遵守前N；来源、日期范围、单位和版本放表外短注，不塞长列。标题和标签用业务中文，原始字段/表名仅排查时展示。缺数据说明影响，不补0；记录数不能改叫预测量。禁total:true自动合计、差额delta自动着色。复杂图表才读genui并校验；简单卡片无需通读Skill。按钮不授予写权限。';
const isUiSkill = (name: unknown) => name === 'genui' || name === 'visualize';
type State = {
  pageReferences?: boolean;
  preset: string;
  packs: Set<ToolPack>;
  skillNames: Set<string>;
  calls: number;
  readCalls: number;
  catalogFacts: Map<string, string>;
  loadedRules: Map<string, string>;
  steps: number;
  limit: number;
  dispose?: () => void;
  mask: string;
  evidence: string[];
  returned: number;
  receipts: Map<string, string>;
  instructions: Set<string>;
  deniedConsumers: Set<string>;
  reads: Map<string, string>;
  failures: Map<string, string>;
  catalogOutputs: Set<string>;
  catalogStalls: number;
  catalogGeneration: number;
  evidenceViews: Map<string, string>;
};

/** Only a still-visible tool result with the actual body counts; a compacted digest or user quote does not. */
export function instructionVisible(
  messages: readonly unknown[],
  id: string,
  content: string,
): boolean {
  const blocksContain = (blocks: unknown): boolean =>
    Array.isArray(blocks) &&
    blocks.some((block) => {
      if (!block || typeof block !== "object") return false;
      if (block.type === "tool-result") return blocksContain(block.content);
      if (block.type !== "text") return false;
      try {
        const value = JSON.parse(block.text);
        return value.instructionId === id && value.content === content;
      } catch {
        return false;
      }
    });
  return messages.some((message) => {
    const value = message as { source?: { kind?: string }; content?: unknown };
    return value.source?.kind === "tool" && blocksContain(value.content);
  });
}

/** Session-scoped prompt composition and execution gates share the same capability set. */
export function mountBusinessPrompts(
  ctx: Context,
  business: Business,
  capability: CapabilityRegistry,
  authorizations: Map<
    symbol,
    {
      consumer: string;
      resources: import("./authorized-resources.ts").AuthorizedResources;
    }
  >,
): () => void {
  const states = new Map<Agent, State>();
  const executionEpochs = new Map<symbol, number>();
  const catalogExecutions = new Map<
    symbol,
    { state: State; generation: number }
  >();
  const executionGrants = new Map<symbol, EvidenceGrant>();
  const runtimeId = randomUUID();
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  const userSupplied = (agent: Agent, digest: string) =>
    hasUserForecastInput(
      agent.session
        .snapshotEvents()
        .filter((event) => event.type === "user/message")
        .map((event) => event.data),
      digest,
    );
  const resourceProof = async (
    consumer: string,
    tool: string,
    signal: AbortSignal,
    scope: string,
  ) => {
    try {
      const module = await business.moduleMcp(consumer, signal);
      const snapshot = await module.authorizedResources(tool, signal);
      if (!snapshot.resources.length)
        throw Error("GEA_EVIDENCE_AUTHORIZATION_CHANGED");
      return hash(
        snapshot.resources.map((resource) => JSON.stringify(resource)).sort(),
      );
    } catch (error) {
      throw stopExpiredGateway(business, consumer, scope, error) ?? error;
    }
  };
  const valueHash = (text: string) => {
    const result = exactResult(text) as { value?: unknown };
    return hash(result.value ?? result);
  };

  const store = new PromptEvidenceStore(
    resolve(business.config.runtimeDir, "prompt-evidence"),
  );
  const presetOf = (agent: Agent) =>
    ctx.sessionProjections.stateOf(agent.session, "agentPreset");
  const profileOf = (agent: Agent | undefined) =>
    agent ? profileFor(presetOf(agent) ?? undefined) : undefined;
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
        packs: new Set(),
        skillNames: new Set(profileOf(agent)?.skills ?? []),
        calls: 0,
        readCalls: 0,
        catalogFacts: new Map(),
        loadedRules: new Map(),
        steps: 0,
        limit: PROMPT_BUDGET.calls,
        mask: "",
        evidence: [],
        returned: 0,
        receipts: new Map(),
        instructions: new Set(),
        deniedConsumers: new Set(),
        reads: new Map(),
        failures: new Map(),
        catalogOutputs: new Set(),
        catalogStalls: 0,
        catalogGeneration: 0,
        evidenceViews: new Map(),
      };
      // Restore only successful capability-loader choices, not arbitrary data that mentions a tool pack.
      const requests = new Map<string, { tool?: string; name?: string; pack?: ToolPack; skill?: string }>();
      for (const event of agent.session.snapshotEvents()) {
        if (
          event.type === "tool/call" &&
          (event.data.name === "gea_capabilities" || event.data.name === "gea_skill")
        ) {
          try {
            requests.set(event.data.callId, {...JSON.parse(event.data.arguments), tool:event.data.name});
          } catch {
            /* Invalid old call. */
          }
        } else if (event.type === "tool/result") {
          const call = requests.get(event.data.message.source.callId);
          if (!call) continue;
          for (const block of event.data.message.content) {
            if (block.type !== "tool-result" || block.isError) continue;
            for (const part of block.content)
              if (part.type === "text") {
                try {
                  const receipt = JSON.parse(part.text);
                  if (receipt.preset !== preset) continue;
                  if (call.tool === 'gea_skill') {
                    if (isUiSkill(call.name) && receipt.name === call.name && typeof receipt.instructionId === 'string') state.packs.add('ui');
                    continue;
                  }
                  if (
                    call.pack &&
                    call.pack in TOOL_PACKS &&
                    receipt.loaded?.includes(call.pack)
                  )
                    state.packs.add(call.pack);
                  if (
                    call.skill &&
                    receipt.skills?.some(
                      (skill: { name?: string }) => skill.name === call.skill,
                    )
                  )
                    state.skillNames.add(call.skill);
                  if (isUiSkill(call.skill) && receipt.loaded?.includes('ui')) state.packs.add('ui');
                } catch {
                  /* A partial or failed loader receipt grants nothing. */
                }
              }
          }
        }
      }
      if (state.packs.has("ui")) {
        state.skillNames.add("genui");
        state.skillNames.add("visualize");
      }
      states.set(agent, state);
      agent.ctx.effect(() => () => {
        state?.dispose?.();
        states.delete(agent);
      });
    }
    return state;
  };
  const businessSkill = (name: string, resourceBase?: {kind:string;path?:string}) =>
    /^sinian-/.test(name) || Object.values(PROFILES).some(profile => profile.skills.includes(name)) ||
    (resourceBase?.kind === 'directory' && typeof resourceBase.path === 'string' && resourceBase.path.startsWith(resolve(process.env.DSH_HOME || business.config.runtimeDir,'business-skills')+'/')) ||
    ['business-requirements-brief','genui','visualize'].includes(name);
  const namesFor = (agent: Agent, state = stateOf(agent)) => {
    const profile = profileOf(agent)!;
    const names = allowedTools(profile, state.packs);
    if (state.pageReferences || hasPageReferences(agent.session.snapshotEvents()))
      names.add("page_reference_read");
    if (business.config.agentSqlRead === true) names.add("gea_plugin_read");
    if (!isMainSurface(business.surfaceFor(agent.id)))
      for (const name of TOOL_PACKS.page) names.add(name);
    return names;
  };
  const refreshMask = (agent: Agent, candidate?: State) => {
    if (!profileOf(agent)) {
      states.get(agent)?.dispose?.();
      states.delete(agent);
      return;
    }
    const state = candidate ?? stateOf(agent);
    const names = namesFor(agent, state);
    // Probe only the public restriction contract; schemas() cannot see already masked names.
    let known: string[] = [];
    try {
      agent.ctx.tools.restrict({ deny: ["__gea_prompt_capability_probe__"] });
    } catch (error) {
      known = (/known global tools: (.*)$/.exec(String(error))?.[1] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    }
    if (!known.length) throw Error("GEA_TOOL_SCOPE_UNAVAILABLE");
    const allow = known.filter((name) => names.has(name));
    const signature = allow.sort().join("|");
    if (signature === state.mask) return;
    // Install the replacement before disposing the previous restriction: never a permissive gap.
    const next = agent.ctx.tools.restrict({ allow });
    state.dispose?.();
    state.dispose = next;
    state.mask = signature;
  };
  const clean = () => {
    store.clear();
    for (const state of states.values()) {
      state.evidence = [];
      state.calls = 0;
      state.readCalls = 0;
      state.catalogFacts.clear();
      state.loadedRules.clear();
      state.returned = 0;
      state.receipts.clear();
      state.instructions.clear();
      state.deniedConsumers.clear();
      state.reads.clear();
      state.evidenceViews.clear();
      state.failures.clear();
      state.catalogOutputs.clear();
      state.catalogStalls = 0;
      state.catalogGeneration++;
    }
  };
  const offs: Array<() => void> = [
    business.watchIdentity(clean),
    ctx.tools.register(forecastTool),
  ];
  offs.push(
    ctx.on("session/event", (session, event) => {
      if (event.type !== "turn/start") return;
      const agent = ctx.agents.get(session.id);
      if (!agent || !profileOf(agent)) return;
      const state = stateOf(agent);
      state.calls = 0;
      state.readCalls = 0;
      state.catalogFacts.clear();
      state.loadedRules.clear();
      state.steps = 0;
      state.returned = 0;
      state.receipts.clear();
      state.instructions.clear();
      state.deniedConsumers.clear();
      state.reads.clear();
      state.evidenceViews.clear();
      state.failures.clear();
      state.catalogOutputs.clear();
      state.catalogStalls = 0;
      state.catalogGeneration++;
      state.evidence = [];
      state.limit = PROMPT_BUDGET.calls;
    }),
  );
  offs.push(
    ctx.on("agent/pre-step", async ({ agent, messages = [] }, next) => {
      if (hasPageReferences(messages.filter(message => message.source.kind === "user")
        .map(data => ({type: "user/message", data})))) stateOf(agent).pageReferences = true;
      refreshMask(agent);
      if (profileOf(agent)) stateOf(agent).steps++;
      const decision = await next();
      if (decision.kind === "reject" || !profileOf(agent)) return decision;
      // Legacy presets may still install the generic loader. Business catalogs come from our scoped index.
      return {
        ...decision,
        messages: decision.messages.filter(
          (message) =>
            !["skill-catalog", "subagent-catalog"].includes(
              message.source.kind,
            ) ||
            (String(message.source.kind) === "subagent-catalog" &&
              stateOf(agent).packs.has("delegate")),
        ),
      };
    }),
  );
  offs.push(
    ctx.tools.guard((exec) => {
      const agent = exec.agent;
      if (!profileOf(agent) || !agent) return;
      const state = stateOf(agent);
      const callArgs = exec.arguments as Record<string, unknown>;
      if (exec.name === 'gea_sales_plan_read') {
        const questions = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user').map(event => event.type === 'user/message' ? event.data.content.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('\n') : '');
        const issue = salesSourceIssueForTurns(questions);
        if (issue) return issue;
      }
      const currentConsumer = sessionConsumer(ctx, business, agent.id);
      if (
        state.deniedConsumers.has(currentConsumer) &&
        typeof callArgs.consumerCode === "string" &&
        callArgs.consumerCode.trim() !== currentConsumer &&
        (exec.name === "gea_cube_query" ||
          exec.name === "gea_gateway_catalog" ||
          (exec.name === "gea_module_mcp" &&
            callArgs.tool === "query_business_data"))
      )
        return "GEA_CONSUMER_FALLBACK_DENIED: 当前业务身份的资源缺口不能通过轮换其它consumer试探；交付已有证据与缺口。";
      if (
        exec.name === "gea_evidence_read" &&
        business.turnStopKind(agent.id) === "session-expired"
      )
        return "GEA_GATEWAY_SESSION_EXPIRED: 本轮网关会话已过期，不能通过证据回读重建会话；下一轮重新验证。";
      // A spent read allowance ends this turn's tool phase; new queries would create evidence we cannot read.
      if (state.readCalls >= PROMPT_BUDGET.evidenceCalls)
        return "GEA_EVIDENCE_BUDGET: 本轮证据读取额度已用完，请交付已读范围并说明未读部分。";
      if (state.steps > state.limit + PROMPT_BUDGET.evidenceCalls)
        return "GEA_CALL_BUDGET: 本轮调用/步骤额度已用完，请交付已有结果并明确未完成项。";
      // Reserve before dispatch: parallel calls must not all pass against the same stale counter.
      if (exec.name === 'gea_evidence_read') {
        state.readCalls++;
      } else {
        if (state.calls >= state.limit)
          return 'GEA_CALL_BUDGET: 查询/能力调用额度已用完；仍可沿nextRead读取已取得证据，然后交付已有结果。';
        state.calls++;
      }
      if (exec.name === "gea_gateway_catalog" && state.catalogStalls >= 2)
        return "GEA_CATALOG_NO_PROGRESS: 目录连续未提供新信息；使用已返回成员执行最小gea_cube_query或说明具体缺口，查询后可按错误修正目录。本轮其它工具仍可用。";
      if (["render_ui", "validate_dsh_ui"].includes(exec.name)) {
        const issue = businessUiIssue(exec.arguments);
        if (issue) return issue;
      }
    }),
  );
  offs.push(
    ctx.on("tools/execute", async (exec, next) => {
      if (exec.agent && profileOf(exec.agent)) {
        // An actual query attempt, including a member error, permits targeted rediscovery.
        if (exec.name === "gea_cube_query") {
          stateOf(exec.agent).catalogStalls = 0;
          stateOf(exec.agent).catalogGeneration++;
        }
        if (exec.name === "gea_gateway_catalog") {
          const state = stateOf(exec.agent);
          catalogExecutions.set(exec.token, {
            state,
            generation: state.catalogGeneration,
          });
        }
        executionEpochs.set(exec.token, store.epoch());
        const args = exec.arguments as Record<string, unknown>;
        const grant: EvidenceGrant = {
          owner: owner(),
          ephemeral: ephemeral(exec.agent),
        };
        if (exec.name === "gea_sales_plan_read") grant.query = args;
        if (exec.name === "gea_forecast_compute") {
          const inputHash = forecastInputHash(args);
          if (userSupplied(exec.agent, inputHash))
            grant.computation = { inputHash, version: FORECAST_VERSION };
        }
        if (exec.name === "gea_cube_query" || exec.name === "gea_module_mcp")
          grant.kind = "mcp";
        executionGrants.set(exec.token, grant);
      }
      return next();
    }),
  );
  offs.push(
    ctx.on("tools/post-execute", async (exec, result, next) => {
      const decision = await next();
      const agent = exec.agent;
      const executionEpoch = executionEpochs.get(exec.token);
      const catalogExecution = catalogExecutions.get(exec.token);
      catalogExecutions.delete(exec.token);
      executionEpochs.delete(exec.token);
      const grant = executionGrants.get(exec.token);
      const authorization = authorizations.get(exec.token);
      authorizations.delete(exec.token);
      if (grant?.kind === "mcp" && authorization?.resources.resources.length) {
        grant.consumer = authorization.consumer;
        grant.resourceTool = "query_business_data";
        grant.resources = hash(
          authorization.resources.resources
            .map((resource) => JSON.stringify(resource))
            .sort(),
        );
      }
      executionGrants.delete(exec.token);
      if (agent && profileOf(agent)) {
        const args = exec.arguments as Record<string, unknown>;
        const texts = result.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n");
        const state = stateOf(agent);
        // Expand presentation only once the business read has returned, not in every initial context.
        const dataReturned = ['gea_cube_query','gea_page','gea_visible_workbench_context','gea_forecast_compute'].includes(exec.name)
          || (exec.name === 'gea_module_mcp' && args.tool === 'query_business_data' && (args.arguments as {action?:unknown} | undefined)?.action === 'query')
          || (exec.name === 'gea_gateway_catalog' && permissionDenied(texts));
        if (dataReturned && !result.isError && decision.kind === 'accept' && executionEpoch === store.epoch() && !state.packs.has('ui')) {
          const user = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
          const question = user?.type === 'user/message' ? user.data.content.filter(b=>b.type==='text').map(b=>b.type==='text'?b.text:'').join('\n') : '';
          if (prefersBusinessCards(question)) {
            const presentation: State = {...state,packs:new Set(state.packs),skillNames:new Set(state.skillNames)};
            presentation.packs.add('ui');presentation.skillNames.add('genui');presentation.skillNames.add('visualize');
            refreshMask(agent,presentation);Object.assign(state,presentation);
          }
        }
        if (
          exec.name === "gea_gateway_catalog" &&
          catalogExecution?.state === state &&
          catalogExecution.generation === state.catalogGeneration &&
          executionEpoch === store.epoch() &&
          decision.kind === "accept" &&
          !result.isError &&
          !permissionDenied(texts)
        ) {
          const fingerprint = hash(texts);
          const reused = texts.includes('"source":"GEA_CATALOG_REUSED"');
          state.catalogStalls =
            reused || state.catalogOutputs.has(fingerprint)
              ? state.catalogStalls + 1
              : 0;
          if (!reused) state.catalogOutputs.add(fingerprint);
          const facts = catalogFactSummary(texts);
          if (facts) {
            state.catalogFacts.set(String(args.model ?? 'catalog'), facts);
            while (state.catalogFacts.size > 2) state.catalogFacts.delete(state.catalogFacts.keys().next().value!);
          }
        }
        if (exec.name === 'gea_skill' && !result.isError && decision.kind === 'accept' && executionEpoch === store.epoch()) {
          try {
            const rule = JSON.parse(texts);
            if (rule.complete === true || rule.alreadyLoaded === true) {
              const lines = typeof rule.content === 'string' ? rule.content.split('\n').filter((line: string) => line.includes('目标库存=')).map((line: string) => line.slice(0,450)) : [];
              if (!state.loadedRules.has(String(rule.name)) || lines.length)
                state.loadedRules.set(String(rule.name), JSON.stringify({name:rule.name,version:rule.version,loaded:true, ...(lines.length?{calculationRules:lines}: {})}));
            }
          } catch {}
        }
        if (result.isError || resultOutcome(texts) === "blocked") {
          state.failures.set(
            hash([exec.name, exec.arguments]),
            JSON.stringify({
              tool: exec.name,
              status: "blocked",
              code:
                texts.match(/GEA_[A-Z_]+|AI_GATEWAY_[A-Z_]+/)?.[0] ??
                "TOOL_FAILED",
              note: "本次未取得有效结果；不撤销其它成功证据",
            }),
          );
          while (state.failures.size > 4)
            state.failures.delete(state.failures.keys().next().value!);
        }
        if (!result.isError && exec.name === "gea_evidence_read") {
          try {
            const part = JSON.parse(texts);
            state.reads.set(
              `${part.evidenceId}:${part.dataset ?? "raw"}`,
              JSON.stringify({
                evidenceId: part.evidenceId,
                dataset: part.dataset,
                name: part.name,
                display: part.projection ?? part.representation,
                rowOffset: part.rowOffset,
                returnedRows: part.returnedRows,
                readOffset: part.offset,
                nextOffset: part.nextOffset,
              }),
            );
          } catch {}
        }
        if (
          ["gea_gateway_catalog", "gea_cube_query", "gea_module_mcp"].includes(
            exec.name,
          ) &&
          permissionDenied(texts)
        )
          stateOf(agent).deniedConsumers.add(
            typeof args.consumerCode === "string" && args.consumerCode.trim()
              ? args.consumerCode.trim()
              : sessionConsumer(ctx, business, agent.id),
          );
      }

      if (
        !agent ||
        !profileOf(agent) ||
        result.isError ||
        decision.kind !== "accept" ||
        "value" in decision ||
        !/^gea_(?:sales_plan_read|cube_query|module_mcp|page|visible_workbench_context|forecast_compute)$/.test(
          exec.name,
        )
      )
        return decision;
      const content = decision.content ?? result.content;
      if (content.some((block) => block.type !== "text")) return decision;
      const rawText = content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      const text = withoutHistoricalEvidence(rawText);
      if (!text) return decision;
      if (resultOutcome(text) === "blocked")
        return {
          ...decision,
          content: [
            { type: "text", text: transientResult(text, PROMPT_BUDGET.result) },
          ],
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
                /^lightrag_/.test(
                  String(
                    (exec.arguments as Record<string, unknown>).tool ?? "",
                  ),
                ),
              ),
            },
          ],
        };
      const revision = executionEpoch ?? store.epoch();
      if (revision !== store.epoch())
        return {
          kind: "block",
          feedback: [
            {
              type: "text",
              text: "GEA_EVIDENCE_IDENTITY_CHANGED: 身份已改变，旧结果不能作为当前证据。",
            },
          ],
        };
      if (grant?.query) {
        try {
          grant.valueHash = valueHash(text);
        } catch {
          delete grant.query;
        }
      }
      const id = await store.put(agent.id, exec.name, text, revision, grant);
      const state = stateOf(agent);
      const alreadyDelivered = state.evidence.includes(id);
      const receiptKey = id;
      state.evidence = [...new Set([...state.evidence, id])].slice(-8);
      const compact = !alreadyDelivered && grant?.kind === 'mcp' ? compactDatasetProjection(text, id, PROMPT_BUDGET.result) : undefined;
      let projected = alreadyDelivered
        ? JSON.stringify({
            evidenceId: id,
            projection: "reference",
            note: "同一结果已返回，需要正文用 gea_evidence_read 回读。",
          })
        : compact ?? projectEvidence(
            text,
            id,
            PROMPT_BUDGET.result,
            grant?.kind === "mcp" ? resultView(text) : undefined,
          );
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
      state.receipts.set(
        receiptKey,
        resultReceipt(
          exec.name,
          exec.arguments as Record<string, unknown>,
          id,
          text,
          display,
        ),
      );
      state.returned += projected.length;
      return {
        ...decision,
        content: [{ type: "text" as const, text: projected }],
      };
    }),
  );

  const output = {
    schema: { type: "string" } as const,
    render: (_args: unknown, value: string) => [
      { type: "text" as const, text: value },
    ],
  };
  offs.push(
    ctx.tools.register(
      defineTool({
        name: "gea_capabilities",
        description:
          "按需发现规则或加载缺少的工具包；已提供工具直接用。加载不改变业务授权；复杂任务可选择complex额度。",
        parameters: {
          pack: { type: "string", enum: Object.keys(TOOL_PACKS) },
          skill: { type: "string" },
          complex: { type: "boolean" },
        },
        output,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (!exec.agent || !profileOf(exec.agent))
            throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const previous = stateOf(exec.agent);
          const revision = business.readTurnRevision(exec.agent.id);
          const available = (
            await ctx.skills.list({
              scope: exec.agent,
              cwd: exec.agent.session.header.cwd,
              signal: exec.signal,
            })
          ).filter(
            (skill) =>
              skill.invocation.modelInvocable &&
              businessSkill(skill.name,skill.resourceBase),
          );
          if (
            args.skill &&
            !available.some((skill) => skill.name === args.skill)
          )
            throw Error("GEA_SKILL_UNAVAILABLE");
          exec.signal.throwIfAborted();
          if (
            stateOf(exec.agent) !== previous ||
            business.readTurnRevision(exec.agent.id) !== revision
          )
            throw Error("GEA_CAPABILITY_STATE_CHANGED");
          const state: State = {
            ...previous,
            packs: new Set(previous.packs),
            skillNames: new Set(previous.skillNames),
          };
          if (args.pack) {
            state.packs.add(args.pack as ToolPack);
            if (args.pack === "ui") {
              state.skillNames.add("genui");
              state.skillNames.add("visualize");
            }
          }
          if (args.complex) state.limit = PROMPT_BUDGET.complexCalls;
          if (args.skill) state.skillNames.add(args.skill);
          if (isUiSkill(args.skill)) {
            state.packs.add('ui');
            state.skillNames.add('genui');
            state.skillNames.add('visualize');
          }
          refreshMask(exec.agent, state);
          // No async work between validation, native restriction replacement and commit.
          Object.assign(previous, state);
          return JSON.stringify({
            preset: presetOf(exec.agent),
            packs: Object.keys(TOOL_PACKS),
            loaded: [...state.packs],
            callLimit: state.limit,
            modulesAreConfiguredNotAuthorized: true,
            tools: ctx.tools.schemas(exec.agent).map((tool) => tool.name),
            modules: capability
              .readModules()
              .filter((module) => !module.data?.mock)
              .map((module) => ({
                name: module.label,
                consumerCode: module.data!.consumerCode,
              })),
            skills: available.map((skill) => ({
              name: skill.name,
              description: skill.description.slice(0, 70),
              enabled: state.skillNames.has(skill.name),
              bodyLoaded: state.loadedRules.has(skill.name),
              loadWith: 'gea_skill',
            })),
          });
        },
      }),
    ),
  );
  offs.push(
    ctx.tools.register(
      defineTool({
        name: "gea_skill",
        description:
          '按名称选择并加载当前会话可用业务规则，无需先capabilities选择。读正文省略path，例如 {"name":"inventory-qll","offset":1,"limit":80,"reload":true}。分页参数分别传入，不拼进path；path只接受正文链接的参考文件。未读章节沿nextRead读取。',
        parameters: {
          name: { type: "string", required: true },
          path: { type: "string", description: "仅参考文件的原始相对链接；读Skill正文省略。不能填分页参数或SKILL.md。" },
          offset: {
            type: "integer",
            description: "起始行，1起点；默认1，不能传0。",
          },
          limit: {
            type: "integer",
            description: "行数1–200；默认80。按返回的nextRead继续。",
          },
          reload: {
            type: "boolean",
            description: "确需重看已可见正文时传true；不改变规则版本。",
          },
        },
        output,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (!exec.agent || !profileOf(exec.agent))
            throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const state = stateOf(exec.agent);
          const ownProfile = profileOf(exec.agent)!;
          const revision = business.readTurnRevision(exec.agent.id);
          if (
            args.name === ownProfile.consumerCode &&
            ownProfile.skills.length === 1
          )
            args = { ...args, name: ownProfile.skills[0]! };
          if (!state.skillNames.has(args.name)) {
            const available = await ctx.skills.list({scope:exec.agent,cwd:exec.agent.session.header.cwd,signal:exec.signal});
            if (!available.some(skill => skill.name === args.name && skill.invocation.modelInvocable && businessSkill(skill.name, skill.resourceBase))) throw Error('GEA_SKILL_UNAVAILABLE');
          }
          const skill = await ctx.skills.get(args.name, {
            scope: exec.agent,
            cwd: exec.agent.session.header.cwd,
            signal: exec.signal,
          });
          if (!skill?.invocation.modelInvocable)
            throw Error("GEA_SKILL_UNAVAILABLE");
          // 只恢复已知且无歧义的模型误填；不猜测文件名，也不放宽链接校验。
          const misplaced = args.path?.match(
            /^\s*offset\s*(?:=\s*)?(\d+)\s*,\s*limit\s*(?:=\s*)?(\d+)\s*,\s*reload\s*=\s*(true|false)\s*$/i,
          );
          let argumentCorrection: string | undefined;
          if (misplaced) {
            const paging = {
              offset: Number(misplaced[1]),
              limit: Number(misplaced[2]),
              reload: misplaced[3]!.toLowerCase() === "true",
            };
            for (const key of ["offset", "limit", "reload"] as const)
              if (args[key] !== undefined && args[key] !== paging[key])
                throw Error("GEA_SKILL_ARGUMENT: path中的分页参数与独立参数冲突；读取正文请省略path，将offset、limit、reload分别传入。");
            args = { ...args, ...paging, path: undefined };
            argumentCorrection = "已将误填在path中的offset、limit、reload恢复为独立参数；本次读取Skill正文。";
          }
          let text = skill.content;
          if (args.path) {
            const links = [...text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)\)/g)].map(
              (match) => match[1]!.split("#")[0],
            );
            if (
              !links.includes(args.path) ||
              /^[a-z][a-z\d+.-]*:|^[\\/]/i.test(args.path) ||
              skill.resourceBase?.kind !== "directory"
            )
              throw Error(
                'GEA_SKILL_REFERENCE_NOT_LINKED: path必须原样使用Skill正文明确链接的相对路径。读取或重读正文请省略path，将分页参数分别传入：' +
                JSON.stringify({ name: args.name, offset: 1, limit: 80, reload: true }),
              );
            const path = await realpath(
              resolve(skill.resourceBase.path, args.path),
            );
            text = await readFile(path, "utf8");
          }
          const offset = args.offset ?? 1,
            limit = args.limit ?? 80;
          if (
            !Number.isSafeInteger(offset) ||
            offset < 1 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 200
          )
            throw Error(
              "GEA_SKILL_RANGE: offset为1起点行号，limit为1–200；重新从offset=1、limit=80读取，或沿用nextRead。",
            );
          const lines = text.split(/\r?\n/);
          const selected: string[] = [];
          for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
            if (selected.join("\n").length + line.length > 6000) break;
            selected.push(line);
          }
          if (!selected.length && offset <= lines.length)
            throw Error("GEA_SKILL_LINE_TOO_LARGE");
          const version = createHash("sha256")
            .update(text)
            .digest("hex")
            .slice(0, 16);
          const nextOffset =
            offset - 1 + selected.length < lines.length
              ? offset + selected.length
              : null;
          const content = selected.join("\n");
          exec.signal.throwIfAborted();
          if (stateOf(exec.agent) !== state || business.readTurnRevision(exec.agent.id) !== revision) throw Error('GEA_CAPABILITY_STATE_CHANGED');
          const selection: State = {...state,packs:new Set(state.packs),skillNames:new Set(state.skillNames)};
          selection.skillNames.add(args.name);
          if (isUiSkill(args.name)) {
            selection.packs.add('ui');
            selection.skillNames.add('genui');
            selection.skillNames.add('visualize');
            refreshMask(exec.agent,selection);
          }
          Object.assign(state,selection);
          const instructionId = hash([
            args.name,
            args.path ?? "",
            version,
            offset,
            nextOffset,
            content,
          ]).slice(0, 24);
          const repeated = state.instructions.has(instructionId);
          state.instructions.add(instructionId);
          if (
            repeated &&
            !args.reload &&
            instructionVisible(
              exec.agent.session.deriveMessages(),
              instructionId,
              content,
            )
          )
            return JSON.stringify({
              name: args.name,
              preset: presetOf(exec.agent),
              version,
              instructionId,
              alreadyLoaded: true,
              ...(argumentCorrection ? { argumentCorrection } : {}),
              note: "该段正文仍在当前上下文中，请直接使用；确需重看使用nextRead。",
              nextRead: {
                tool: "gea_skill",
                args: {
                  name: args.name,
                  ...(args.path ? { path: args.path } : {}),
                  offset,
                  limit,
                  reload: true,
                },
              },
            });
          return JSON.stringify({
            name: args.name,
            preset: presetOf(exec.agent),
            version,
            instructionId,
            source: skill.provider,
            ...(argumentCorrection ? { argumentCorrection } : {}),
            path: args.path,
            offset,
            nextOffset,
            nextRead:
              nextOffset === null
                ? null
                : {
                    tool: "gea_skill",
                    args: {
                      name: args.name,
                      ...(args.path ? { path: args.path } : {}),
                      offset: nextOffset,
                      limit,
                    },
                  },
            complete: offset === 1 && nextOffset === null,
            content,
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
          format: {type:'string',enum:['structured','raw'],description:'默认structured；raw仅审计原始包，不能用它替代已展示的业务行。'},
          reload: {type:'boolean',description:'明确需要重新展示已读视图时使用，不重新查询。'},
          dataset: {
            type: "string",
            description:
              "使用evidenceDatasets的key/nextRead读取业务行；省略时返回结构化业务结果或索引。",
          },
          datasetId: {
            type: "string",
            description:
              "dataset的兼容别名，取evidenceDatasets.key；优先直接照nextRead调用。",
          },
          rowOffset: {
            type: "integer",
            description:
              "dataset模式的0起点行偏移，默认0；不与字符offset混用。",
          },
          rowLimit: {
            type: "integer",
            description: "dataset模式每次1–100行，默认30；仍受响应大小限制。",
          },
          evidenceId: { type: "string", required: true },
          offset: { type: "integer", description: "字符偏移，0起点；默认0。" },
          limit: {
            type: "integer",
            description:
              "字符数1–6000；默认4000，不可传更大值。优先使用返回的nextRead。",
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
          if (args.datasetId && !args.dataset)
            args = { ...args, dataset: args.datasetId };
          if (args.dataset && args.format === 'raw') throw Error('GEA_EVIDENCE_READ_MODE: dataset和raw不能混用。');

          if (
            !args.dataset &&
            (args.rowOffset !== undefined || args.rowLimit !== undefined)
          )
            throw Error(
              "GEA_EVIDENCE_READ_MODE: rowOffset/rowLimit必须指定dataset；不会忽略行参数退回原文模式。",
            );
          if (
            args.dataset &&
            (args.offset !== undefined || args.limit !== undefined)
          )
            throw Error(
              "GEA_EVIDENCE_READ_MODE: dataset模式使用rowOffset/rowLimit，原文模式使用offset/limit，按nextRead调用。",
            );
          const read = await store.read(
              agent.id,
              args.evidenceId,
              args.offset,
              args.limit,
              async (grant, tool) => {
                if (
                  /^gea_(cube_query|module_mcp)$/.test(tool) &&
                  (!grant.consumer || !grant.resources)
                )
                  throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
                if (grant.owner !== owner())
                  throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
                if (grant.consumer && grant.resourceTool && grant.resources) {
                  if (
                    (await resourceProof(
                      grant.consumer,
                      grant.resourceTool,
                      exec.signal,
                      agent.id,
                    )) !== grant.resources
                  )
                    throw Error("GEA_EVIDENCE_AUTHORIZATION_CHANGED");
                } else if (grant.kind === "mcp")
                  throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
                else if (grant.query && grant.valueHash) {
                  // Direct sales reads have no resource-version endpoint. Revalidate the exact query under current row permissions.
                  const current = await business.agentQuery(
                    grant.query,
                    exec.signal,
                  );
                  if (valueHash(current) !== grant.valueHash)
                    throw Error(
                      "GEA_EVIDENCE_STALE: 数据或权限范围已改变，请取得新的结果。",
                    );
                } else if (
                  tool === "gea_forecast_compute" &&
                  grant.computation
                ) {
                  if (
                    grant.computation.version !== FORECAST_VERSION ||
                    !userSupplied(agent, grant.computation.inputHash)
                  )
                    throw Error(
                      "GEA_EVIDENCE_STALE: 计算规则或用户输入来源无法核对。",
                    );
                } else if (grant.ephemeral !== ephemeral(agent))
                  throw Error(
                    "GEA_EVIDENCE_STALE: 页面或临时结果需要重新读取。",
                  );
              },
              args.format === 'raw' || (args.format === undefined && Number(args.offset) > 0) ? undefined : (raw) => {
                const index = datasetIndex(raw,args.evidenceId);
                // Old non-Cube consumers use character slices (e.g. calculation drafts).
                if (!index.length && args.format === undefined && (args.offset !== undefined || args.limit !== undefined)) {
                  const offset=args.offset??0,limit=args.limit??4000,nextOffset=offset+limit<raw.length?offset+limit:null;
                  return {projection:offset===0&&raw.length<=limit?'complete':'partial',offset,totalChars:raw.length,nextOffset,content:raw.slice(offset,offset+limit),nextRead:nextOffset===null?null:{tool:'gea_evidence_read',args:{evidenceId:args.evidenceId,format:'raw',offset:nextOffset,limit}}};
                }
                const view = args.dataset ? readDataset(raw,args.evidenceId,args.dataset,args.rowOffset,args.rowLimit)
                  : exactResult(compactDatasetProjection(raw,args.evidenceId) ?? (index.length ? JSON.stringify({evidenceDatasets:index,projection:'index',nextRead:index[0]?.nextRead}) : projectEvidence(raw,args.evidenceId))) as Record<string,unknown>;
                const state = stateOf(agent), viewId=hash(view), key = `${args.evidenceId}:${viewId}`;
                const prior = state.evidenceViews.get(key);
                const visible = prior && JSON.stringify(agent.session.deriveMessages()).includes(viewId);
                if (visible && !args.reload) return {evidenceId:args.evidenceId,projection:'already-delivered',note:'此视图已完整返回并仍在上下文，直接使用已有业务行。无需重读。',evidenceDatasets:index,businessFacts:(view as {datasets?: Array<{businessFacts?:unknown}>}).datasets?.map(d=>d.businessFacts),nextRead:(view as {nextRead?:unknown}).nextRead??null};
                state.evidenceViews.set(key, viewId);
                while(state.evidenceViews.size>32)state.evidenceViews.delete(state.evidenceViews.keys().next().value!);
                return {...view,viewId};
              },
            );
          return JSON.stringify(read);
        },
      }),
    ),
  );

  ctx.inject(["systemPrompt", "skills"], (promptCtx) => {
    promptCtx.on("system-prompt/assemble", async (_assembly, context, next) => {
      const assembled = await next();
      const agent = context.agent as Agent | undefined;
      const profile = profileOf(agent);
      if (!agent || !profile) return assembled;
      const state = stateOf(agent);
      const skills = (
        await ctx.skills.list({ scope: agent, cwd: agent.session.header.cwd })
      ).filter(
        (skill) =>
          state.skillNames.has(skill.name) && skill.invocation.modelInvocable,
      );
      const date = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
      const consumer = sessionConsumer(ctx, business, agent.id);
      const user = agent.session.snapshotEvents().findLast(event => event.type === 'user/message' && event.data.source.kind === 'user');
      const outputScope = requestedOutputScope(user?.type === 'user/message' ? user.data.content.filter(b=>b.type==='text').map(b=>b.type==='text'?b.text:'').join('\n') : '');
      const facts = `日期：${date}；时区：Asia/Shanghai。Agent：${profile.label}；业务编码：${consumer}。\n${surfacePromptLine(business.surfaceFor(agent.id))}`;
      const sections = [
        ...businessSections(assembled.sections),
        { name: "gea:common", text: COMMON_PROMPT },
        { name: "gea:persona", text: profile.persona },
        {
          name: "gea:capabilities",
          text:
            `可见工具直接用；缺工具才gea_capabilities。forecast仅做预测计算，查预测用Cube；规则缺失才gea_skill，查数不用Skill。${state.packs.size ? `已加载工具包：${[...state.packs].sort().join("、")}。` : ""}\n` +
            shortSkillCatalog(skills),
        },
        { name: "gea:facts", text: facts },
        ...(outputScope ? [{name:'gea:output-scope',text:outputScope}] : []),
        ...(state.catalogFacts.size || state.loadedRules.size ? [{name:'gea:confirmed-semantics', text:'本轮已成功返回的字段、单位和规则（不是新的授权；猜测列名不存在不等于无对应业务字段）：\n'+[...state.catalogFacts.values(),...state.loadedRules.values()].join('\n')}] : []),
        ...(state.catalogStalls >= 2
          ? [
              {
                name: "gea:query-progress",
                text: "目录连续未提供新信息，暂不继续探索目录。已有成员用于最小gea_cube_query，原结果用nextRead按数据集续读；执行查询后可再按具体错误核对目录。规则题直接用已核验规则，数据缺口明确记录，不换关键词或加载知识来代替取数。",
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
                    ? "\n另有已取得引用：" +
                      [...state.receipts.keys()].slice(4, -4).join("、")
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
                text:
                  "本轮失败/缺口（不覆盖成功回执）：" +
                  [...state.failures.values()].join("\n"),
              },
            ]
          : []),
        ...(state.packs.has("ui") ? [{ name: "gea:ui", text: UI_RULES }] : []),
        ...(state.readCalls >= PROMPT_BUDGET.evidenceCalls || state.calls >= state.limit || state.steps > state.limit + PROMPT_BUDGET.evidenceCalls
          ? [
              {
                name: "gea:budget",
                text: state.readCalls >= PROMPT_BUDGET.evidenceCalls
                  ? "本轮证据读取额度已用完，工具阶段结束。停止新查询、能力加载和证据回读；直接用已展示数据交付结论、实际覆盖范围和未完成项。未读结果保持未知，不重建查询或等待工具；不输出工具协议文本。"
                  : "本轮查询额度已用完，不再新查。必要时在读取额度内沿nextRead读已取得证据，然后交付业务答复及未完成项；不输出工具协议文本。",
              },
            ]
          : []),
      ];
      refreshMask(agent);
      const visible = new Set(
        ctx.tools.schemas(agent).map((tool) => tool.name),
      );
      const tools =
        state.steps > state.limit + PROMPT_BUDGET.evidenceCalls || state.readCalls >= PROMPT_BUDGET.evidenceCalls
          ? []
          : assembled.tools
              .filter((tool) => visible.has(tool.name) && (state.calls < state.limit || tool.name === 'gea_evidence_read'))
              .map((tool) => ({
                ...tool,
                description: TOOL_DESCRIPTIONS[tool.name] ?? tool.description,
              }));
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
          steps: state.steps,
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
    executionEpochs.clear();
    catalogExecutions.clear();
    executionGrants.clear();
    authorizations.clear();
    store.clear();
  };
}

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
import { forecastTool } from "./forecast-compute.ts";
import {
  PromptEvidenceStore,
  projectEvidence,
  withoutHistoricalEvidence,
  exactResult,
  type EvidenceGrant,
} from "./prompt-evidence.ts";

const UI_RULES =
  "需要交互时可输出 dsh-ui JSON 围栏，普通答复无需组件。常用 table={columns,rows}、callout={content}、stat={label,value}、button={label,action}。只输出已核实数字，不设 total:true 自动合计；计划差额不使用按正负自动着色的 delta，默认中性色。交互 action 只表达用户意图，不能绕过后台授权；发出复杂围栏前用 validate_dsh_ui 校验。更多组件先 gea_skill(name=genui)。";
type State = {
  preset: string;
  packs: Set<ToolPack>;
  skillNames: Set<string>;
  calls: number;
  steps: number;
  limit: number;
  dispose?: () => void;
  mask: string;
  evidence: string[];
  returned: number;
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
        steps: 0,
        limit: PROMPT_BUDGET.calls,
        mask: "",
        evidence: [],
        returned: 0,
      };
      // Restore only successful capability-loader choices, not arbitrary data that mentions a tool pack.
      const requests = new Map<string, { pack?: ToolPack; skill?: string }>();
      for (const event of agent.session.snapshotEvents()) {
        if (
          event.type === "tool/call" &&
          event.data.name === "gea_capabilities"
        ) {
          try {
            requests.set(event.data.callId, JSON.parse(event.data.arguments));
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
  const namesFor = (agent: Agent) => {
    const profile = profileOf(agent)!;
    const state = stateOf(agent);
    const names = allowedTools(profile, state.packs);
    if (business.config.agentSqlRead === true) names.add("gea_plugin_read");
    if (!isMainSurface(business.surfaceFor(agent.id)))
      for (const name of TOOL_PACKS.page) names.add(name);
    return names;
  };
  const refreshMask = (agent: Agent) => {
    if (!profileOf(agent)) {
      states.get(agent)?.dispose?.();
      states.delete(agent);
      return;
    }
    const state = stateOf(agent);
    const names = namesFor(agent);
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
      state.returned = 0;
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
      state.steps = 0;
      state.returned = 0;
      state.evidence = [];
      state.limit = PROMPT_BUDGET.calls;
    }),
  );
  offs.push(
    ctx.on("agent/pre-step", async ({ agent }, next) => {
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
      if (
        exec.name === "gea_evidence_read" &&
        business.turnStopKind(agent.id) === "session-expired"
      )
        return "GEA_GATEWAY_SESSION_EXPIRED: 本轮网关会话已过期，不能通过证据回读重建会话；下一轮重新验证。";
      if (state.calls >= state.limit || state.steps > state.limit)
        return "GEA_CALL_BUDGET: 本轮调用/步骤额度已用完，请交付已有结果并明确未完成项。";
      // Reserve before dispatch: parallel calls must not all pass against the same stale counter.
      state.calls++;
      if (["render_ui", "validate_dsh_ui"].includes(exec.name)) {
        const issue = businessUiIssue(exec.arguments);
        if (issue) return issue;
      }
    }),
  );
  offs.push(
    ctx.on("tools/execute", async (exec, next) => {
      if (exec.agent && profileOf(exec.agent)) {
        executionEpochs.set(exec.token, store.epoch());
        const args = exec.arguments as Record<string, unknown>;
        const grant: EvidenceGrant = {
          owner: owner(),
          ephemeral: ephemeral(exec.agent),
        };
        if (exec.name === "gea_sales_plan_read") grant.query = args;
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
      // Without the exact query's authorization receipt, preserve the original one-time result.
      // Never invent a reusable permission from an empty snapshot or page/turn identity.
      if (grant?.kind === "mcp" && !grant.resources)
        return { ...decision, content: [{ type: "text", text }] };
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
      state.evidence = [...new Set([...state.evidence, id])].slice(-8);
      const projected = alreadyDelivered
        ? JSON.stringify({
            evidenceId: id,
            projection: "reference",
            note: "同一结果已返回，需要正文用 gea_evidence_read 回读。",
          })
        : projectEvidence(text, id, PROMPT_BUDGET.result);
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
          "按需查看或加载额外工具包/业务规则。加载只改变本会话可见能力，不改变业务授权；工具参数在下一步的真实 Schema 中提供。复杂任务可选择 complex 额度。",
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
          const state = stateOf(exec.agent);
          if (args.pack) {
            state.packs.add(args.pack as ToolPack);
            if (args.pack === "ui") {
              state.skillNames.add("genui");
              state.skillNames.add("visualize");
            }
          }
          if (args.complex) state.limit = PROMPT_BUDGET.complexCalls;
          const available = (
            await ctx.skills.list({
              scope: exec.agent,
              cwd: exec.agent.session.header.cwd,
              signal: exec.signal,
            })
          ).filter(
            (skill) =>
              skill.invocation.modelInvocable &&
              (/^sinian-/.test(skill.name) ||
                Object.values(PROFILES).some((profile) =>
                  profile.skills.includes(skill.name),
                ) ||
                (skill.resourceBase?.kind === "directory" &&
                  skill.resourceBase.path.startsWith(
                    resolve(
                      process.env.DSH_HOME || business.config.runtimeDir,
                      "business-skills",
                    ) + "/",
                  )) ||
                ["business-requirements-brief", "genui", "visualize"].includes(
                  skill.name,
                )),
          );
          if (args.skill) {
            if (!available.some((skill) => skill.name === args.skill))
              throw Error("GEA_SKILL_UNAVAILABLE");
            state.skillNames.add(args.skill);
          }
          refreshMask(exec.agent);
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
          "加载当前 Agent 的业务规则；缺少规则先 gea_capabilities 查看并选择。path 只接受正文明确链接的本地参考文件，offset/limit 按行读取。返回版本和完整性，未包含的章节需继续读取。",
        parameters: {
          name: { type: "string", required: true },
          path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        output,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          if (!exec.agent || !profileOf(exec.agent))
            throw Error("GEA_BUSINESS_SESSION_REQUIRED");
          const state = stateOf(exec.agent);
          if (!state.skillNames.has(args.name))
            throw Error(
              "GEA_SKILL_NOT_LOADED: 先 gea_capabilities 选择该业务规则。",
            );
          const skill = await ctx.skills.get(args.name, {
            scope: exec.agent,
            cwd: exec.agent.session.header.cwd,
            signal: exec.signal,
          });
          if (!skill?.invocation.modelInvocable)
            throw Error("GEA_SKILL_UNAVAILABLE");
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
              throw Error("GEA_SKILL_REFERENCE_NOT_LINKED");
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
            throw Error("GEA_SKILL_RANGE");
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
          const instructionId = hash([
            args.name,
            args.path ?? "",
            version,
            offset,
            nextOffset,
            content,
          ]).slice(0, 24);
          if (
            instructionVisible(
              exec.agent.session.deriveMessages(),
              instructionId,
              content,
            )
          )
            return JSON.stringify({
              name: args.name,
              version,
              instructionId,
              alreadyLoaded: true,
              note: "该段正文仍在当前上下文中，请直接使用。",
            });
          return JSON.stringify({
            name: args.name,
            version,
            instructionId,
            source: skill.provider,
            path: args.path,
            offset,
            nextOffset,
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
          "回读本会话已取得的结果原文，不重新执行查询。仅接受宿主返回的 evidenceId；offset/limit 为字符位置，分段不等于全量业务覆盖。",
        parameters: {
          evidenceId: { type: "string", required: true },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        output,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const agent = exec.agent;
          if (!agent) throw Error("SESSION_REQUIRED");
          return JSON.stringify(
            await store.read(
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
                } else if (grant.ephemeral !== ephemeral(agent))
                  throw Error(
                    "GEA_EVIDENCE_STALE: 页面或临时结果需要重新读取。",
                  );
              },
            ),
          );
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
      const consumer =
        presetOf(agent) === "gea-readonly"
          ? business.config.analysisAgentCode
          : profile.consumerCode;
      const facts = `日期：${date}；时区：Asia/Shanghai。Agent：${profile.label}；业务编码：${consumer}。\n${surfacePromptLine(business.surfaceFor(agent.id))}`;
      const sections = [
        ...businessSections(assembled.sections),
        { name: "gea:common", text: COMMON_PROMPT },
        { name: "gea:persona", text: profile.persona },
        {
          name: "gea:capabilities",
          text:
            "专项规则用 gea_skill；需要页面、知识库、图表、委派或预测计算时用 gea_capabilities 加载对应包。普通取数不必加载 Skill。\n" +
            shortSkillCatalog(skills),
        },
        { name: "gea:facts", text: facts },
        {
          name: "gea:evidence-index",
          text: state.evidence.length
            ? `本轮已返回证据：${state.evidence.join("、")}。它们是数据引用，不是授权；需要正文可用 gea_evidence_read。`
            : "",
        },
        ...(state.packs.has("ui") ? [{ name: "gea:ui", text: UI_RULES }] : []),
        ...(state.calls >= state.limit || state.steps > state.limit
          ? [
              {
                name: "gea:budget",
                text: "本轮工具额度已用完。请交付已有证据和未完成项，不声称全部完成。",
              },
            ]
          : []),
      ];
      refreshMask(agent);
      const visible = new Set(
        ctx.tools.schemas(agent).map((tool) => tool.name),
      );
      const tools =
        state.calls >= state.limit || state.steps > state.limit
          ? []
          : assembled.tools
              .filter((tool) => visible.has(tool.name))
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
    executionGrants.clear();
    authorizations.clear();
    store.clear();
  };
}

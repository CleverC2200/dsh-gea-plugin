import type { Context } from "@deepseek-ai/cordis";
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import type { Business } from "./business.ts";
import { createHash, randomUUID } from "node:crypto";
import { sessionConsumer } from "./business-identity.ts";
import { catalogFactSummary } from "./gateway-catalog.ts";
import { PROMPT_BUDGET } from "./prompt-policy.ts";
import {
  resultReceipt,
  transientResult,
  permissionDenied,
  resultOutcome,
  datasetIndex,
  readDataset,
  compactDatasetProjection,
} from "./prompt-result.ts";
import type { Agent } from "@deepseek-ai/dsh-agent";
import {
  PromptEvidenceStore,
  projectEvidence,
  withoutHistoricalEvidence,
  exactResult,
  type EvidenceGrant,
} from "./prompt-evidence.ts";

declare const executionBrand: unique symbol;
/** Issued by this owner. No mutable state or identity revision is exposed. */
export type PromptExecution = { readonly [executionBrand]: true };
type State = {
  preset: string;
  evidence: string[];
  returned: number;
  receipts: Map<string, string>;
  deniedConsumers: Set<string>;
  reads: Map<string, string>;
  failures: Map<string, string>;
  catalogFacts: Map<string, string>;
  catalogOutputs: Set<string>;
  catalogStalls: number;
  catalogGeneration: number;
  evidenceViews: Map<string, string>;
};
export type PromptExecutionSnapshot = {
  readonly evidence: readonly string[];
  readonly returned: number;
  readonly receipts: ReadonlyMap<string, string>;
  readonly deniedConsumers: ReadonlySet<string>;
  readonly reads: ReadonlyMap<string, string>;
  readonly failures: ReadonlyMap<string, string>;
  readonly catalogFacts: ReadonlyMap<string, string>;
  readonly catalogStalls: number;
};
type Execution = {
  agent: Agent;
  state: State;
  epoch: number;
  catalogGeneration: number;
  call?: Pick<ToolExecution, "name" | "arguments" | "signal">;
  grant?: EvidenceGrant;
};
type Outcome = {
  failure?: { key: string; text: string };
  deniedConsumer?: string;
  read?: { key: string; text: string };
  catalog?: {
    fingerprint: string;
    reused: boolean;
    model: string;
    facts?: string;
  };
};
export type Publication =
  | { kind: "published"; text: string }
  | { kind: "stale-context" }
  | { kind: "identity-changed" };
type ExecutionEnvironment = { ctx: Context; business: Business };
type EvidenceReadArguments = {
  evidenceId: string;
  dataset?: string;
  datasetId?: string;
  rowOffset?: number;
  rowLimit?: number;
  offset?: number;
  limit?: number;
  format?: string;
  reload?: boolean;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const valueHash = (text: string) => {
  const result = exactResult(text) as { value?: unknown };
  return hash(result.value ?? result);
};
const cubeMethod = (name: string) =>
  name === "mcp__gea-gateway__inspect_cube_model" ||
  name === "mcp__gea-gateway__query_business_data";
const fresh = (preset: string): State => ({
  preset,
  evidence: [],
  returned: 0,
  receipts: new Map(),
  deniedConsumers: new Set(),
  reads: new Map(),
  failures: new Map(),
  catalogFacts: new Map(),
  catalogOutputs: new Set(),
  catalogStalls: 0,
  catalogGeneration: 0,
  evidenceViews: new Map(),
});

/** Owns asynchronous prompt effects. Callers receive copies and semantic operations only. */
export class PromptExecutionState {
  #states = new Map<Agent, State>();
  #pending = new Map<symbol, PromptExecution>();
  #executions = new WeakMap<PromptExecution, Execution>();
  #store: PromptEvidenceStore;
  #runtimeId = randomUUID();
  #host?: ExecutionEnvironment;
  #presetOf: (agent: Agent) => string | undefined;
  #isBusinessPreset: (preset: string) => boolean;
  constructor(
    directory: string,
    presetOf: (agent: Agent) => string | undefined,
    isBusinessPreset: (preset: string) => boolean,
    host?: ExecutionEnvironment,
  ) {
    this.#store = new PromptEvidenceStore(directory);
    this.#host = host;
    this.#presetOf = presetOf;
    this.#isBusinessPreset = isBusinessPreset;
  }
  #environment(): ExecutionEnvironment {
    if (!this.#host) throw Error("GEA_EXECUTION_ENVIRONMENT_REQUIRED");
    return this.#host;
  }
  #owner(): string {
    const { business } = this.#environment();
    const status = business.status();
    return hash([
      status.source,
      status.environment,
      status.user?.id,
      status.user?.tenantId,
      status.permissionCodes,
      status.roles,
    ]);
  }
  #ephemeral(agent: Agent): string {
    const { business } = this.#environment();
    return `${this.#runtimeId}:${business.readTurnRevision(agent.id)}:${business.surfaceFor(agent.id)?.menu ?? ""}`;
  }
  async #resourceProof(
    consumer: string,
    tool: string,
    signal: AbortSignal,
    scope: string,
  ): Promise<string> {
    const { business } = this.#environment();
    try {
      const module = await business.moduleMcp(consumer, signal);
      const snapshot = await module.authorizedResources(tool, signal);
      if (!snapshot.resources.length) throw Error("GEA_EVIDENCE_AUTHORIZATION_CHANGED");
      return hash(snapshot.resources.map((resource) => JSON.stringify(resource)).sort());
    } catch (error) {
      const { stopExpiredGateway } = await import("./agent-tools.ts");
      throw stopExpiredGateway(business, consumer, scope, error) ?? error;
    }
  }
  #stateOf(agent: Agent): State {
    const preset = this.#presetOf(agent) ?? "";
    let state = this.#states.get(agent);
    if (!state || state.preset !== preset) {
      state = fresh(preset);
      this.#states.set(agent, state);
    }
    return state;
  }
  #current(lease: PromptExecution | undefined): Execution | undefined {
    const execution = lease && this.#executions.get(lease);
    if (!execution || execution.epoch !== this.#store.epoch()) return;
    const state = this.#states.get(execution.agent);
    if (state !== execution.state) return;
    const preset = this.#presetOf(execution.agent) ?? "";
    if (!this.#isBusinessPreset(preset) || state.preset !== preset) return;
    return execution;
  }
  begin(
    agent: Agent,
    token: symbol,
    call?: Pick<ToolExecution, "name" | "arguments" | "signal">,
  ): PromptExecution {
    const state = this.#stateOf(agent);
    const lease = {} as PromptExecution;
    this.#executions.set(lease, {
      agent,
      state,
      epoch: this.#store.epoch(),
      catalogGeneration: state.catalogGeneration,
      call: call && { ...call, arguments: structuredClone(call.arguments) },
    });
    this.#pending.set(token, lease);
    return lease;
  }
  admitted(lease: PromptExecution | undefined, tool?: string): void {
    const execution = this.#current(lease);
    if (!execution) return;
    if ((execution.call?.name ?? tool) === "mcp__gea-gateway__query_business_data") {
      execution.state.catalogStalls = 0;
      execution.state.catalogGeneration++;
    }
    execution.catalogGeneration = execution.state.catalogGeneration;
    if (execution.call) {
      execution.grant = { owner: this.#owner(), ephemeral: this.#ephemeral(execution.agent) };
      if (execution.call.name === "forecast_compute") execution.grant.kind = "local";
      if (execution.call.name === "gea_sales_plan_read")
        execution.grant.query = execution.call.arguments as Record<string, unknown>;
    }
  }
  execution(token: symbol): PromptExecution | undefined {
    return this.#pending.get(token);
  }
  take(token: symbol): PromptExecution | undefined {
    const lease = this.#pending.get(token);
    this.#pending.delete(token);
    return lease;
  }
  startTurn(agent: Agent): void {
    this.#states.set(agent, fresh(this.#presetOf(agent) ?? ""));
  }
  forget(agent: Agent): void {
    this.#states.delete(agent);
    for (const [token, lease] of this.#pending) {
      if (this.#executions.get(lease)?.agent === agent) this.#pending.delete(token);
    }
  }
  clear(): void {
    this.#store.clear();
    this.#states.clear();
  }
  dispose(): void {
    this.clear();
    this.#pending.clear();
  }
  snapshot(agent: Agent): PromptExecutionSnapshot {
    const state = this.#stateOf(agent);
    return {
      evidence: [...state.evidence],
      returned: state.returned,
      receipts: new Map(state.receipts),
      deniedConsumers: new Set(state.deniedConsumers),
      reads: new Map(state.reads),
      failures: new Map(state.failures),
      catalogFacts: new Map(state.catalogFacts),
      catalogStalls: state.catalogStalls,
    };
  }
  recordOutcome(lease: PromptExecution | undefined, outcome: Outcome): void {
    const execution = this.#current(lease);
    if (!execution) return;
    const state = execution.state;
    if (outcome.failure) {
      state.failures.set(outcome.failure.key, outcome.failure.text);
      while (state.failures.size > 4) state.failures.delete(state.failures.keys().next().value!);
    }
    if (outcome.read) state.reads.set(outcome.read.key, outcome.read.text);
    if (outcome.deniedConsumer) state.deniedConsumers.add(outcome.deniedConsumer);
    const catalog = outcome.catalog;
    if (catalog && execution.catalogGeneration === state.catalogGeneration) {
      state.catalogStalls =
        catalog.reused || state.catalogOutputs.has(catalog.fingerprint)
          ? state.catalogStalls + 1
          : 0;
      if (!catalog.reused) state.catalogOutputs.add(catalog.fingerprint);
      if (catalog.facts) {
        state.catalogFacts.set(catalog.model, catalog.facts);
        while (state.catalogFacts.size > 2)
          state.catalogFacts.delete(state.catalogFacts.keys().next().value!);
      }
    }
  }
  async publishEvidence(
    lease: PromptExecution | undefined,
    tool: string,
    text: string,
    grant: EvidenceGrant | undefined,
    project: (id: string, alreadyDelivered: boolean) => { text: string; receipt: string },
  ): Promise<Publication> {
    const original = lease && this.#executions.get(lease);
    if (original && original.epoch !== this.#store.epoch()) return { kind: "identity-changed" };
    const execution = this.#current(lease);
    if (!execution) return { kind: "stale-context" };
    const id = await this.#store.put(execution.agent.id, tool, text, execution.epoch, grant);
    // A turn/preset can change while the real store writes; retained files are not published into it.
    const current = this.#current(lease);
    if (!current) return { kind: "stale-context" };
    const state = current.state;
    const projected = project(id, state.evidence.includes(id));
    state.evidence = [...new Set([...state.evidence, id])].slice(-8);
    state.receipts.set(id, projected.receipt);
    state.returned += projected.text.length;
    return { kind: "published", text: projected.text };
  }
  async readEvidence(
    lease: PromptExecution | undefined,
    agent: Agent,
    id: string,
    offset: number | undefined,
    limit: number | undefined,
    authorize: (grant: EvidenceGrant, tool: string) => Promise<void>,
    render?: (raw: string) => Record<string, unknown>,
    delivered?: {
      viewId: (view: Record<string, unknown>) => string | undefined;
      visible: (viewId: string) => boolean;
      reload?: boolean;
    },
  ): Promise<Record<string, unknown>> {
    let view: Record<string, unknown> | undefined;
    const read = await this.#store.read(
      agent.id,
      id,
      offset,
      limit,
      authorize,
      render &&
        ((raw) => {
          view = render(raw);
          return view;
        }),
    );
    const current = this.#current(lease);
    const execution = current?.agent === agent ? current : undefined;
    if (!delivered || !view) return read;
    const viewId = delivered.viewId(view);
    if (viewId === undefined) return read;
    const key = `${id}:${viewId}`;
    if (!execution) return { ...read, viewId };
    const state = execution.state;
    if (state.evidenceViews.has(key) && delivered.visible(viewId) && !delivered.reload) {
      return {
        evidenceId: id,
        tool: read.tool,
        projection: "already-delivered",
        note: "此视图已完整返回并仍在上下文，直接使用已有业务行。无需重读。",
        evidenceDatasets: view.evidenceDatasets,
        businessFacts: (view as { datasets?: Array<{ businessFacts?: unknown }> }).datasets?.map(
          (dataset) => dataset.businessFacts,
        ),
        nextRead: view.nextRead ?? null,
      };
    }
    state.evidenceViews.set(key, viewId);
    while (state.evidenceViews.size > 32)
      state.evidenceViews.delete(state.evidenceViews.keys().next().value!);
    return { ...read, viewId };
  }
  #identityChanged(): PostToolDecision {
    return {
      kind: "block",
      feedback: [
        {
          type: "text",
          text: "GEA_EVIDENCE_IDENTITY_CHANGED: 身份已改变，旧结果不能作为当前证据。",
        },
      ],
    };
  }
  /** Completes one Core dispatch using the metadata captured before admission. */
  async finish(
    lease: PromptExecution | undefined,
    result: ToolExecutionResult,
    decision: PostToolDecision,
  ): Promise<PostToolDecision> {
    const original = lease && this.#executions.get(lease);
    if (!original?.call) return decision;
    const { agent, call: exec, grant } = original;
    const { ctx } = this.#environment();
    if (this.#current(lease)) {
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
      this.recordOutcome(lease, {
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
              : sessionConsumer(ctx, this.#environment().business, agent.id)
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
    // Check ownership before consulting a retired Agent's Skill/session state.
    if (!this.#current(lease)) {
      if (original.epoch !== this.#store.epoch()) return this.#identityChanged();
      return decision;
    }
    if (exec.name === "forecast_compute" && grant) {
      const { forecastSourceProof } = await import("dsh-agent-manage/forecast-source");
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
    const published = await this.publishEvidence(
      lease,
      exec.name,
      text,
      grant,
      (id, alreadyDelivered) => {
        const projected = alreadyDelivered
          ? JSON.stringify({
              evidenceId: id,
              projection: "reference",
              note: "同一结果已返回，需要正文用 gea_evidence_read 回读。",
            })
          : projectEvidence(text, id, PROMPT_BUDGET.result);
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
    if (published.kind === "identity-changed") return this.#identityChanged();
    if (published.kind === "stale-context") return decision;
    return {
      ...decision,
      content: [{ type: "text" as const, text: published.text }],
    };
  }
  /** Authorizes and projects a retained reference under the current execution. */
  async read(
    lease: PromptExecution | undefined,
    args: EvidenceReadArguments,
  ): Promise<Record<string, unknown>> {
    const execution = lease && this.#executions.get(lease);
    if (!execution?.call) throw Error("SESSION_REQUIRED");
    const { agent } = execution;
    const { signal } = execution.call;
    const { ctx, business } = this.#environment();
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
    const read = await this.readEvidence(
      lease,
      agent,
      args.evidenceId,
      args.offset,
      args.limit,
      async (grant, tool) => {
        if (/^gea_(cube_query|module_mcp)$/.test(tool) && (!grant.consumer || !grant.resources))
          throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
        if (grant.owner !== this.#owner()) throw Error("GEA_EVIDENCE_IDENTITY_CHANGED");
        if (grant.kind === "local" && tool === "forecast_compute") {
          const { FORECAST_VERSION, forecastBaselineHash, hasUserForecastInput } =
            await import("dsh-agent-manage/forecast-source");
          const baseline = await ctx.skills.get("sinian-demand-baseline", {
            scope: agent,
            cwd: agent.session.header.cwd,
            signal: signal,
          });
          signal.throwIfAborted();
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
          } else if (grant.ephemeral !== this.#ephemeral(agent))
            throw Error("GEA_EVIDENCE_STALE: 模型生成输入只能在当前轮次使用。");
        } else if (grant.consumer && grant.resourceTool && grant.resources) {
          if (
            (await this.#resourceProof(grant.consumer, grant.resourceTool, signal, agent.id)) !==
            grant.resources
          )
            throw Error("GEA_EVIDENCE_AUTHORIZATION_CHANGED");
        } else if (grant.kind === "mcp") throw Error("GEA_EVIDENCE_AUTHORIZATION_REQUIRED");
        else if (grant.query && grant.valueHash) {
          // Direct sales reads have no resource-version endpoint. Revalidate the exact query under current row permissions.
          const current = await business.agentQuery(grant.query, signal);
          if (valueHash(current) !== grant.valueHash)
            throw Error("GEA_EVIDENCE_STALE: 数据或权限范围已改变，请取得新的结果。");
        } else if (grant.ephemeral !== this.#ephemeral(agent))
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
            visible: (viewId) => JSON.stringify(agent.session.deriveMessages()).includes(viewId),
            reload: args.reload,
          },
    );
    return read;
  }
}

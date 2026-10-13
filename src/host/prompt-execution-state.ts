import type { Agent } from "@deepseek-ai/dsh-agent";
import { PromptEvidenceStore, type EvidenceGrant } from "./prompt-evidence.ts";

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
  #presetOf: (agent: Agent) => string | undefined;
  #isBusinessPreset: (preset: string) => boolean;
  constructor(
    directory: string,
    presetOf: (agent: Agent) => string | undefined,
    isBusinessPreset: (preset: string) => boolean,
  ) {
    this.#store = new PromptEvidenceStore(directory);
    this.#presetOf = presetOf;
    this.#isBusinessPreset = isBusinessPreset;
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
  begin(agent: Agent, token: symbol): PromptExecution {
    const state = this.#stateOf(agent);
    const lease = {} as PromptExecution;
    this.#executions.set(lease, {
      agent,
      state,
      epoch: this.#store.epoch(),
      catalogGeneration: state.catalogGeneration,
    });
    this.#pending.set(token, lease);
    return lease;
  }
  admitted(lease: PromptExecution | undefined, tool: string): void {
    const execution = this.#current(lease);
    if (!execution) return;
    if (tool === "gea_cube_query") {
      execution.state.catalogStalls = 0;
      execution.state.catalogGeneration++;
    }
    execution.catalogGeneration = execution.state.catalogGeneration;
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
}

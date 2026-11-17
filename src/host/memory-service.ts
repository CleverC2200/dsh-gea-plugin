import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import { brandString } from "@deepseek-ai/dsh-brand";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  memorySessionError,
  sameMemoryScope,
  type MemorySessionLedger,
} from "./memory-session-ledger.ts";
import { resolveMemoryGatewayUrl } from "../shared/memory-gateway.js";
import z from "@deepseek-ai/schemastery";
import type { Business } from "./business.ts";
import {
  memoryStateSchema,
  memoryListSchema,
  memoryGetSchema,
  memoryOperationSchema,
  memoryRecallSchema,
  type MemoryGenerateInput,
  type MemoryScope,
  type MemorySettingsInput,
  type MemoryListInput,
  type MemoryUpdateInput,
  type MemoryDeleteInput,
  type MemoryClearInput,
} from "../shared/memory-contract.ts";

type GatewayOwner = {
  allowPrivateHttp?: boolean;
  identity(): MemoryIdentity;
  expire(identity: MemoryIdentity): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  timeoutMs: number;
};
type MemoryIdentity = {
  token: string;
  scope: MemoryScope;
  signal: AbortSignal;
};
const envelopeSchema = z
  .object({
    success: z.boolean().required(),
    result: z.any<unknown>(),
    errorCode: z.string(),
  })
  .required();
const errors = new Set([
  "MEMORY_UNAUTHENTICATED",
  "MEMORY_FORBIDDEN",
  "MEMORY_IDENTITY_UNAVAILABLE",
  "MEMORY_BACKEND_UNAVAILABLE",
  "MEMORY_INVALID_REQUEST",
  "MEMORY_VERSION_CONFLICT",
  "MEMORY_OPERATION_CONFLICT",
  "MEMORY_NOT_FOUND",
  "MEMORY_NOT_IMPLEMENTED",
  "MEMORY_LIST_LIMIT",
  "MEMORY_MODEL_NOT_CONFIGURED",
  "MEMORY_INVALID_MODEL_RESPONSE",
  "MEMORY_OPERATION_PENDING",
]);

export class PersonalMemoryGateway {
  private readonly base: string | undefined;
  private readonly owner: GatewayOwner;
  constructor(url: string | undefined, owner: GatewayOwner) {
    this.owner = owner;
    this.base = resolveMemoryGatewayUrl(url, owner.allowPrivateHttp);
  }
  state(signal: AbortSignal) {
    return this.request("state", {}, memoryStateSchema, signal);
  }
  list(input: MemoryListInput, signal: AbortSignal) {
    return this.request("list", input, memoryListSchema, signal);
  }
  get(id: string, signal: AbortSignal) {
    return this.request("get", { id }, memoryGetSchema, signal);
  }
  settings(input: MemorySettingsInput, signal: AbortSignal) {
    return this.request("settings", input, memoryOperationSchema, signal);
  }
  recall(query: string, signal: AbortSignal) {
    return this.request("recall", { query }, memoryRecallSchema, signal);
  }
  generate(input: MemoryGenerateInput, signal: AbortSignal) {
    return this.request("generate", input, memoryOperationSchema, signal);
  }
  update(input: MemoryUpdateInput, signal: AbortSignal) {
    return this.request("update", input, memoryOperationSchema, signal);
  }
  delete(input: MemoryDeleteInput, signal: AbortSignal) {
    return this.request("delete", input, memoryOperationSchema, signal);
  }
  clear(input: MemoryClearInput, signal: AbortSignal) {
    return this.request("clear", input, memoryOperationSchema, signal);
  }
  operation(operationId: string, signal: AbortSignal) {
    return this.request("operations", { operationId }, memoryOperationSchema, signal);
  }

  async request<S, T extends { scope: MemoryScope }>(
    endpoint: string,
    body: object,
    schema: z<S, T>,
    caller: AbortSignal,
  ): Promise<T> {
    if (!this.base) throw Error("MEMORY_NOT_CONFIGURED");
    const identity = this.owner.identity();
    const timeout = AbortSignal.timeout(this.owner.timeoutMs);
    const signal = AbortSignal.any([caller, identity.signal, timeout]);
    const active = () => {
      if (caller.aborted || identity.signal.aborted) throw Error("STALE_SELECTION");
      if (timeout.aborted) throw Error("MEMORY_TIMEOUT");
    };
    active();
    try {
      const response = await this.owner.fetch(this.base + "/v1/memory/" + endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Access-Token": identity.token,
          "X-GEA-Environment": identity.scope.environment,
        },
        body: JSON.stringify(body),
      });
      active();
      if (!response.body || Number(response.headers.get("content-length")) > 262144)
        throw Error("MEMORY_INVALID_RESPONSE");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          active();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 262144) {
            void reader.cancel().catch(() => {});
            throw Error("MEMORY_INVALID_RESPONSE");
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const envelope = this.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        envelopeSchema,
      );
      active();
      if (!response.ok || !envelope.success) {
        if (response.status === 401 && envelope.errorCode === "MEMORY_UNAUTHENTICATED")
          this.owner.expire(identity);
        throw Error(
          envelope.errorCode && errors.has(envelope.errorCode)
            ? envelope.errorCode
            : "MEMORY_REQUEST_FAILED",
        );
      }
      const value = this.parse(envelope.result, schema);
      const sameScope = (scope: MemoryScope) =>
        scope.environment === identity.scope.environment &&
        scope.tenantId === identity.scope.tenantId &&
        scope.userId === identity.scope.userId;
      if (
        !sameScope(value.scope) ||
        ("state" in value &&
          value.state &&
          typeof value.state === "object" &&
          "scope" in value.state &&
          JSON.stringify(value.state.scope) !== JSON.stringify(value.scope))
      )
        throw Error("MEMORY_SCOPE_MISMATCH");
      return value;
    } catch (error) {
      active();
      if (error instanceof Error && /^(MEMORY_|STALE_SELECTION)/.test(error.message)) throw error;
      throw Error("MEMORY_GATEWAY_UNAVAILABLE");
    }
  }
  private parse<S, T>(input: unknown, schema: z<S, T>): T {
    try {
      return z.resolve(input, schema, {}, true)[0];
    } catch {
      throw Error("MEMORY_INVALID_RESPONSE");
    }
  }
}

export function createGeaMemoryService(
  business: Business,
  owner: {
    ledger: MemorySessionLedger;
    sessions: Pick<Context["sessionController"], "inspect">;
  },
) {
  async function sessionScope(
    sessionId: string,
    signal: AbortSignal,
    visited = new Set<string>(),
  ): Promise<MemoryScope | undefined> {
    if (visited.has(sessionId)) throw memorySessionError("MEMORY_SESSION_UNVERIFIED");
    visited.add(sessionId);
    const bound = await owner.ledger.scope(sessionId, signal);
    if (bound) return bound;
    const session = await owner.sessions.inspect(brandString<SessionId>(sessionId), signal);
    signal.throwIfAborted();
    let inherited: MemoryScope | undefined;
    if (session.meta.isSeeded) {
      if (!session.meta.parentSession) throw memorySessionError("MEMORY_SESSION_UNVERIFIED");
      try {
        inherited = await sessionScope(session.meta.parentSession, signal, visited);
      } catch {
        signal.throwIfAborted();
        throw memorySessionError("MEMORY_SESSION_UNVERIFIED");
      }
    }
    for (const [index, event] of session.events.entries()) {
      if (event.type !== "user/message") continue;
      const source = event.data.source;
      const kind: string = source.kind;
      const plugin = "plugin" in source ? source.plugin : undefined;
      if (
        kind === "plugin:gea-personal-memory" ||
        kind === "plugin:openviking-memory" ||
        kind === "plugin:viking-memory" ||
        (kind === "plugin" &&
          (plugin === "gea-personal-memory" ||
            plugin === "openviking-memory" ||
            plugin === "viking-memory"))
      ) {
        if (!inherited || index >= session.inheritedEventCount)
          throw memorySessionError("MEMORY_SESSION_UNVERIFIED");
      }
    }
    return inherited;
  }
  async function bindSession(sessionId: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, business.identitySignal()]);
    const state = await business.memory.state(signal);
    const bound = await sessionScope(sessionId, signal);
    if (bound && !sameMemoryScope(bound, state.scope))
      throw memorySessionError("MEMORY_SESSION_SCOPE_MISMATCH");
    signal.throwIfAborted();
    await owner.ledger.bind(sessionId, state.scope, signal);
  }
  async function assertSession(sessionId: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, business.identitySignal()]);
    const bound = await sessionScope(sessionId, signal);
    if (!bound) return;
    let current: MemoryScope;
    try {
      current = business.memoryScope();
    } catch {
      throw memorySessionError("MEMORY_SESSION_SCOPE_MISMATCH");
    }
    if (!sameMemoryScope(current, bound)) throw memorySessionError("MEMORY_SESSION_SCOPE_MISMATCH");
    await owner.ledger.bind(sessionId, bound, signal);
  }
  async function source(id: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, business.identitySignal()]);
    const result = await business.memory.get(id, signal);
    await owner.ledger.assertBound(result.item.source.sessionId, result.scope, signal);
    try {
      const session = await owner.sessions.inspect(
        brandString<SessionId>(result.item.source.sessionId),
        signal,
      );
      signal.throwIfAborted();
      if (
        !session.events.some(
          (event) =>
            event.type === "user/message" && event.data.id === result.item.source.messageId,
        )
      )
        throw Error("MEMORY_SOURCE_UNAVAILABLE");
      return { scope: result.scope, sessionId: result.item.source.sessionId };
    } catch {
      throw Error("MEMORY_SOURCE_UNAVAILABLE");
    }
  }
  return {
    bindSession,
    assertSession,
    source,
    authenticated: () => business.status().authenticated,
    identitySignal: () => business.identitySignal(),
    watch: (listener: () => void) => business.watchIdentity(listener),
    state: (signal: AbortSignal) => business.memory.state(signal),
    list: (input: MemoryListInput, signal: AbortSignal) => business.memory.list(input, signal),
    get: (id: string, signal: AbortSignal) => business.memory.get(id, signal),
    settings: (input: MemorySettingsInput, signal: AbortSignal) =>
      business.memory.settings(input, signal),
    recall: (query: string, signal: AbortSignal) => business.memory.recall(query, signal),
    generate: (input: MemoryGenerateInput, signal: AbortSignal) =>
      business.memory.generate(input, signal),
    update: (input: MemoryUpdateInput, signal: AbortSignal) =>
      business.memory.update(input, signal),
    delete: (input: MemoryDeleteInput, signal: AbortSignal) =>
      business.memory.delete(input, signal),
    clear: (input: MemoryClearInput, signal: AbortSignal) => business.memory.clear(input, signal),
    operation: (id: string, signal: AbortSignal) => business.memory.operation(id, signal),
  };
}
export type GeaMemoryService = ReturnType<typeof createGeaMemoryService>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    geaMemory: GeaMemoryService;
  }
}

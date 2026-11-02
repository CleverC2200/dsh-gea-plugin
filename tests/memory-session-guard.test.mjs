import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { MemorySessionLedger } from "../src/host/memory-session-ledger.ts";
import { fixture, load, alice, bob, message } from "./fixtures/memory-session.mjs";

test("Host refuses to assign an unbound historical memory session to the logged-in account", async (t) => {
  const f = await fixture(t);
  const old = await f.create("historical");
  old.session.append("user/message", message("plugin:gea-personal-memory", "Alice 的记忆"), {
    surfaceOp: "append",
  });
  await assert.rejects(
    f.service().bindSession(old.id, new AbortController().signal),
    /MEMORY_SESSION_UNVERIFIED/,
  );
  assert.equal(await f.ledger.scope(old.id, new AbortController().signal), undefined);
});

test("Host inherits trusted scope across real Core forks and refuses other identities before binding", async (t) => {
  const f = await fixture(t);
  const original = await f.create("owned");
  const signal = new AbortController().signal;
  await f.service().bindSession(original.id, signal);
  original.session.append("user/message", message("plugin:gea-personal-memory", "Alice 的记忆"), {
    surfaceOp: "append",
  });
  const fork = f.ctx.sessions.fork(original.session, undefined, SessionId("owned-fork"));
  f.swap(bob);
  await assert.rejects(f.service().assertSession(fork.id, signal), /MEMORY_SESSION_SCOPE_MISMATCH/);
  assert.equal(await f.ledger.scope(fork.id, signal), undefined);
  f.swap(alice);
  await f.service().assertSession(fork.id, signal);
  assert.deepEqual(await new MemorySessionLedger(f.dir).scope(fork.id, signal), alice);
  f.swap(bob);
  await assert.rejects(
    f.service().assertSession(original.id, signal),
    /MEMORY_SESSION_SCOPE_MISMATCH/,
  );
  const ordinary = await f.create("ordinary");
  await f.service().assertSession(ordinary.id, signal);
  assert.equal(await f.ledger.scope(ordinary.id, signal), undefined);
});

test("the public llm stream stops every provider for a different identity before adapter dispatch", async (t) => {
  const f = await fixture(t);
  const owned = await f.create("stream-owned");
  await f.service().bindSession(owned.id, new AbortController().signal);
  class Adapter extends LlmAdapter {
    calls = [];
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream(options) {
      this.calls.push(options);
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  const adapter = new Adapter();
  f.ctx.llm.registerAdapter(["direct", "alternate"], adapter);
  const { mountMemorySessionGuard } = await import("../src/host/memory-session-guard.ts");
  mountMemorySessionGuard(f.ctx, f.business, f.service());
  const stream = async (provider, sessionId, purpose) => {
    for await (const _ of f.ctx.llm.stream({
      provider,
      model: "fixture",
      messages: [message()],
      signal: new AbortController().signal,
      sessionId,
      purpose,
    })) {
    }
  };
  await stream("direct", owned.id, "conversation");
  f.business.memory.state = async () => {
    throw Error("MEMORY_BACKEND_UNAVAILABLE");
  };
  await stream("direct", owned.id, "conversation");
  for (const scope of [
    bob,
    { ...alice, environment: "test" },
    { ...alice, tenantId: "20" },
    undefined,
  ]) {
    f.swap(scope);
    for (const provider of ["direct", "alternate"]) {
      await assert.rejects(
        stream(provider, owned.id, "conversation"),
        /MEMORY_SESSION_SCOPE_MISMATCH/,
      );
      await assert.rejects(
        stream(provider, owned.id, "compaction"),
        /MEMORY_SESSION_SCOPE_MISMATCH/,
      );
    }
  }
  assert.equal(adapter.calls.length, 2);
  const ordinary = await f.create("unbound-stream");
  await stream("direct", ordinary.id, "conversation");
  assert.equal(adapter.calls.length, 3);
  await writeFile(join(f.dir, "personal-memory-sessions.json"), "broken");
  await assert.rejects(
    stream("direct", owned.id, "conversation"),
    /MEMORY_SESSION_LEDGER_UNAVAILABLE/,
  );
  assert.equal(adapter.calls.length, 3);
});

test(
  "identity changes release old model waits and discard chunks even when a provider ignores abort",
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t);
    const owned = await f.create("waiting-stream");
    await f.service().bindSession(owned.id, new AbortController().signal);
    let started, release;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    class Adapter extends LlmAdapter {
      async resolveModel(provider, model) {
        return { provider, id: model, name: model };
      }
      async *stream() {
        started();
        await gate;
        yield { type: "text-delta", index: 0, text: "old private result" };
      }
    }
    f.ctx.llm.registerAdapter(["direct"], new Adapter());
    const { mountMemorySessionGuard } = await import("../src/host/memory-session-guard.ts");
    mountMemorySessionGuard(f.ctx, f.business, f.service());
    const chunks = [];
    const pending = (async () => {
      for await (const chunk of f.ctx.llm.stream({
        provider: "direct",
        model: "fixture",
        messages: [message()],
        signal: new AbortController().signal,
        sessionId: owned.id,
      }))
        chunks.push(chunk);
    })();
    const rejected = assert.rejects(pending, /MEMORY_IDENTITY_CHANGED/);
    await ready;
    f.swap(bob);
    const fast = await Promise.race([
      rejected.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    release();
    assert.equal(fast, true, "a provider that ignores abort must not keep the old caller waiting");
    await rejected;
    assert.deepEqual(chunks, []);
  },
);

test("legacy memory, missing parent and cyclic lineage cannot acquire current scope", async (t) => {
  const f = await fixture(t);
  const signal = new AbortController().signal;
  const old = await f.create("legacy");
  old.session.append("user/message", message("plugin:openviking-memory"), {
    surfaceOp: "append",
  });
  await assert.rejects(f.service().bindSession(old.id, signal), /MEMORY_SESSION_UNVERIFIED/);
  const fork = (id, parentSession) =>
    f.ctx.sessions.create(SessionId(id), {
      seed: [],
      inheritedEventCount: 0,
      meta: { isSeeded: true, parentSession: SessionId(parentSession) },
    });
  fork("missing-child", "absent");
  await assert.rejects(
    f.service().bindSession("missing-child", signal),
    /MEMORY_SESSION_UNVERIFIED/,
  );
  fork("cycle-a", "cycle-b");
  fork("cycle-b", "cycle-a");
  await assert.rejects(f.service().bindSession("cycle-a", signal), /MEMORY_SESSION_UNVERIFIED/);
});

test("manual and automatic Core compaction are guarded and the durable binding survives a summary", async (t) => {
  const f = await fixture(t);
  const [{ default: TokenMeter }, { BasicCompactionEngine }] = await Promise.all([
    load("packages/llm/token-meter"),
    load("packages/compaction/compaction-basic"),
  ]);
  await f.ctx.plugin(TokenMeter);
  class Adapter extends LlmAdapter {
    calls = [];
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 100000 },
      };
    }
    async *stream(options) {
      this.calls.push(options);
      yield { type: "block-start", index: 0, blockType: "text" };
      yield {
        type: "block-end",
        index: 0,
        block: { type: "text", text: "summary" },
      };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  const adapter = new Adapter();
  f.ctx.llm.registerAdapter(["direct", "summary"], adapter);
  const { mountMemorySessionGuard } = await import("../src/host/memory-session-guard.ts");
  mountMemorySessionGuard(f.ctx, f.business, f.service());
  const compact = new BasicCompactionEngine(f.ctx, {
    auto: false,
    summarizationProvider: "summary",
    summarizationModel: "fixture",
  });
  const agent = await f.create("compaction-guard");
  const signal = new AbortController().signal;
  await f.service().bindSession(agent.id, signal);
  agent.session.append("user/message", message("plugin:gea-personal-memory", "Alice 的记忆"), {
    surfaceOp: "append",
  });
  agent.followup(message("user", "old personal context ".repeat(100)));
  await agent.whenIdle();
  assert.equal(adapter.calls.length, 1);
  f.swap(bob);
  await assert.rejects(compact.compactNow(agent, signal), (error) =>
    /MEMORY_SESSION_SCOPE_MISMATCH/.test(String(error.cause)),
  );
  assert.equal(adapter.calls.length, 1, "manual summary must not reach the adapter");
  f.swap(alice);
  assert.ok(await compact.compactNow(agent, signal));
  assert.equal(adapter.calls[1].purpose, "compaction");
  assert.deepEqual(await new MemorySessionLedger(f.dir).scope(agent.id, signal), alice);
  assert.equal(
    agent.session
      .deriveMessages()
      .some((message) => message.source.kind === "plugin:gea-personal-memory"),
    false,
  );
  f.swap(bob);
  agent.followup(message());
  await agent.whenIdle();
  assert.equal(
    adapter.calls.length,
    2,
    "a compacted surface still belongs to its original memory scope",
  );
  await rm(join(f.dir, "personal-memory-sessions.json"));
  f.swap(alice);
  await assert.rejects(f.service().bindSession(agent.id, signal), /MEMORY_SESSION_UNVERIFIED/);
  const auto = await fixture(t);
  await auto.ctx.plugin(TokenMeter);
  const autoAdapter = new Adapter();
  auto.ctx.llm.registerAdapter(["direct", "summary"], autoAdapter);
  mountMemorySessionGuard(auto.ctx, auto.business, auto.service());
  const autoAgent = await auto.create("pressure-guard");
  await auto.service().bindSession(autoAgent.id, signal);
  autoAgent.followup(message("user", "old private context ".repeat(100)));
  await autoAgent.whenIdle();
  auto.swap(bob);
  let attempts = 0;
  auto.ctx.on(
    "llm/stream",
    async function* (options, next) {
      if (options.purpose === "compaction") attempts++;
      yield* next();
    },
    { prepend: true },
  );
  new BasicCompactionEngine(auto.ctx, {
    thresholdRatio: 0.00001,
    retainTokens: 0,
    headroomTokens: 0,
    maxTokens: 32,
    summarizationProvider: "summary",
    summarizationModel: "fixture",
  });
  autoAgent.followup(message());
  await autoAgent.whenIdle();
  assert.ok(
    attempts > 0,
    "the real automatic pressure hook attempted a summary before the conversation",
  );
  assert.equal(
    autoAdapter.calls.length,
    1,
    "automatic pressure compaction and the following conversation are both denied",
  );
});

test("restoring a real persisted Core session preserves local history and its Host ledger restriction", async (t) => {
  const f = await fixture(t, { persist: true });
  const id = SessionId("restored-memory-session");
  const handle = await f.ctx.agentLoop.createAgent(f.ctx, {
    sessionId: id,
    agentOptions: { provider: "direct", model: "fixture" },
    meta: { cwd: f.dir },
  });
  const signal = new AbortController().signal;
  await f.service().bindSession(id, signal);
  handle.agent.session.append(
    "user/message",
    message("plugin:gea-personal-memory", "Alice 的旧记忆"),
    { surfaceOp: "append" },
  );
  await f.ctx.sessions.flush(handle.agent.session);
  await handle.dispose();
  assert.equal(f.ctx.sessions.get(id), undefined);
  f.swap(bob);
  const local = await f.controller.inspect(id, signal);
  assert.ok(local.events.some((event) => event.type === "user/message"));
  await assert.rejects(f.service().bindSession(id, signal), /MEMORY_SESSION_SCOPE_MISMATCH/);
  const resumed = await f.ctx.agentLoop.resume(f.ctx, {
    resumeSessionId: id,
    agentOptions: { provider: "direct", model: "fixture" },
  });
  const { mountMemorySessionGuard } = await import("../src/host/memory-session-guard.ts");
  mountMemorySessionGuard(f.ctx, f.business, f.service());
  let calls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model };
    }
    async *stream() {
      calls++;
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  f.ctx.llm.registerAdapter(["direct"], new Adapter());
  resumed.agent.followup(message());
  await resumed.agent.whenIdle();
  assert.equal(calls, 0);
  f.swap(alice);
  resumed.agent.followup(message());
  await resumed.agent.whenIdle();
  assert.equal(calls, 1);
  await resumed.dispose();
});

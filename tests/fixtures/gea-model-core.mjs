import { afterEach, onTestFinished, expect, it, vi } from "vitest";
import {
  presetHarness,
  official,
  agentOn,
  history,
  turn,
} from "../../../dsh-agent-manage/tests/core-preset-harness.js";
import { GeaModelAdapter } from "../../src/host/gea-model.ts";
import { Business } from "../../src/host/business.ts";
const event = (delta, finish_reason = null) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
const answer = (text) =>
  new Response(event({ content: text }, "stop") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
afterEach(() => vi.unstubAllGlobals());
async function model(treatment, capacity = 1000000, htmlAccess, metadata) {
  const f = await presetHarness();
  await f.ctx.plugin(await official("@deepseek-ai/dsh-llm-retry"));
  const business = new Business({
    geaBaseUrl: "https://fixture.invalid/gea-boot",
    analysisAgentCode: "sales_forecast",
    workbenchCapability: { enabled: true },
    requestTimeoutMs: 1e3,
    modelRequestTimeoutMs: 1e3,
    maxSnapshotBytes: 1e5,
    runtimeDir: f.home,
  });
  onTestFinished(() => business.dispose());
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: business.base,
    auth: {
      token: "fixture-login",
      tenantId: "0",
      id: "fixture-user",
      name: "Fixture",
      username: "fixture",
    },
  });
  vi.stubGlobal("fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("/my/list"))
      return Response.json({
        success: true,
        result: { records: [{ id: "credential", status: "ACTIVE" }] },
      });
    if (url.includes("/my/claim"))
      return Response.json({
        success: true,
        result: {
          credentialId: "credential",
          status: "ACTIVE",
          baseUrl: "https://model.invalid",
          secret: "fixture-secret",
        },
      });
    if (url.endsWith("/models"))
      return Response.json({
        data: [
          {
            id: "test",
            name: "Fixture",
            ...(capacity === null ? {} : { contextWindow: capacity }),
          },
        ],
      });
    if (url.includes("/airag/airagModel/queryById"))
      return typeof metadata === "function"
        ? metadata()
        : metadata
          ? Response.json({ success: true, result: metadata })
          : Response.json({ success: false }, { status: 403 });
    if (url.endsWith("/chat/completions")) return treatment(JSON.parse(String(init?.body)), init);
    throw new Error("Unexpected fixture request: " + url);
  });
  const adapter = new GeaModelAdapter(business, htmlAccess);
  const { resolveRetryPolicy } = await official("@deepseek-ai/dsh-llm");
  const policy = adapter.providerRetryPolicy("local") ?? resolveRetryPolicy(undefined, "fixture");
  vi.spyOn(adapter, "providerRetryPolicy").mockReturnValue({
    ...policy,
    initialDelayMs: 1,
    maxDelayMs: 100,
    jitterRatio: 0,
  });
  f.ctx.llm.registerAdapter(["local"], adapter);
  await f.ctx.llm.resolveModelInfo("local", "test");
  return { ...f, adapter, business };
}
it.each(["http", "dns", "partial"])(
  "a transient %s summary failure recovers before sending the old conversation",
  async (failure) => {
    let summaries = 0;
    let business = 0;
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    onTestFinished(() => logs.mockRestore());
    const f = await model((body) => {
      if (JSON.stringify(body.messages).includes("acting as a compaction engine")) {
        if (++summaries === 1) {
          if (failure === "dns")
            throw Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("fixture DNS"), { code: "ENOTFOUND" }),
            });
          if (failure === "partial")
            return new Response(
              event({ content: "INCOMPLETE SUMMARY MUST BE DISCARDED" }) +
                "data: " +
                JSON.stringify({
                  error: { code: "MODEL_UPSTREAM_UNAVAILABLE", type: "server_error" },
                }) +
                "\n\n",
              { headers: { "Content-Type": "text/event-stream" } },
            );
          return Response.json({ error: { code: "MODEL_UPSTREAM_UNAVAILABLE" } }, { status: 503 });
        }
        return answer("CHECKPOINT: original task survived summary retry");
      }
      business++;
      if (
        !JSON.stringify(body.messages).includes("CHECKPOINT: original task survived summary retry")
      )
        return Response.json({ error: { code: "MODEL_UPSTREAM_REJECTED" } }, { status: 502 });
      expect(JSON.stringify(body.messages)).not.toContain("INCOMPLETE SUMMARY MUST BE DISCARDED");
      return answer("continued");
    });
    const { Session, SessionId } = await official("@deepseek-ai/dsh-session");
    const seed = Session.create(SessionId("summary-recovery-seed"), await history(20000));
    seed.append("request/header", {
      header: { config: { provider: "local", model: "test" } },
      reason: "initial",
    });
    const agent = await agentOn(
      f.ctx,
      "summary-recovery-" + failure,
      "auto-negotiation",
      seed.snapshotEvents(),
    );
    await turn(f.ctx, agent, "continue old task");
    expect(agent.session.snapshotEvents().at(-1).data.reason.kind).toBe("completed");
    expect(summaries).toBe(2);
    expect(business).toBe(1);
    expect(
      agent.session.snapshotEvents().filter((row) => row.type === "compaction/summary"),
    ).toHaveLength(1);
    expect(
      logs.mock.calls
        .map((row) => JSON.parse(row[0]))
        .filter((row) => row.event === "GEA_MODEL_RETRY"),
    ).toHaveLength(1);
  },
);
it.each([
  [503, undefined, 3],
  [403, undefined, 1],
  [429, "60", 1],
])(
  "summary retries are bounded for HTTP %s / Retry-After %s",
  async (status, retryAfter, attempts) => {
    let requests = 0;
    const f = await model(() => {
      requests++;
      return Response.json(
        { error: { code: status === 403 ? "permission_denied" : "MODEL_UPSTREAM_UNAVAILABLE" } },
        {
          status,
          headers: retryAfter ? { "Retry-After": retryAfter } : {},
        },
      );
    });
    const chunks = [];
    await expect(async () => {
      for await (const chunk of f.adapter.stream({
        provider: "local",
        model: "test",
        messages: [],
        purpose: "compaction",
      }))
        chunks.push(chunk);
    }).rejects.toThrow();
    expect(requests).toBe(attempts);
    expect(chunks).toEqual([]);
  },
);
it.each(["cancel", "login", "source"])(
  "summary retry stops after %s and permits a new explicit request",
  async (change) => {
    let source = new AbortController();
    const caller = new AbortController();
    let requests = 0;
    let online = false;
    const f = await model(
      () => {
        requests++;
        return online
          ? answer("new explicit summary")
          : Response.json({ error: { code: "MODEL_UPSTREAM_UNAVAILABLE" } }, { status: 503 });
      },
      1000000,
      async () => ({ consumerCode: "workbench", signal: source.signal }),
    );
    const logs = vi.spyOn(console, "info").mockImplementation((line) => {
      if (JSON.parse(line).event !== "GEA_MODEL_RETRY") return;
      if (change === "cancel") caller.abort(new DOMException("fixture stop", "AbortError"));
      else if (change === "source") {
        source.abort(new DOMException("fixture source retired", "AbortError"));
        source = new AbortController();
      } else
        f.business.restoreDesktopLogin({
          schema: 1,
          environment: "production",
          base: f.business.base,
          auth: {
            token: "new-login",
            tenantId: "0",
            id: "new-user",
            name: "Fixture",
            username: "fixture",
          },
        });
    });
    onTestFinished(() => logs.mockRestore());
    await expect(async () => {
      for await (const _chunk of f.adapter.stream({
        provider: "local",
        model: "test",
        messages: [],
        purpose: "compaction",
        signal: caller.signal,
      })) {
      }
    }).rejects.toThrow();
    expect(requests).toBe(1);
    online = true;
    const chunks = [];
    for await (const chunk of f.adapter.stream({
      provider: "local",
      model: "test",
      messages: [],
      purpose: "compaction",
      signal: new AbortController().signal,
    }))
      chunks.push(chunk);
    expect(requests).toBe(2);
    expect(
      chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "new explicit summary"),
    ).toBe(true);
  },
);
it.each(["catalog", "official-metadata", "recovered-metadata"])(
  "oversized old session with %s capacity compacts before its first business request",
  async (source) => {
    const order = [];
    let metadataReads = 0;
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(() => vi.restoreAllMocks());
    const f = await model(
      (body) => {
        if (JSON.stringify(body.messages).includes("acting as a compaction engine")) {
          order.push("summary");
          return answer("CHECKPOINT: original oversized task");
        }
        order.push("model");
        expect(JSON.stringify(body.messages)).toContain("CHECKPOINT: original oversized task");
        return answer("continued after pre-step compaction");
      },
      source === "catalog" ? 1000000 : null,
      undefined,
      () => {
        if (++metadataReads === 1 && source === "recovered-metadata")
          return Response.json({ success: false }, { status: 503 });
        return Response.json({
          success: true,
          result: {
            id: "test",
            provider: "DEEPSEEK",
            modelName: "deepseek-flash",
            baseUrl: "https://api.deepseek.com/v1",
          },
        });
      },
    );
    now += 30001;
    const { Session, SessionId } = await official("@deepseek-ai/dsh-session");
    const seed = Session.create(SessionId("oversized-old-seed"), await history(20000));
    seed.append("request/header", {
      header: { config: { provider: "local", model: "test" } },
      reason: "initial",
    });
    const agent = await agentOn(
      f.ctx,
      "gea-old-pre-step",
      "auto-negotiation",
      seed.snapshotEvents(),
    );
    await turn(f.ctx, agent, "continue old task");
    expect(
      agent.session
        .snapshotEvents()
        .filter((row) => row.type === "turn/end")
        .at(-1).data.reason.kind,
    ).toBe("completed");
    expect(order).toEqual(["summary", "model"]);
    const events = agent.session.snapshotEvents();
    expect(events.filter((row) => row.type === "compaction/summary")).toHaveLength(1);
    expect((await f.ctx.llm.resolveModelInfo("local", "test")).context.contextWindow).toBe(1000000);
    expect(metadataReads).toBe(source === "catalog" ? 0 : source === "recovered-metadata" ? 2 : 1);
  },
);
it.each(["catalog", "official-metadata"])(
  "real Core Session compacts %s capacity pressure before continuing with its checkpoint",
  async (source) => {
    const requests = [];
    const f = await model(
      (body) => {
        requests.push(body);
        if (JSON.stringify(body.messages).includes("acting as a compaction engine"))
          return answer("CHECKPOINT: preserve original task");
        if (requests.length === 1)
          return new Response(
            event(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "pressure-step",
                    type: "function",
                    function: { name: "todo_write", arguments: '{"todos":[]}' },
                  },
                ],
              },
              "tool_calls",
            ) + "data: [DONE]\n\n",
            { headers: { "Content-Type": "text/event-stream" } },
          );
        return answer("continued");
      },
      source === "catalog" ? 1000000 : null,
      undefined,
      source === "catalog"
        ? undefined
        : {
            id: "test",
            provider: "DEEPSEEK",
            baseUrl: "https://api.deepseek.com/v1",
            modelName: "deepseek-flash",
          },
    );
    const agent = await agentOn(f.ctx, "gea-pressure", "auto-negotiation", await history(13000));
    await turn(f.ctx, agent, "Continue original task");
    expect(
      agent.session.snapshotEvents().map((row) => row.type),
      JSON.stringify(
        agent.session
          .snapshotEvents()
          .filter((row) => row.type === "turn/end" || row.type === "assistant/attempt"),
      ) +
        " requests=" +
        requests.length,
    ).toContain("compaction/summary");
    expect(agent.session.requestContext()).toMatchObject({
      contextWindow: 1000000,
    });
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain(
      "CHECKPOINT: preserve original task",
    );
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: { kind: "completed" } },
    });
  },
);
it.each(["catalog", "official-metadata"])(
  "GEA %s capacity lets auto-negotiation prune an oversized tool result before continuing",
  async (source) => {
    const requests = [];
    const f = await model(
      (body) => {
        requests.push(body);
        return answer("continued after pruning");
      },
      source === "catalog" ? 1000000 : null,
      undefined,
      source === "catalog"
        ? undefined
        : {
            id: "test",
            provider: "DEEPSEEK",
            baseUrl: "https://api.deepseek.com/v1",
            modelName: "deepseek-flash",
          },
    );
    const { Session, SessionId } = await official("@deepseek-ai/dsh-session");
    const { createToolResultMessage, createMessage, ToolCallId } =
      await official("@deepseek-ai/dsh-llm");
    const seed = Session.create(SessionId("inventory-seed"), await history(20));
    const callId = ToolCallId("oversized-inventory");
    seed.append("turn/start", { turn: 4 });
    seed.append("step/start", { turn: 4, step: 1 });
    seed.append("request/header", {
      header: { config: { provider: "local", model: "test" } },
      reason: "initial",
    });
    seed.append(
      "assistant/message",
      {
        turn: 4,
        step: 1,
        stream: [],
        message: createMessage({
          role: "assistant",
          content: [{ type: "tool-call", id: callId, name: "read", arguments: "{}" }],
          source: { kind: "model", provider: "local", model: "test" },
        }),
      },
      { surfaceOp: "append" },
    );
    seed.append("tool/call", {
      turn: 4,
      step: 1,
      callId,
      name: "read",
      arguments: "{}",
    });
    const original = "INVENTORY HEAD " + "inventory-detail ".repeat(240000) + " INVENTORY TAIL";
    seed.append(
      "tool/result",
      {
        turn: 4,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: "text", text: original }],
          isError: false,
        }),
      },
      { surfaceOp: "append" },
    );
    seed.append("step/end", { turn: 4, step: 1 });
    seed.append("turn/end", { turn: 4, reason: { kind: "completed" } });
    const agent = await agentOn(f.ctx, "gea-prune", "auto-negotiation", seed.snapshotEvents());
    await turn(f.ctx, agent, "Continue inventory analysis");
    const events = agent.session.snapshotEvents();
    expect(agent.session.requestContext()).toMatchObject({
      contextWindow: 1000000,
    });
    expect(events.some((row) => row.type === "compaction/prune")).toBe(true);
    expect(events.some((row) => row.type === "compaction/summary")).toBe(false);
    const output = requests.at(-1).messages.find((row) => row.role === "tool").content;
    expect(output).toContain("INVENTORY HEAD");
    expect(output).toContain("INVENTORY TAIL");
    expect(output).toContain("tool result middle pruned");
    expect(output.length).toBeLessThan(8192);
    expect(events.filter((row) => row.type === "tool/result")[0].data.message.content[0].text).toBe(
      original,
    );
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: { kind: "completed" } },
    });
    if (source === "official-metadata") {
      const { DEFAULT_CONTEXT_WINDOW } = await official(
        "@deepseek-ai/dsh-llm-deepseek/src/defaults.ts",
      );
      expect(agent.session.requestContext().contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    }
  },
);
it("real Core Session recovers once from HTTP context overflow using a replacement checkpoint", async () => {
  const conversation = [];
  const summaries = [];
  const f = await model((body) => {
    if (JSON.stringify(body.messages).includes("acting as a compaction engine")) {
      summaries.push(body);
      return answer("RECOVERY CHECKPOINT");
    }
    conversation.push(body);
    return conversation.length === 1
      ? Response.json(
          {
            error: {
              code: "context_length_exceeded",
              message: "maximum context length",
            },
          },
          { status: 400 },
        )
      : answer("recovered");
  });
  const agent = await agentOn(f.ctx, "gea-overflow", "standard", await history(20));
  await turn(f.ctx, agent, "Continue original task");
  expect(conversation).toHaveLength(2);
  expect(summaries).toHaveLength(1);
  expect(JSON.stringify(conversation[1].messages)).toContain("RECOVERY CHECKPOINT");
  expect(
    agent.session
      .snapshotEvents()
      .filter((row) => row.type.startsWith("compaction/"))
      .map((row) => row.type),
  ).toEqual(["compaction/start", "compaction/summary", "compaction/end"]);
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
});
it("real Core retains max-tokens reasoning and text while dispatching neither complete nor truncated tools", async () => {
  const f = await model(
    () =>
      new Response(
        event(
          {
            reasoning_content: "partial reasoning",
            content: "partial answer",
            tool_calls: [
              {
                index: 0,
                id: "complete",
                type: "function",
                function: { name: "todo_write", arguments: '{"todos":[]}' },
              },
              {
                index: 1,
                id: "partial",
                type: "function",
                function: { name: "todo_write", arguments: '{"todos":[' },
              },
            ],
          },
          "length",
        ) + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const agent = await agentOn(f.ctx, "gea-length", "standard");
  await turn(f.ctx, agent, "Continue original task");
  const events = agent.session.snapshotEvents();
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "max-tokens" } },
  });
  expect(events.filter((row) => row.type === "tool/call")).toHaveLength(0);
  const message = events.find((row) => row.type === "assistant/message");
  expect(message?.data.message.content).toEqual(
    expect.arrayContaining([
      { type: "reasoning", text: "partial reasoning" },
      { type: "text", text: "partial answer" },
    ]),
  );
  expect(message?.data.message.source?.replayState).toBeUndefined();
});
it("real Core saves a reasoning-only stop as a completed ordinary generation", async () => {
  const f = await model(
    () =>
      new Response(
        event({ reasoning_content: "reasoning without answer" }, "stop") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  );
  const agent = await agentOn(f.ctx, "gea-thinking", "standard");
  await turn(f.ctx, agent, "Think through the task");
  const events = agent.session.snapshotEvents();
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
  expect(
    events.find((row) => row.type === "assistant/message")?.data.message.content,
  ).toContainEqual({ type: "reasoning", text: "reasoning without answer" });
});
it("Core applies its single overflow recovery budget to repeated SSE rejections", async () => {
  const conversation = [];
  const summaries = [];
  const f = await model((body) => {
    if (JSON.stringify(body.messages).includes("acting as a compaction engine")) {
      summaries.push(body);
      return answer("RECOVERY CHECKPOINT");
    }
    conversation.push(body);
    return new Response(
      'data: {"error":{"code":"context_length_exceeded","message":"maximum context length"}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const agent = await agentOn(f.ctx, "gea-overflow-budget", "standard", await history(20));
  await turn(f.ctx, agent, "Continue original task");
  expect(conversation).toHaveLength(2);
  expect(summaries).toHaveLength(1);
  expect(JSON.stringify(conversation[1].messages)).toContain("RECOVERY CHECKPOINT");
  expect(
    JSON.stringify(
      agent.session.snapshotEvents().filter((row) => row.type === "assistant/attempt"),
    ),
  ).toContain("CONTEXT_WINDOW_EXCEEDED");
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "error" } },
  });
});
it.each([
  [401, 1],
  [429, 3],
  [503, 3],
])("Core bounds HTTP %s recovery to %s attempts without compaction", async (status, attempts) => {
  const requests = [];
  const f = await model((body) => {
    requests.push(body);
    return Response.json(
      { error: { code: "upstream_error", message: "request failed" } },
      { status },
    );
  });
  const agent = await agentOn(f.ctx, "gea-http-" + status, "standard", await history(20));
  await turn(f.ctx, agent, "Continue original task");
  expect(requests).toHaveLength(attempts);
  expect(
    agent.session.snapshotEvents().filter((row) => row.type.startsWith("compaction/")),
  ).toHaveLength(0);
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "error" } },
  });
});
it("Core executes a valid tool call larger than the snapshot budget and then continues", async () => {
  let requests = 0;
  const content = "\u4E2D".repeat(4e4);
  const f = await model(() =>
    ++requests === 1
      ? new Response(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "large-todo",
                  type: "function",
                  function: {
                    name: "todo_write",
                    arguments: JSON.stringify({
                      todos: [{ content, status: "in_progress" }],
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ) + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        )
      : answer("continued"),
  );
  const agent = await agentOn(f.ctx, "gea-large-tool", "standard");
  await turn(f.ctx, agent, "Record the task");
  expect(
    agent.session.snapshotEvents().find((row) => row.type === "todo/write")?.data.todos[0].content,
  ).toBe(content);
  expect(requests).toBe(2);
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
});
it("cancelling Core during overflow compaction closes the summary stream without retrying", async () => {
  const entered = Promise.withResolvers();
  let conversationRequests = 0;
  let cancelled = 0;
  const f = await model((body) => {
    if (JSON.stringify(body.messages).includes("acting as a compaction engine"))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event({ content: "partial checkpoint" })));
            entered.resolve();
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    conversationRequests++;
    return Response.json({ error: { code: "context_length_exceeded" } }, { status: 400 });
  });
  const agent = await agentOn(f.ctx, "gea-cancel-recovery", "standard", await history(20));
  const running = turn(f.ctx, agent, "Continue original task");
  await entered.promise;
  agent.cancel({ kind: "user" });
  await running;
  expect(conversationRequests).toBe(1);
  expect(cancelled).toBe(1);
  expect(
    agent.session.snapshotEvents().filter((row) => row.type === "compaction/summary"),
  ).toHaveLength(0);
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "aborted" } },
  });
});

it.each([
  [503, "MODEL_UPSTREAM_UNAVAILABLE", "SERVER"],
  [504, "MODEL_UPSTREAM_TIMEOUT", "TIMEOUT"],
  [429, "MODEL_UPSTREAM_RATE_LIMITED", "RATE_LIMIT"],
  [200, "MODEL_UPSTREAM_UNAVAILABLE", "SERVER"],
  [200, "MODEL_UPSTREAM_TIMEOUT", "TIMEOUT"],
  [200, "MODEL_UPSTREAM_RATE_LIMITED", "RATE_LIMIT"],
])(
  "Core recovers from HTTP %s / %s without rerunning a completed tool",
  async (status, code, expected) => {
    const requests = [];
    const headers = [];
    const f = await model((body, init) => {
      requests.push(body);
      headers.push(new Headers(init.headers));
      if (requests.length === 1)
        return new Response(
          event(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "done-tool",
                  type: "function",
                  function: { name: "todo_write", arguments: '{"todos":[]}' },
                },
              ],
            },
            "tool_calls",
          ) + "data: [DONE]\n\n",
          { headers: { "Content-Type": "text/event-stream" } },
        );
      if (requests.length === 2) {
        const error = {
          code,
          type: "server_error",
          message: "private-model-error",
        };
        const correlation = {
          "X-Request-Id": "server-retry-request",
          "X-Trace-Id": "server-retry-trace",
        };
        return status === 200
          ? new Response(
              event({ content: "discard this failed attempt" }) +
                `data: ${JSON.stringify({ error })}\n\ndata: [DONE]\n\n`,
              {
                headers: {
                  ...correlation,
                  "Content-Type": "text/event-stream",
                },
              },
            )
          : Response.json({ error }, { status, headers: correlation });
      }
      return answer("recovered");
    });
    const agent = await agentOn(f.ctx, `recover-${status}-${code}`, "standard", await history(2));
    await turn(f.ctx, agent, "Continue original task");
    const events = agent.session.snapshotEvents();
    const retries = events.filter((row) => row.type === "llm/retry");
    expect(requests).toHaveLength(3);
    expect(requests[2].messages).toEqual(requests[1].messages);
    expect(retries).toHaveLength(1);
    expect(retries[0].data.failure).toMatchObject({
      code: expected,
      requestId: "server-retry-request",
      status,
    });
    expect(retries[0].data.failure.message).toContain("server-retry-trace");
    expect(headers.every((value) => value.get("X-Request-Id") && value.get("X-Trace-Id"))).toBe(
      true,
    );
    expect(new Set(headers.map((value) => value.get("X-Request-Id"))).size).toBe(3);
    expect(events.filter((row) => row.type === "tool/call")).toHaveLength(1);
    expect(events.filter((row) => row.type === "todo/write")).toHaveLength(1);
    expect(JSON.stringify(agent.session.deriveMessages())).not.toContain(
      "discard this failed attempt",
    );
    expect(events.at(-1).data.reason.kind).toBe("completed");
  },
);

it.each([502, 200])(
  "Core never retries an upstream rejection carried by HTTP %s",
  async (status) => {
    let requests = 0;
    const f = await model(() => {
      requests++;
      const error = {
        code: "MODEL_UPSTREAM_REJECTED",
        type: "server_error",
        message: "上游模型拒绝请求",
      };
      return status === 200
        ? new Response(`data: ${JSON.stringify({ error })}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          })
        : Response.json({ error }, { status });
    });
    const agent = await agentOn(f.ctx, `reject-${status}`, "standard", await history(2));
    await turn(f.ctx, agent, "Continue");
    expect(requests).toBe(1);
    expect(agent.session.snapshotEvents().filter((row) => row.type === "llm/retry")).toHaveLength(
      0,
    );
    expect(agent.session.snapshotEvents().at(-1).data.reason.kind).toBe("error");
  },
);

it("Core recognizes an explicit overflow code even with the gateway's generic server_error type", async () => {
  let calls = 0;
  const f = await model((body) => {
    if (JSON.stringify(body.messages).includes("acting as a compaction engine"))
      return answer("EXPLICIT OVERFLOW CHECKPOINT");
    if (++calls === 1)
      return new Response(
        'data: {"error":{"code":"context_length_exceeded","type":"server_error","message":"private error"}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    return answer("recovered from explicit overflow");
  });
  const agent = await agentOn(f.ctx, "explicit-overflow", "standard", await history(20));
  await turn(f.ctx, agent, "Continue");
  const events = agent.session.snapshotEvents();
  expect(calls).toBe(2);
  expect(events.filter((row) => row.type === "compaction/summary")).toHaveLength(1);
  expect(events.at(-1).data.reason.kind).toBe("completed");
});

it("cancellation during GEA retry backoff never sends another request", async () => {
  let requests = 0;
  const f = await model(() => {
    requests++;
    return Response.json({ error: { code: "MODEL_UPSTREAM_UNAVAILABLE" } }, { status: 503 });
  });
  const agent = await agentOn(f.ctx, "cancel-gea-retry", "standard");
  f.ctx.on("session/event", (session, event) => {
    if (session === agent.session && event.type === "llm/retry") agent.cancel({ kind: "user" });
  });
  await turn(f.ctx, agent, "Continue");
  expect(requests).toBe(1);
  expect(agent.session.snapshotEvents().filter((row) => row.type === "llm/retry")).toHaveLength(1);
  expect(agent.session.snapshotEvents().at(-1).data.reason.kind).toBe("aborted");
});

it.each([
  ["ENOTFOUND", "TRANSPORT"],
  ["UND_ERR_CONNECT_TIMEOUT", "TIMEOUT"],
  ["aggregate", "TRANSPORT"],
])("Core retries a known %s transport failure", async (code, expected) => {
  let requests = 0;
  const f = await model(() => {
    if (++requests === 1)
      throw Object.assign(new TypeError("fetch failed"), {
        cause:
          code === "aggregate"
            ? new AggregateError([
                Object.assign(new Error("v4"), { code: "ECONNREFUSED" }),
                Object.assign(new Error("v6"), { code: "ENETUNREACH" }),
              ])
            : Object.assign(new Error("fixture transport"), { code }),
      });
    return answer("recovered transport");
  });
  const agent = await agentOn(f.ctx, `transport-${code}`, "standard");
  await turn(f.ctx, agent, "Continue");
  expect(requests).toBe(2);
  const retries = agent.session.snapshotEvents().filter((row) => row.type === "llm/retry");
  expect(retries).toHaveLength(1);
  expect(retries[0].data.failure.code).toBe(expected);
  expect(agent.session.snapshotEvents().at(-1).data.reason.kind).toBe("completed");
});

it("model failures retain safe response correlation and Retry-After metadata", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  onTestFinished(() => logs.mockRestore());
  const f = await model(() =>
    Response.json(
      {
        error: {
          code: "MODEL_UPSTREAM_RATE_LIMITED",
          requestId: "body-request",
          traceId: "body-trace",
        },
      },
      {
        status: 429,
        headers: {
          "X-Request-Id": "header-request",
          "X-Trace-Id": "header-trace",
          "Retry-After": "0.05",
        },
      },
    ),
  );
  let error;
  try {
    for await (const _chunk of f.adapter.stream({
      provider: "local",
      model: "test",
      messages: [],
    })) {
    }
  } catch (caught) {
    error = caught;
  }
  expect(error.failure).toMatchObject({
    code: "RATE_LIMIT",
    status: 429,
    requestId: "header-request",
    providerRetryAfterMs: 50,
  });
  expect(error.message).toContain("header-trace");
  const log = logs.mock.calls
    .map((row) => JSON.parse(row[0]))
    .find((row) => row.event === "GEA_MODEL_FAILURE");
  expect(log).toMatchObject({
    serverRequestId: "header-request",
    traceId: "header-trace",
    upstreamCode: "MODEL_UPSTREAM_RATE_LIMITED",
    geaCode: "GEA_MODEL_HTTP_429",
  });
});

it("an identity change during backoff cannot retry an old turn under the new login", async () => {
  let requests = 0;
  const f = await model(() =>
    ++requests === 1
      ? Response.json({ error: { code: "MODEL_UPSTREAM_UNAVAILABLE" } }, { status: 503 })
      : answer("new login explicitly continued"),
  );
  const agent = await agentOn(f.ctx, "identity-backoff", "standard");
  const stop = f.ctx.on("session/event", (session, event) => {
    if (session === agent.session && event.type === "llm/retry") {
      stop();
      f.business.restoreDesktopLogin({
        schema: 1,
        environment: "production",
        base: f.business.base,
        auth: {
          token: "new-fixture-login",
          tenantId: "0",
          id: "new-user",
          name: "New",
          username: "new-user",
        },
      });
    }
  });
  await turn(f.ctx, agent, "Original user task");
  expect(requests).toBe(1);
  expect(agent.session.snapshotEvents().at(-1).data.reason.kind).not.toBe("completed");
  await turn(f.ctx, agent, "New login explicitly continues");
  expect(requests).toBe(2);
  expect(agent.session.snapshotEvents().at(-1).data.reason.kind).toBe("completed");
});

it("a retired scoped source cannot be replaced during an automatic retry", async () => {
  let source = new AbortController();
  let requests = 0;
  const f = await model(
    () =>
      ++requests === 1
        ? Response.json({ error: { code: "MODEL_UPSTREAM_UNAVAILABLE" } }, { status: 503 })
        : answer("explicitly continued with the new source"),
    1000000,
    async () => ({ consumerCode: "workbench", signal: source.signal }),
  );
  const agent = await agentOn(f.ctx, "retired-source-retry", "standard");
  const stop = f.ctx.on("session/event", (session, event) => {
    if (session === agent.session && event.type === "llm/retry") {
      stop();
      source.abort(new DOMException("fixture retired source", "AbortError"));
      source = new AbortController();
    }
  });
  await turn(f.ctx, agent, "Original source task");
  expect(requests).toBe(1);
  expect(agent.session.snapshotEvents().at(-1).data.reason.kind).not.toBe("completed");
  await turn(f.ctx, agent, "Explicitly continue with the new source");
  expect(requests).toBe(2);
  expect(agent.session.snapshotEvents().at(-1).data.reason.kind).toBe("completed");
});

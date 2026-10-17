import { afterEach, onTestFinished, expect, it, vi } from "vitest";
import {
  presetHarness,
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
async function model(treatment, capacity = 262144) {
  const f = await presetHarness();
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
      return Response.json({ data: [{ id: "test", name: "Fixture", contextWindow: capacity }] });
    if (url.endsWith("/chat/completions")) return treatment(JSON.parse(String(init?.body)));
    throw new Error("Unexpected fixture request: " + url);
  });
  f.ctx.llm.registerAdapter(["local"], new GeaModelAdapter(business));
  await f.ctx.llm.resolveModelInfo("local", "test");
  return f;
}
it("real Core Session compacts route pressure before continuing with its checkpoint", async () => {
  const requests = [];
  const f = await model((body) => {
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
  });
  const agent = await agentOn(f.ctx, "gea-pressure", "standard", await history(2e4));
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
  expect(JSON.stringify(requests.at(-1)?.messages)).toContain("CHECKPOINT: preserve original task");
  expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
    type: "turn/end",
    data: { reason: { kind: "completed" } },
  });
});
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
          { error: { code: "context_length_exceeded", message: "maximum context length" } },
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
it.each([401, 429, 503])(
  "Core does not compact or retry an ordinary HTTP %s model failure",
  async (status) => {
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
    expect(requests).toHaveLength(1);
    expect(
      agent.session.snapshotEvents().filter((row) => row.type.startsWith("compaction/")),
    ).toHaveLength(0);
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: "turn/end",
      data: { reason: { kind: "error" } },
    });
  },
);
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
                    arguments: JSON.stringify({ todos: [{ content, status: "in_progress" }] }),
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

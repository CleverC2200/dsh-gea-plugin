import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(resolve("node_modules/.gea-model-idle-"));
const compiled = await build({
  entryPoints: ["src/host/gea-model.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node22",
});
const entry = join(root, "model.mjs");
await writeFile(entry, compiled.outputFiles[0].contents);
const { GeaModelAdapter } = await import(pathToFileURL(entry));
test.after(() => rm(root, { recursive: true, force: true }));

const encoder = new TextEncoder();
const event = (delta, finish = null) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + "\n\n";
const settled = () => new Promise((done) => setImmediate(done));
const options = { provider: "gea-analysis", model: "fixture", messages: [] };

function fixture(t, fetch, { mockTimers = true, access } = {}) {
  if (mockTimers) t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "info", () => {});
  const identity = new AbortController();
  const business = {
    config: {
      modelRequestTimeoutMs: 1000,
      maxSnapshotBytes: 100000,
      analysisAgentCode: "fixture",
    },
    identitySignal: () => identity.signal,
    assertExecutionAllowed() {},
    modelRoute: async () => ({
      models: ["fixture"],
      baseUrl: "https://fixture.invalid",
      secret: "fixture-secret",
      agentCode: "fixture",
    }),
    fetchExternal: fetch,
  };
  return { adapter: new GeaModelAdapter(business, access), identity };
}

function response() {
  let controller;
  let cancelled = 0;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled++;
    },
  });
  return {
    value: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    send: (text) => controller.enqueue(encoder.encode(text)),
    cancelled: () => cancelled,
  };
}

async function collect(iterator, chunks = []) {
  for await (const chunk of iterator) chunks.push(chunk);
  return chunks;
}

for (const mode of ["text", "reasoning", "tool parameters", "SSE heartbeat"]) {
  test(`${mode} renews idle time beyond the former total limit`, async (t) => {
    const stream = response();
    const { adapter } = fixture(t, async () => stream.value);
    const tools = [
      {
        name: "lookup",
        description: "fixture",
        parameters: { type: "object" },
      },
    ];
    const result = collect(adapter.stream({ ...options, tools }));
    await settled();
    if (mode === "tool parameters") {
      stream.send(
        event({
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"value":' },
            },
          ],
        }),
      );
      await settled();
    }
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(900);
      stream.send(
        mode === "SSE heartbeat"
          ? ": keepalive\n\n"
          : event(
              mode === "text"
                ? { content: "part" }
                : mode === "reasoning"
                  ? { reasoning_content: "part" }
                  : {
                      tool_calls: [{ index: 0, function: { arguments: "1" } }],
                    },
            ),
      );
      await settled();
    }
    stream.send(
      mode === "tool parameters"
        ? event({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }, "tool_calls")
        : event({ content: "done" }, "stop"),
    );
    stream.send("data: [DONE]\n\n");
    const chunks = await result;
    assert.equal(chunks.at(-1).type, "finish");
    assert.equal(chunks.at(-1).reason.kind, mode === "tool parameters" ? "tool-calls" : "stop");
    assert.equal(stream.cancelled(), 1);
  });
}

test("real SSE heartbeats survive the former absolute deadline", async (t) => {
  const stream = response();
  const { adapter } = fixture(t, async () => stream.value, { mockTimers: false });
  const result = collect(adapter.stream(options)).then(
    (chunks) => ({ chunks }),
    (error) => ({ error }),
  );
  const heartbeat = setInterval(() => {
    if (!stream.cancelled()) stream.send(": keepalive\n\n");
  }, 150);
  t.after(() => clearInterval(heartbeat));
  await delay(1400);
  if (!stream.cancelled()) stream.send(event({ content: "done" }, "stop") + "data: [DONE]\n\n");
  const outcome = await result;
  assert.ifError(outcome.error);
  assert.equal(outcome.chunks.at(-1).reason.kind, "stop");
});

test("an idle stream times out, preserves partial output and closes its reader", async (t) => {
  const stream = response();
  const { adapter } = fixture(t, async () => stream.value);
  const chunks = [];
  const result = assert.rejects(collect(adapter.stream(options), chunks), (error) => {
    assert.equal(error.code, "GEA_NETWORK_TIMEOUT");
    assert.match(error.message, /心跳/);
    return true;
  });
  await settled();
  stream.send(event({ content: "partial" }));
  await settled();
  t.mock.timers.tick(1000);
  await result;
  assert.ok(chunks.some((chunk) => chunk.type === "text-delta" && chunk.text === "partial"));
  assert.equal(stream.cancelled(), 1);
});

test("waiting for response headers uses the same idle timeout", async (t) => {
  let aborted = false;
  const { adapter } = fixture(
    t,
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(init.signal.reason);
          },
          { once: true },
        );
      }),
  );
  const result = assert.rejects(collect(adapter.stream(options)), {
    code: "GEA_NETWORK_TIMEOUT",
  });
  await settled();
  t.mock.timers.tick(1000);
  await result;
  assert.equal(aborted, true);
});

test("managed source resolution retains the existing model idle timeout", async (t) => {
  let aborted = false;
  const { adapter } = fixture(t, async () => assert.fail("source resolution must finish first"), {
    access: async (_session, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  });
  const pending = assert.rejects(collect(adapter.stream(options)), { code: "GEA_NETWORK_TIMEOUT" });
  await settled();
  t.mock.timers.tick(1000);
  await pending;
  assert.equal(aborted, true);
});

test("consumer processing time is not model idle time and early return closes the stream", async (t) => {
  const stream = response();
  const { adapter } = fixture(t, async () => stream.value);
  const iterator = adapter.stream(options)[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "block-start");
  t.mock.timers.tick(5000);
  stream.send(event({ content: "after consumer pause" }));
  assert.equal((await iterator.next()).value.text, "after consumer pause");
  await iterator.return();
  assert.equal(stream.cancelled(), 1);
  t.mock.timers.tick(5000);
});

for (const reason of ["user", "identity"]) {
  test(`${reason} cancellation closes a pending read without becoming a timeout`, async (t) => {
    const stream = response();
    const { adapter, identity } = fixture(t, async () => stream.value);
    const user = new AbortController();
    const result = assert.rejects(collect(adapter.stream({ ...options, signal: user.signal })), {
      name: "AbortError",
    });
    await settled();
    (reason === "user" ? user : identity).abort();
    await result;
    assert.equal(stream.cancelled(), 1);
    t.mock.timers.tick(5000);
  });
}

test("revoking a managed model source cancels its pending stream after re-enable", async (t) => {
  const stream = response();
  let source = new AbortController();
  const { adapter } = fixture(t, async () => stream.value, {
    access: async () => ({ consumerCode: "workbench", signal: source.signal }),
  });
  const chunks = [];
  const pending = assert.rejects(collect(adapter.stream(options), chunks), { name: "AbortError" });
  await settled();
  stream.send(event({ content: "before revoke" }));
  await settled();
  const count = chunks.length;
  source.abort();
  source = new AbortController();
  await settled();
  assert.equal(stream.cancelled(), 1);
  await pending;
  assert.equal(chunks.length, count);
  assert.equal(stream.cancelled(), 1);
  t.mock.timers.tick(5000);
});

test("legal tool parameters larger than the business snapshot budget reach Core intact", async (t) => {
  const argumentsText = JSON.stringify({ text: "中".repeat(40000) });
  const { adapter } = fixture(
    t,
    async () =>
      new Response(
        event(
          {
            tool_calls: [
              {
                index: 0,
                id: "large",
                type: "function",
                function: { name: "lookup", arguments: argumentsText },
              },
            ],
          },
          "tool_calls",
        ) + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    { mockTimers: false },
  );
  const chunks = await collect(
    adapter.stream({
      ...options,
      tools: [{ name: "lookup", description: "fixture", parameters: { type: "object" } }],
    }),
  );
  assert.equal(
    chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "tool-call").block
      .arguments,
    argumentsText,
  );
});

test("reasoning beyond the former character bound reaches the completed Core block unchanged", async (t) => {
  const reasoning = "😀".repeat(524289);
  const { adapter } = fixture(
    t,
    async () =>
      new Response(
        event({ reasoning_content: reasoning, content: "answer" }, "stop") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    { mockTimers: false },
  );
  const chunks = await collect(adapter.stream(options));
  assert.equal(
    chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "reasoning").block
      .text,
    reasoning,
  );
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
});

test("finish waits for late usage and protocol termination beyond the former tail deadline", async (t) => {
  const stream = response();
  const { adapter } = fixture(t, async () => stream.value);
  let settledResult = false;
  const result = collect(adapter.stream(options)).finally(() => {
    settledResult = true;
  });
  await settled();
  stream.send(event({ content: "answer" }, "stop"));
  await settled();
  t.mock.timers.tick(300);
  await settled();
  assert.equal(settledResult, false);
  stream.send('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":30}}\n\n');
  stream.send("data: [DONE]\n\n");
  const chunks = await result;
  assert.equal(chunks.find((chunk) => chunk.type === "usage").usage.totalTokens, 130);
  assert.equal(chunks.at(-1).reason.kind, "stop");
});

test("an unterminated finish continues pulsing on heartbeats and then obeys the existing idle timeout", async (t) => {
  const stream = response();
  const { adapter } = fixture(t, async () => stream.value);
  const result = collect(adapter.stream(options)).then(
    (chunks) => ({ chunks }),
    (error) => ({ error }),
  );
  await settled();
  stream.send(event({ content: "answer" }, "stop"));
  await settled();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(900);
    stream.send(": heartbeat\n\n");
    await settled();
  }
  t.mock.timers.tick(1001);
  const outcome = await result;
  assert.equal(outcome.error.code, "GEA_NETWORK_TIMEOUT");
  assert.equal(stream.cancelled(), 1);
});

test("invalid tool responses retain a request id without automatic retry or payload disclosure", async (t) => {
  let requests = 0;
  const { adapter } = fixture(t, async () => {
    requests++;
    return new Response(
      event(
        {
          tool_calls: [
            {
              index: 0,
              id: "bad",
              type: "function",
              function: {
                name: "GEA_MODEL_INVALID_TOOL_CALL",
                arguments: '{"secret":"private-arguments"}',
              },
            },
          ],
        },
        "tool_calls",
      ),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const chunks = [];
  await assert.rejects(
    collect(
      adapter.stream({
        ...options,
        tools: [{ name: "lookup", description: "fixture", parameters: { type: "object" } }],
      }),
      chunks,
    ),
    (error) => {
      assert.equal(error.code, "GEA_MODEL_INVALID_TOOL_CALL");
      assert.match(error.failure.requestId, /^[a-f0-9-]{36}$/);
      assert.match(error.message, new RegExp("requestId=" + error.failure.requestId));
      const diagnostics = console.info.mock.calls.map((call) => JSON.parse(call.arguments[0]));
      assert.equal(
        diagnostics.find((row) => row.event === "GEA_MODEL_FAILURE").requestId,
        error.failure.requestId,
      );
      assert.doesNotMatch(
        JSON.stringify({ error: error.failure, diagnostics }),
        /private-arguments|fixture-secret/,
      );
      return true;
    },
  );
  assert.equal(requests, 1);
  assert.equal(
    chunks.some((chunk) => chunk.type === "tool-call-delta"),
    false,
  );
});

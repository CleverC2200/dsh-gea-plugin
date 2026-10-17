import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(resolve(".gea-model-idle-"));
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

function fixture(t, fetch, { mockTimers = true } = {}) {
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
  return { adapter: new GeaModelAdapter(business), identity };
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

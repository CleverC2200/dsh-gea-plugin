import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";
const built = await build({
  stdin: {
    contents:
      "export {geaTextStream} from './src/shared/gea-stream.ts';export {toGeaMessages} from './src/host/gea-messages.ts';export {BlockAssembler} from '@deepseek-ai/dsh-llm';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { geaTextStream, toGeaMessages, BlockAssembler } = mod.exports;
const event = (delta, finish_reason = null) =>
  "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\r\n\r\n";
const bodyOf = (wire, split = false) => {
  const bytes = new TextEncoder().encode(wire);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = split ? offset + 1 : bytes.length;
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
};
const collect = async (wire, split = false, offered) => {
  const chunks = [];
  for await (const chunk of geaTextStream(bodyOf(wire, split), undefined, offered))
    chunks.push(chunk);
  return chunks;
};
const modelSource = {
  provider: "gea-analysis",
  model: "id",
};
const assistant = (text, source = modelSource) => ({
  role: "assistant",
  source,
  content: [
    { type: "reasoning", text },
    { type: "text", text: "答案" },
  ],
});

test("actual reasoning and answer preserve UTF-8, whitespace and simultaneous fields through Core assembly and JSON restore", async () => {
  const reasoning = ' 中文\n"引号"\\路径  ';
  const chunks = await collect(
    ": heartbeat\r\n\r\n" +
      event({ role: "assistant" }) +
      event({ reasoning_content: reasoning.slice(0, 4), content: "答" }) +
      event({ reasoning_content: reasoning.slice(4), content: "案" }) +
      'data: {\r\ndata: "choices":[]\r\ndata: }\r\n\r\n' +
      event({}, "stop") +
      "data: [DONE]\r\n\r\n",
    true,
  );
  const assembler = new BlockAssembler();
  for (const chunk of chunks) assembler.push(chunk);
  const restored = JSON.parse(
    JSON.stringify({
      role: "assistant",
      source: { provider: "gea-analysis", model: "id", replayState: assembler.replayState },
      content: assembler.blocks(),
    }),
  );
  assert.deepEqual(toGeaMessages({ messages: [restored] }), [
    { role: "assistant", content: "答案", reasoning_content: reasoning },
  ]);
  assert.equal(
    chunks
      .filter((x) => x.type === "reasoning-delta")
      .map((x) => x.text)
      .join(""),
    reasoning,
  );
  assert.equal(
    restored.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join(""),
    "答案",
  );
});

test("reasoning and tool IDs survive client tool continuation; absent, null and empty reasoning never become required", async () => {
  for (const reasoning of [undefined, null, "", "查询原文\n"]) {
    const wire =
      event({ reasoning_content: reasoning }) +
      event({
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            type: "function",
            function: { name: "query", arguments: "{}" },
          },
        ],
      }) +
      event({}, "tool_calls");
    const assembler = new BlockAssembler();
    for (const chunk of await collect(wire, false, { names: ["query"] })) assembler.push(chunk);
    const history = [
      {
        role: "assistant",
        source: { replayState: assembler.replayState },
        content: assembler.blocks(),
      },
      {
        role: "tool",
        toolCallId: "call-1",
        source: { kind: "tool", callId: "call-1" },
        content: [{ type: "text", text: '{"value":42}' }],
      },
    ];
    const messages = toGeaMessages({ messages: history });
    assert.equal(messages[0].reasoning_content, reasoning || undefined);
    assert.equal(Object.hasOwn(messages[0], "reasoning_content"), !!reasoning);
    assert.equal(messages[0].tool_calls[0].id, messages[1].tool_call_id);
    assert.equal(messages[1].content, '{"value":42}');
  }
});

test("known invalid reasoning types fail safely, unknown extension fields remain compatible", async () => {
  for (const reasoning_content of [42, false, {}, []])
    await assert.rejects(
      collect(event({ reasoning_content, content: "答案" }, "stop")),
      /GEA_MODEL_INVALID_SSE/,
    );
  assert.equal(
    (await collect(event({ unknown_extension: { anything: true }, content: "答案" }, "stop"))).at(
      -1,
    ).reason.kind,
    "stop",
  );
});

test("failed streams retain unfinished reasoning without a successful finish", async () => {
  for (const wire of [
    event({ reasoning_content: "部分原文" }),
    event({ reasoning_content: "部分原文" }) +
      'data: {"error":{"code":"STREAM_ERROR","message":"PRIVATE_REASONING_SENTINEL"}}\n\ndata: [DONE]\n\n',
  ]) {
    const chunks = [];
    await assert.rejects(
      async () => {
        for await (const chunk of geaTextStream(bodyOf(wire)))
          chunks.push(chunk);
      },
      (error) => !error.message.includes("PRIVATE_REASONING_SENTINEL"),
    );
    assert.equal(
      chunks.some((x) => x.type === "finish"),
      false,
    );
    assert.equal(
      chunks.some(
        (x) => x.type === "block-end" && x.block.type === "reasoning",
      ),
      false,
    );
  }
});

test("token-limited reasoning survives Core assembly and restore before user continuation", async () => {
  for (const content of [undefined, "部分答案"]) {
    const chunks = await collect(
      event({ reasoning_content: "部分原文", content }) +
        event({
          tool_calls: [
            {
              index: 0,
              id: "partial",
              type: "function",
              function: { name: "query", arguments: '{"x":' },
            },
          ],
        }) +
        event({}, "length"),
      false,
      { names: ["query"] },
    );
    const assembler = new BlockAssembler();
    for (const chunk of chunks) assembler.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, "max-tokens");
    const restored = JSON.parse(
      JSON.stringify({
        role: "assistant",
        source: modelSource,
        content: assembler.blocks(),
      }),
    );
    const messages = toGeaMessages({
      messages: [
        restored,
        { role: "user", content: [{ type: "text", text: "继续" }] },
      ],
    });
    assert.deepEqual(messages, [
      { role: "assistant", content, reasoning_content: "部分原文" },
      { role: "user", content: "继续" },
    ]);
  }
});

test("reasoning history does not require private replay metadata", () => {
  for (const source of [
    modelSource,
    {
      ...modelSource,
      replayState: {
        response: { protocol: "gea-client-reasoning-v1", complete: true },
      },
    },
  ]) {
    assert.deepEqual(toGeaMessages({ messages: [assistant("原文", source)] }), [
      { role: "assistant", content: "答案", reasoning_content: "原文" },
    ]);
  }
});

test("late increments are ignored but a trailing SSE error still prevents successful finish", async () => {
  const wire =
    event({ reasoning_content: "原文", content: "答案" }, "stop") +
    event({ reasoning_content: "迟到", content: "迟到" }) +
    "data: [DONE]\n\n";
  const chunks = await collect(wire);
  assert.equal(
    chunks
      .filter((x) => x.type === "reasoning-delta")
      .map((x) => x.text)
      .join(""),
    "原文",
  );
  assert.equal(
    chunks
      .filter((x) => x.type === "text-delta")
      .map((x) => x.text)
      .join(""),
    "答案",
  );
  await assert.rejects(
    collect(
      event({ content: "答案", reasoning_content: "原文" }, "stop") +
        'data: {"error":{"code":"STREAM_ERROR"}}\n\ndata: [DONE]\n\n',
    ),
    /GEA_MODEL_GATEWAY_ERROR/,
  );
});

test("request buffers stay isolated and multi-choice output is rejected rather than merged", async () => {
  const results = await Promise.all(
    ["甲", "乙"].map((text) =>
      collect(event({ reasoning_content: text, content: text }, "stop"), true),
    ),
  );
  assert.deepEqual(
    results.map((xs) =>
      xs
        .filter((x) => x.type === "reasoning-delta")
        .map((x) => x.text)
        .join(""),
    ),
    ["甲", "乙"],
  );
  await assert.rejects(
    collect('data: {"choices":[{"index":0},{"index":1}]}\n\n'),
    /GEA_MODEL_INVALID_SSE/,
  );
});

test("complete reasoning history beyond the former per-message and request bounds remains lossless", () => {
  const full = "😀".repeat(524289);
  const histories = Array.from({ length: 5 }, () => assistant(full));
  const messages = toGeaMessages({ messages: histories });
  assert.equal(messages.length, 5);
  assert.ok(messages.every((message) => message.reasoning_content === full));
});

test("abort keeps only an unfinished display prefix and releases its reader", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(event({ reasoning_content: "部分" })));
    },
    cancel() {
      cancelled++;
    },
  });
  const iterator = geaTextStream(body, controller.signal);
  const chunks = [];
  while (!chunks.some((x) => x.type === "reasoning-delta"))
    chunks.push((await iterator.next()).value);
  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  assert.equal(
    chunks.some((x) => x.type === "block-end"),
    false,
  );
});

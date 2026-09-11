import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/gea-stream.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { geaTextStream } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);
const encoder = new TextEncoder();
const event = (delta, finish = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
const collect = async (source) => {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
};

test("SSE framing preserves split UTF-8 and multiline data in the final text block", async () => {
  const bytes = encoder.encode(
    ": heartbeat\r\n\r\n" +
      event({ reasoning_content: "private reasoning" }) +
      event({ content: "中文" }) +
      'data: {\r\ndata: "choices": [{"delta": {"content": "尾段"}, "finish_reason": "stop"}]\r\ndata: }\r\n\r\n',
  );
  let cancelled = 0;
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(bytes.slice(offset, ++offset));
    },
    cancel() {
      cancelled++;
    },
  });
  const chunks = await collect(geaTextStream(body));
  assert.deepEqual(chunks.find((chunk) => chunk.type === "block-end").block, {
    type: "text",
    text: "中文尾段",
  });
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  assert.equal(JSON.stringify(chunks).includes("private reasoning"), false);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("EOF, unsupported tools, unknown terminal reasons and reasoning-only stops fail closed", async () => {
  for (const [wire, expected] of [
    [event({ content: "partial" }), "GEA_MODEL_INCOMPLETE_STREAM"],
    [
      event({ content: "partial" }) + "data: [DONE]\n\n",
      "GEA_MODEL_INCOMPLETE_STREAM",
    ],
    [
      event({ tool_calls: [{ id: "call-1" }] }),
      "GEA_MODEL_UNSUPPORTED_TOOL_CALL",
    ],
    [
      event({ content: "partial" }, "tool_calls"),
      "GEA_MODEL_UNSUPPORTED_FINISH_REASON",
    ],
    [
      event({ content: "partial" }, "content_filter"),
      "GEA_MODEL_UNSUPPORTED_FINISH_REASON",
    ],
    [
      event({ reasoning_content: "reasoning only" }, "stop"),
      "GEA_MODEL_EMPTY_RESPONSE",
    ],
  ]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        controller.close();
      },
    });
    await assert.rejects(collect(geaTextStream(body)), new RegExp(expected));
    assert.equal(body.locked, false);
  }
});

test("abort cancels a pending read and returning early releases the reader", async () => {
  for (const mode of ["abort", "return"]) {
    let cancelled = 0;
    const body = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    const controller = new AbortController();
    const iterator = geaTextStream(body, controller.signal);
    assert.equal((await iterator.next()).value.type, "block-start");
    if (mode === "abort") {
      const pending = iterator.next();
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } else await iterator.return();
    assert.equal(cancelled, 1, mode);
    assert.equal(body.locked, false, mode);
  }
});

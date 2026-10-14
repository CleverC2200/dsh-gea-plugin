import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({
  entryPoints: ["src/host/mcp-response.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { readMcpResponseText, DEFAULT_MCP_RESPONSE_BYTES } = await import(
  "data:text/javascript;base64," + Buffer.from(built.outputFiles[0].contents).toString("base64")
);

test("response budget counts UTF-8 bytes and handles split multibyte characters", async () => {
  const bytes = new TextEncoder().encode("查询结果");
  const signal = new AbortController().signal;
  const make = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
    );
  assert.equal(await readMcpResponseText(make(), signal, bytes.length), "查询结果");
  await assert.rejects(readMcpResponseText(make(), signal, bytes.length - 1), /RESPONSE_TOO_LARGE/);
  assert.equal(DEFAULT_MCP_RESPONSE_BYTES, 320 * 1024 * 1024);
});

test("oversize streaming bodies are cancelled before more chunks are consumed", async () => {
  let read = 0,
    cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      read++;
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readMcpResponseText(new Response(stream), new AbortController().signal, 9));
  assert.equal(cancelled, true);
  assert.ok(read <= 3);
});

test("identity cancellation ends a pending response read and preserves its reason", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const pending = readMcpResponseText(new Response(stream), abort.signal);
  abort.abort(Error("identity changed"));
  await assert.rejects(pending, /identity changed/);
  assert.equal(cancelled, true);
});

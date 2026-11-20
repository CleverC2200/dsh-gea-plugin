import test from "node:test";
import { GeaRequestCapture } from "./helpers/feedback-capture.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { createUserMessage, LlmRuntime } from "@deepseek-ai/dsh-llm";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const compiled = await build({
  stdin: {
    contents: `export { GeaModelAdapter } from "./src/host/gea-model.ts";
      export { readUploadedFileTool } from "./src/host/uploaded-files.ts";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { GeaModelAdapter, readUploadedFileTool } = mod.exports;

test("GEA model recovery uses a bounded Core policy without retrying protocol or permanent failures", () => {
  const policy = new GeaModelAdapter({}).providerRetryPolicy("gea-analysis");
  assert.equal(policy.mode, "normal");
  assert.equal(policy.maxRetries, 2);
  for (const code of ["SERVER", "TIMEOUT", "TRANSPORT", "RATE_LIMIT"])
    assert.ok(policy.retryableCodes.includes(code));
  for (const code of [
    "GEA_MODEL_GATEWAY_ERROR",
    "GEA_MODEL_HTTP_403",
    "GEA_MODEL_INVALID_TOOL_CALL",
    "PROVIDER_PROTOCOL",
  ])
    assert.ok(!policy.retryableCodes.includes(code));
});

test("actual LlmRuntime receives route capacity and leaves unknown model capacity unknown", async (t) => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const runtime = new LlmRuntime(ctx);
  runtime.registerAdapter(
    ["gea-analysis"],
    new GeaModelAdapter({
      config: { analysisAgentCode: "fixture" },
      modelRoute: async () => ({
        names: { known: "Known", unknown: "Unknown" },
        contextWindows: { known: 262144 },
      }),
    }),
  );
  assert.deepEqual((await runtime.resolveModelInfo("gea-analysis", "known")).context, {
    contextWindow: 262144,
  });
  assert.equal((await runtime.resolveModelInfo("gea-analysis", "unknown")).context, undefined);
});

test("the default catalog, model metadata and inference use workbench while scoped inference keeps its Consumer", async (t) => {
  t.mock.method(console, "info", () => {});
  const routed = [];
  const authorized = [];
  const transported = [];
  const identity = new AbortController();
  const business = {
    capture: new GeaRequestCapture(
      "",
      () => undefined,
      () => "https://fixture.invalid",
    ),
    config: {
      analysisAgentCode: "sales_forecast",
      modelRequestTimeoutMs: 1000,
    },
    identitySignal: () => identity.signal,
    assertExecutionAllowed: (consumer) => authorized.push(consumer),
    modelRoute: async (_signal, consumer) => {
      routed.push(consumer);
      return {
        agentCode: consumer,
        models: ["fixture"],
        names: { fixture: "Fixture" },
        baseUrl: "https://fixture.invalid",
        secret: "fixture-only",
      };
    },
    fetchExternal: async (_url, init) => {
      transported.push(new Headers(init.headers).get("X-GEA-Agent-Code"));
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  };
  const adapter = new GeaModelAdapter(business);
  assert.deepEqual(await adapter.listModels("gea-analysis"), [
    { provider: "gea-analysis", id: "fixture", name: "Fixture" },
  ]);
  assert.equal((await adapter.resolveModel("gea-analysis", "fixture")).name, "Fixture");
  for (const consumer of [undefined, "sales_forecast", "branch-inventory"]) {
    const scoped = consumer
      ? new GeaModelAdapter(business, async () => ({
          consumerCode: consumer,
          signal: identity.signal,
        }))
      : adapter;
    const chunks = [];
    for await (const chunk of scoped.stream({
      provider: "gea-analysis",
      model: "fixture",
      messages: [],
    }))
      chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, "stop");
  }
  assert.deepEqual(routed, [
    "workbench",
    "workbench",
    "workbench",
    "sales_forecast",
    "branch-inventory",
  ]);
  assert.deepEqual(authorized, ["workbench", "sales_forecast", "branch-inventory"]);
  assert.deepEqual(transported, authorized);
});

test("GEA submits uploaded images in order and retains the file handle provided by Core", async (t) => {
  t.mock.method(console, "info", () => {});
  const root = await mkdtemp(join(tmpdir(), "gea-model-input-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const imageData = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0iYAAAAASUVORK5CYII=",
    "base64",
  );
  const fileContents = "sku,qty\nA1,27\n";
  const file = {
    attachmentId: "sha256:" + "a".repeat(64),
    name: "stock.csv",
    bytes: Buffer.byteLength(fileContents),
  };
  const image = {
    attachmentId: "sha256:" + "b".repeat(64),
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: imageData.length,
  };
  const filePath = join(root, file.name);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, fileContents);
  const attachments = {
    fileHostPath: (ref) => {
      assert.deepEqual(ref, file);
      return filePath;
    },
    async *readFileStream(ref, signal) {
      signal.throwIfAborted();
      assert.deepEqual(ref, file);
      yield await readFile(filePath);
    },
  };
  ctx.provide("attachments", attachments);
  ctx.provide("fs", { processPathFromHostPath: (path) => path });
  const runtime = new LlmRuntime(ctx);
  const captured = [];
  let imagesRead = 0;
  const business = {
    identitySignal: () => new AbortController().signal,
    assertExecutionAllowed() {},
    config: { modelRequestTimeoutMs: 1000 },
    capture: new GeaRequestCapture(
      "",
      () => undefined,
      () => "https://fixture.invalid",
    ),
    modelRoute: async () => ({
      agentCode: "workbench",
      models: ["vision", "text"],
      names: { vision: "Vision", text: "Text" },
      inputModalities: { vision: ["text", "image"], text: ["text"] },
      baseUrl: "https://fixture.invalid",
      secret: "fixture-only",
    }),
    fetchExternal: async (_url, init) => {
      assert.equal(new Headers(init.headers).get("Accept"), "text/event-stream, application/json");
      captured.push(JSON.parse(init.body).messages[0].content);
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  };
  runtime.registerAdapter(
    ["gea-analysis"],
    new GeaModelAdapter(business, undefined, async (ref, signal) => {
      signal.throwIfAborted();
      assert.deepEqual(ref, image);
      imagesRead++;
      return { data: imageData, mediaType: image.mediaType };
    }),
  );
  const message = createUserMessage({
    source: { kind: "user" },
    content: [
      { type: "text", text: "核对库存" },
      { type: "image", attachment: image },
      { type: "file", attachment: file },
    ],
  });
  assert.deepEqual((await runtime.resolveModelInfo("gea-analysis", "vision")).inputModalities, [
    "text",
    "image",
  ]);
  for (const model of ["vision", "text"]) {
    const chunks = [];
    for await (const chunk of runtime.stream({
      provider: "gea-analysis",
      model,
      messages: [message],
    }))
      chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, "stop");
  }
  assert.equal(imagesRead, 1);
  assert.deepEqual(captured[0].slice(0, 2), [
    { type: "text", text: "核对库存" },
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64," + imageData.toString("base64") },
    },
  ]);
  assert.ok(captured[0][2].text.includes(filePath));
  assert.match(captured[1], /image omitted because this model accepts text only/);
  assert.ok(captured[1].includes(filePath));

  const tool = readUploadedFileTool(ctx);
  const access = {
    signal: new AbortController().signal,
    agent: { session: { snapshotEvents: () => [{ type: "user/message", data: message }] } },
  };
  assert.deepEqual(JSON.parse(await tool.execute({ name: file.name }, access)), {
    name: file.name,
    text: fileContents,
    nextOffset: null,
  });
  await assert.rejects(tool.execute({ name: filePath }, access), /ATTACHMENT_NOT_FOUND/);
  await assert.rejects(
    tool.execute(
      { name: file.name },
      { ...access, agent: { session: { snapshotEvents: () => [] } } },
    ),
    /ATTACHMENT_NOT_FOUND/,
  );
});

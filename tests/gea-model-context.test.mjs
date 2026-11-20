import test from "node:test";
import { GeaRequestCapture } from "./helpers/feedback-capture.mjs";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime } from "@deepseek-ai/dsh-llm";

const compiled = await build({
  entryPoints: ["src/host/gea-model.ts"],
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
const { GeaModelAdapter } = mod.exports;

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

test("GEA sends image-only and mixed history as ordered image_url blocks on every attempt", async (t) => {
  t.mock.method(console, "info", () => {});
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const runtime = new LlmRuntime(ctx);
  const bodies = [];
  const reads = [];
  const data = Buffer.from("UklGRgwAAABXRUJQVlA4TA==", "base64");
  const attachment = {
    attachmentId: "sha256:" + "b".repeat(64),
    mediaType: "image/webp",
    width: 1,
    height: 1,
    bytes: data.length,
  };
  const identity = new AbortController();
  const business = {
    capture: new GeaRequestCapture(
      "",
      () => undefined,
      () => "https://fixture.invalid",
    ),
    config: { modelRequestTimeoutMs: 1000 },
    identitySignal: () => identity.signal,
    assertExecutionAllowed() {},
    modelRoute: async (_signal, agentCode) => ({
      agentCode,
      models: ["vision", "text"],
      names: { vision: "Vision", text: "Text" },
      imageInputs: new Map([
        [
          "vision",
          { formats: ["webp"], withTools: true, count: 2, fileBytes: 100, totalBytes: 100 },
        ],
      ]),
      baseUrl: "https://fixture.invalid",
      secret: "fixture-only",
    }),
    fetchExternal: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  };
  runtime.registerAdapter(
    ["gea-analysis"],
    new GeaModelAdapter(business, undefined, async (ref) => {
      reads.push(ref);
      return { data };
    }),
  );
  const user = (content) => ({ role: "user", source: { kind: "user" }, content });
  const image = { type: "image", attachment };
  const text = (text) => ({ type: "text", text });
  const dispatch = async (model, messages) => {
    const chunks = [];
    for await (const chunk of runtime.stream({ provider: "gea-analysis", model, messages }))
      chunks.push(chunk);
    return chunks.at(-1).reason.kind;
  };

  const imageOnly = user([image]);
  const picture = {
    type: "image_url",
    image_url: { url: "data:image/webp;base64," + data.toString("base64") },
  };
  assert.equal(await dispatch("vision", [imageOnly]), "stop");
  assert.deepEqual(bodies[0].messages, [{ role: "user", content: [picture] }]);

  const history = [imageOnly, user([text("before"), image, text("after")]), user([text("next")])];
  assert.equal(await dispatch("vision", history), "stop");
  assert.equal(await dispatch("vision", history), "stop");
  assert.deepEqual(bodies[1].messages, [
    { role: "user", content: [picture] },
    { role: "user", content: [text("before"), picture, text("after")] },
    { role: "user", content: "next" },
  ]);
  assert.deepEqual(bodies[2], bodies[1]);
  assert.equal(reads.length, 3);
  assert.equal(await dispatch("text", [imageOnly]), "error");
  assert.equal(await dispatch("vision", [imageOnly, imageOnly, imageOnly]), "error");
  assert.equal(bodies.length, 3);
  assert.equal(reads.length, 3);
});

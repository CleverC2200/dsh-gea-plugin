import test from "node:test";
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
    config: { analysisAgentCode: "sales_forecast", modelRequestTimeoutMs: 1000 },
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
      transported.push(init.headers["X-GEA-Agent-Code"]);
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

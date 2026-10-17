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

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

test("real model adapter attaches card snapshot without changing user message", async () => {
  const output = resolve(`tests/.order-card-adapter-${process.pid}.mjs`);
  const entry = resolve(`tests/.order-card-entry-${process.pid}.mjs`);
  try {
    await writeFile(
      entry,
      `export { GeaModelAdapter } from '../src/host/gea-model.ts';
export { bindModulePage } from '../src/host/module-page-scope.ts';`,
    );
    await build({
      entryPoints: [entry],
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      outfile: output,
    });
    const { GeaModelAdapter, bindModulePage } = await import(pathToFileURL(output).href);
    const controller = new AbortController();
    let outbound;
    let failure;
    const business = {
      config: { modelRequestTimeoutMs: 1000 },
      identitySignal: () => controller.signal,
      surfaceFor: () => ({ menu: "inventory-orderworkbench" }),
      assertExecutionAllowed() {},
      modelRoute: async () => ({
        models: ["test"],
        secret: "test",
        baseUrl: "https://example.invalid",
        agentCode: "order",
      }),
      capture: { observe: async (fn) => fn(), iterate: (_session, _purpose, iterator) => iterator },
      fetchExternal: async (_url, options) => {
        outbound = JSON.parse(options.body);
        throw Error("TEST_CAPTURED");
      },
    };
    bindModulePage(business, "s", "inventory-orderworkbench", controller.signal).observe({
      metricDetails: {
        trigger: "metric-card",
        displayText: "短问题",
        agentPrompt: "完整快照：7786/7812；本期、本周、基地及同比",
      },
    });
    const messages = [
      {
        role: "user",
        id: "m1",
        source: { kind: "user" },
        content: [{ type: "text", text: "短问题" }],
      },
    ];
    try {
      for await (const _chunk of new GeaModelAdapter(business).stream({
        provider: "gea-analysis",
        model: "test",
        sessionId: "s",
        messages,
        signal: controller.signal,
      })) {
      }
    } catch (error) {
      failure = error;
    }
    assert.ok(outbound, failure?.message ?? "model adapter must reach the outgoing request");
    assert.equal(outbound.messages.find((message) => message.role === "user").content, "短问题");
    assert.match(
      outbound.messages.find((message) => message.role === "system").content,
      /完整快照：7786\/7812/,
    );
    assert.equal(messages[0].content[0].text, "短问题");
  } finally {
    await Promise.allSettled([unlink(output), unlink(entry)]);
  }
});

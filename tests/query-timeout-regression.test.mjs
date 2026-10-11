import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
const compiled = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts';export {createCapabilityRegistry} from './src/capability/registry.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const module = { exports: {} };
new Function(
  "require",
  "module",
  "exports",
  Buffer.from(compiled.outputFiles[0].contents).toString(),
)(createRequire(import.meta.url), module, module.exports);
const { Business, createCapabilityRegistry } = module.exports;
const consumer = { consumerType: "AGENT", consumerCode: "test-agent" };
const makeBusiness = (config = {}) => {
  const b = new Business({
    geaEnvironments: { production: "https://gea.test", test: "https://test.gea.test" },
    requestTimeoutMs: 5,
    inputByteBudget: 32000,
    pageSize: 50,
    ...config,
  });
  b.auth = { token: "fixture", tenantId: "0", id: "fixture" };
  b.setCapabilities(
    createCapabilityRegistry([
      {
        id: "timeout-read",
        label: "Timeout read",
        enabled: true,
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "Timeout read" },
        data: { consumerCode: consumer.consumerCode, tables: [], rules: [] },
      },
      {
        id: "gea-workbench",
        label: "Sales read",
        maxEffect: "view",
        skills: [],
        routing: { keywords: [], summary: "Sales read" },
        data: { consumerCode: b.config.analysisAgentCode, tables: [], rules: [] },
      },
    ]),
  );
  return b;
};
const session = () =>
  Response.json({
    success: true,
    result: {
      accessDecision: { allowed: true },
      gatewayContext: { ...consumer, sessionId: "fixture", conversationId: "fixture" },
      delegationToken: "fixture",
    },
  });

test("screenshot list input explains how to resolve a period; corrected input reaches the server", async () => {
  const b = makeBusiness({ requestTimeoutMs: 1000 });
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({ success: true, result: { records: [], total: 0 } });
  };
  try {
    await assert.rejects(
      () =>
        b.agentQuery(
          { kind: "list", query: { periodMonth: "2026-09", pageNo: 1, pageSize: 50 } },
          new AbortController().signal,
        ),
      /INVALID_QUERY:.*kind=periods.*periodId/,
    );
    assert.equal(requests.length, 0);
    await b.agentQuery(
      { kind: "list", query: { periodId: "20260901", pageNo: 1, pageSize: 50 } },
      new AbortController().signal,
    );
    assert.equal(new URL(requests[0]).searchParams.get("periodId"), "20260901");
    assert.equal(new URL(requests[0]).searchParams.has("periodMonth"), false);
  } finally {
    globalThis.fetch = original;
    b.dispose();
  }
});

test("MCP outlives the REST timeout, respects its own limit and caller cancellation", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/session")) return session();
    await delay(40, undefined, { signal: init.signal });
    return Response.json({ result: {} });
  };
  try {
    for (const config of [{}, { mcpRequestTimeoutMs: 200 }, { mcpRequestTimeoutMs: 10 }]) {
      const b = makeBusiness(config);
      try {
        const c = await b.openMcpConnection(consumer, new AbortController().signal);
        const request = () =>
          c.fetch(c.url, {
            method: "POST",
            body: JSON.stringify({ method: "resources/list", params: {} }),
          });
        if (config.mcpRequestTimeoutMs === 10)
          await assert.rejects(request, { name: "AbortError" });
        else await request();
        const caller = new AbortController();
        caller.abort();
        await assert.rejects(() =>
          c.fetch(c.url, {
            method: "POST",
            signal: caller.signal,
            body: JSON.stringify({ method: "resources/list" }),
          }),
        );
      } finally {
        b.dispose();
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

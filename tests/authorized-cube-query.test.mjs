import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  stdin: {
    contents: "export {prepareGatewayMcp} from './src/host/gateway-mcp.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { prepareGatewayMcp } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
const resource = (model, extra = {}) => ({
  capabilityCode: "MCP_TOOL:cube:query_business_data",
  resourceCode: model + "-cube",
  resourceName: model,
  resourceType: "EXTERNAL_MCP",
  queryTarget: model,
  version: "1",
  maxRows: 200,
  maxBytes: 262144,
  ...extra,
});
// Retained evidence still rechecks its original grant through this current transport interface.
// Current query authorization and execution run through Core tools.execute in current-mcp-tools.test.mjs.
test("resource discovery uses the negotiated route and trusted session, handles audit failure and 429 without fallback", async () => {
  let response = { success: true, resources: [resource("inv")] };
  let rate = false;
  const calls = [];
  const consumer = { consumerType: "AGENT", consumerCode: "sales_forecast" };
  const fake = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith("/session"))
      return Response.json({
        success: true,
        result: {
          accessDecision: { allowed: true },
          gatewayContext: {
            ...consumer,
            sessionId: "session",
            conversationId: "conversation",
          },
          delegationToken: "fixture-secret",
        },
      });
    if (url.endsWith("/resources"))
      return rate
        ? new Response("", { status: 429, headers: { "Retry-After": "12" } })
        : Response.json(response);
    return Response.json({
      id: 1,
      result: {
        tools: [
          {
            name: "query_business_data",
            _meta: { sourceType: "MCP", sourceCode: "cube" },
          },
        ],
      },
    });
  };
  const signal = new AbortController().signal;
  const t = await prepareGatewayMcp(
    "https://fixture",
    { token: "login-secret", tenantId: "0" },
    consumer,
    signal,
    1000,
    fake,
    { cubeMcpCode: "cube" },
  );
  await assert.rejects(t.authorizedResources("query_business_data", signal), /ROUTE_REQUIRED/);
  await t.fetch(t.url, {
    method: "POST",
    body: JSON.stringify({ id: 1, method: "tools/list" }),
  });
  const result = await t.authorizedResources("query_business_data", signal);
  assert.equal(result.resources.length, 1);
  const sent = calls.at(-1);
  assert.deepEqual(sent.body, {
    sessionId: "session",
    conversationId: "conversation",
    delegationToken: "fixture-secret",
    agentCode: "sales_forecast",
    mcpCode: "cube",
    toolName: "query_business_data",
  });
  assert.doesNotMatch(sent.url, /fixture-secret|login-secret/);
  assert.equal(new Headers(sent.headers).has("X-Access-Token"), false);
  response = {
    success: false,
    code: "AI_GATEWAY_AUDIT_UNAVAILABLE",
    resources: [resource("hidden")],
  };
  await assert.rejects(
    t.authorizedResources("query_business_data", signal),
    (e) => /AUDIT_UNAVAILABLE/.test(e.message) && !e.message.includes("hidden"),
  );
  response = {
    success: false,
    code: "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED",
    category: "SESSION",
    resources: [resource("hidden")],
  };
  await assert.rejects(
    t.authorizedResources("query_business_data", signal),
    (e) => e.code === "AI_GATEWAY_SESSION_MAX_LIFETIME_EXCEEDED" && !e.message.includes("hidden"),
  );
  response = { success: true, resources: [resource("inv", { maxRows: -1 })] };
  await assert.rejects(t.authorizedResources("query_business_data", signal), /INVALID_LIMIT/);
  response = { success: true, resources: [resource("inv", { version: "" })] };
  await assert.rejects(t.authorizedResources("query_business_data", signal), /INVALID_RESOURCE/);
  response = {
    success: true,
    resources: [resource("inv", { capabilityCode: "MCP_TOOL:other:query_business_data" })],
  };
  await assert.rejects(t.authorizedResources("query_business_data", signal), /INVALID_RESOURCE/);
  rate = true;
  await assert.rejects(
    t.authorizedResources("query_business_data", signal),
    (e) => e.retryAfterMs === 12000,
  );
  assert.equal(calls.filter((x) => x.url.endsWith("/resources")).length, 7);
});

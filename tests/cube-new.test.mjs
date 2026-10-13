import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents:
      "export {gatewayMcpTransport} from './src/host/gateway-mcp.ts'; export {openModuleMcp} from './src/host/mcp-client.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { gatewayMcpTransport, openModuleMcp } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
const code = "2109581866385289217";
const uri = "data-artifact://gateway/new-result";
const payload = () => ({
  action: "query",
  status: "completed",
  executedQueryCount: 1,
  datasets: [
    {
      name: "forecast",
      rowCount: 1,
      complete: true,
      hasMore: false,
      dataStatus: "ok",
      totalRowCount: 2,
      offset: 0,
      hasMorePages: true,
      fields: [{ name: "sales_forecast_result.amount" }],
      rows: [
        {
          "sales_forecast_result.amount": null,
          "sales_forecast_result.code": "001",
          "sales_forecast_result.zero": 0,
        },
      ],
    },
  ],
});
const query = {
  action: "query",
  response_mode: "inline_complete",
  queries: [
    {
      name: "forecast",
      query: { measures: ["sales_forecast_result.amount"], limit: 1, total: true },
    },
  ],
};
async function fixture(options = {}) {
  const sent = [];
  const raw = JSON.stringify(options.payload ?? payload());
  const hash = createHash("sha256").update(raw).digest("hex");
  const fake = async (url, init) => {
    const wire = JSON.parse(init.body);
    sent.push({ wire, headers: new Headers(init.headers) });
    const reply = (result, headers) =>
      Response.json({ jsonrpc: "2.0", id: wire.id, result }, { headers });
    if (wire.method === "initialize")
      return reply({ protocolVersion: "2025-11-25" }, { "MCP-Session-Id": "transport-session" });
    if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (wire.method === "tools/list")
      return reply({
        tools: [
          {
            name: "query_business_data",
            _meta: { sourceType: "MCP", sourceCode: "old-cube" },
            inputSchema: { type: "object", properties: {} },
          },
          ...(!options.missing
            ? [
                {
                  name: "query_business_data",
                  _meta: { sourceType: "MCP", sourceCode: code },
                  inputSchema: { type: "object", properties: {} },
                },
                {
                  name: "inspect_cube_model",
                  _meta: { sourceType: "MCP", sourceCode: code },
                  inputSchema: { type: "object", properties: {} },
                },
              ]
            : []),
        ],
      });
    if (wire.method === "tools/call" && wire.params.name === "inspect_cube_model")
      return reply({ structuredContent: { action: "inspect", semanticModel: [] }, content: [] });
    if (wire.method === "tools/call")
      return reply({
        content: [
          { type: "resource_link", uri, mimeType: "application/json", _meta: { sha256: hash } },
        ],
      });
    if (wire.method === "resources/read")
      return reply({
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: raw,
            _meta: { sha256: options.badHash ? "0".repeat(64) : hash },
          },
        ],
      });
    throw Error("unexpected " + wire.method);
  };
  const controller = new AbortController();
  const transport = gatewayMcpTransport(
    "https://gea.test",
    {
      sessionId: "business-session",
      conversationId: "conversation",
      agentCode: "sales_forecast",
      delegationToken: "private-delegation",
    },
    controller.signal,
    1000,
    fake,
    { cubeMcpCode: code },
  );
  return {
    module: await openModuleMcp(transport, controller.signal),
    sent,
    signal: controller.signal,
  };
}

test("Cube-New discovers the explicit source, calls separate inspect, and reads its artifact with the same business context", async () => {
  const f = await fixture();
  assert.equal(f.module.tools().filter((t) => t.name === "query_business_data").length, 1);
  assert.deepEqual(JSON.parse(await f.module.call("inspect_cube_model", { limit: 50 }, f.signal)), {
    action: "inspect",
    semanticModel: [],
  });
  let evidence;
  const result = await f.module.call("query_business_data", query, f.signal, (text) => {
    evidence = JSON.parse(text);
  });
  assert.match(result, /forecast/);
  assert.equal(evidence.datasets[0].rows[0]["sales_forecast_result.amount"], null);
  assert.equal(evidence.datasets[0].rows[0]["sales_forecast_result.code"], "001");
  assert.equal(evidence.datasets[0].rows[0]["sales_forecast_result.zero"], 0);
  assert.equal(evidence.datasets[0].hasMorePages, true);
  for (const { wire, headers } of f.sent.filter((x) =>
    ["tools/call", "resources/read"].includes(x.wire.method),
  )) {
    assert.equal(wire.params._meta.mcpCode, code);
    assert.equal(wire.params._meta.sessionId, "business-session");
    assert.equal(wire.params._meta.delegationToken, "private-delegation");
    assert.equal(headers.get("MCP-Session-Id"), "transport-session");
    assert.equal(headers.get("MCP-Protocol-Version"), "2025-11-25");
  }
});

test("an unregistered or unauthorized Cube-New never borrows the old same-name query tool", async () => {
  const f = await fixture({ missing: true });
  assert.equal(
    f.module.tools().some((t) => t.name === "query_business_data"),
    false,
  );
  const calls = f.sent.length;
  await assert.rejects(f.module.call("query_business_data", query, f.signal), (error) => {
    assert.equal(error.code, "GEA_MCP_TOOL_UNAVAILABLE");
    assert.equal(error.toolName, "query_business_data");
    assert.equal(error.sourceCode, code);
    assert.match(error.message, /当前业务会话/);
    assert.doesNotMatch(error.message, /private-delegation|business-session/);
    return true;
  });
  assert.equal(f.sent.length, calls, "missing authorized tool must not issue a remote call");
});

test("Cube-New cannot publish forged hashes, incomplete pages or mismatched datasets as query evidence", async () => {
  for (const options of [
    { badHash: true },
    { payload: { ...payload(), datasets: [{ ...payload().datasets[0], complete: false }] } },
    { payload: { ...payload(), datasets: [{ ...payload().datasets[0], name: "wrong-query" }] } },
  ]) {
    const f = await fixture(options);
    let published = false;
    const result = await f.module.call("query_business_data", query, f.signal, () => {
      published = true;
    });
    assert.equal(published, false);
    assert.match(result, /GEA_CUBE_NEW_/);
  }
});

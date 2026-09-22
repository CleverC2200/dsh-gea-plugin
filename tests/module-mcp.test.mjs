// 模块 MCP 客户端：initialize → tools/list → tools/call（JSON 与 SSE 两种响应都要认）。
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './src/host/mcp-client.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const m = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

const json = (value, headers = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

function fakeTransport(handler) {
  const seen = [];
  return {
    seen,
    transport: {
      url: "https://gateway.invalid/mcp",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        seen.push({ method: body.method, headers: init.headers });
        return handler(body);
      },
    },
  };
}

test("会话按 initialize → tools/list 建立，工具清单可读", async () => {
  const { seen, transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json(
        { jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } },
        { "MCP-Session-Id": "s-1" },
      );
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            {
              name: "safety_stock_query",
              description: "按基地查安全库存",
              inputSchema: { properties: { base: {}, month: {} }, required: ["base"] },
            },
          ],
        },
      });
    if (body.method === "tools/call")
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "郑州: 852" }] } });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  assert.deepEqual(
    module.tools().map((tool) => [tool.name, tool.parameters, tool.required]),
    [["safety_stock_query", ["base", "month"], ["base"]]],
  );
  assert.equal(
    await module.call("safety_stock_query", { base: "郑州" }, new AbortController().signal),
    "郑州: 852",
  );
  assert.deepEqual(
    seen.map((item) => item.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call"],
  );
  // initialize 必须带协议版本头：重连时传输层要用它比对服务端版本。
  assert.ok(seen[0].headers["MCP-Protocol-Version"]);
});

test("明确标记为写入或破坏性的 MCP 工具不会进入只读清单", async () => {
  const { transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: {} });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          tools: [
            { name: "safe_read", inputSchema: { properties: {} }, annotations: { readOnlyHint: true } },
            { name: "write_plan", inputSchema: { properties: {} }, annotations: { readOnlyHint: false } },
            { name: "delete_plan", inputSchema: { properties: {} }, annotations: { destructiveHint: true } },
          ],
        },
      });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  assert.deepEqual(module.tools().map((tool) => tool.name), ["safe_read"]);
});

test("SSE 响应与业务错误都能读出来", async () => {
  const { transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":' +
          JSON.stringify(body.id) +
          ',"result":{"tools":[{"name":"t","inputSchema":{"properties":{}}}]}}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "无权限" } });
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  assert.equal(module.tools()[0].name, "t");
  await assert.rejects(
    () => module.call("t", {}, new AbortController().signal),
    /GEA_MCP_TOOL_ERROR.*无权限/,
  );
});

test("协议版本协商失败时给出可读错误，不静默成功", async () => {
  const { transport } = fakeTransport(() => new Response("", { status: 500 }));
  await assert.rejects(
    () => m.openModuleMcp(transport, new AbortController().signal),
    /GEA_MCP_INIT_FAILED/,
  );
});

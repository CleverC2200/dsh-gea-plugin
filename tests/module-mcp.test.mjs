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
  // 每个请求都要带协议版本头：线上实测网关只在缺它的时候把 tools/list 判 400
  // （initialize 带了、tools/list 没带 → 会话建得起来、工具列不出来）。
  for (const item of seen)
    assert.ok(
      item.headers["MCP-Protocol-Version"],
      `${item.method} 缺少 MCP-Protocol-Version 头`,
    );
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

test("resource_link 结果由宿主读回内联，模型不必自己读资源", async () => {
  const { seen, transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "query_business_data", inputSchema: { properties: { action: {} } } }] },
      });
    if (body.method === "tools/call")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: false,
          content: [
            {
              type: "resource_link",
              name: "query_business_data-result",
              mimeType: "application/json",
              uri: "data-artifact://gateway/de861c7a",
              _meta: { oss_url: "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/gea/data-artifacts/x.json" },
            },
          ],
        },
      });
    if (body.method === "resources/read")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { contents: [{ uri: body.params.uri, mimeType: "application/json", text: '{"rows":[{"d":"2026-09-23"}]}' }] },
      });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("query_business_data", { action: "query" }, new AbortController().signal);
  // 正文直接内联，模型不用再调平台的读资源工具（它会猜错 server）。
  assert.match(value, /结果内容 data-artifact:\/\/gateway\/de861c7a/);
  assert.match(value, /2026-09-23/);
  assert.deepEqual(
    seen.map((item) => item.method),
    ["initialize", "notifications/initialized", "tools/list", "tools/call", "resources/read"],
  );
});

test("资源读不回来时给可读说明，不让模型拿着链接乱试", async () => {
  const { transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "query_business_data", inputSchema: { properties: {} } }] } });
    if (body.method === "tools/call")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "resource_link", uri: "data-artifact://gateway/abc" }] },
      });
    return json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found: resources/read" } });
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("query_business_data", { action: "query" }, new AbortController().signal);
  assert.match(value, /结果内容读不回来/);
  assert.match(value, /response_mode=inline_complete/);
  // 不能把"去读浏览器 MCP"这类错误留给模型自己撞。
  assert.equal(value.includes("browser"), false);
});

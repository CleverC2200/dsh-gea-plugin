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

// 网关把业务失败裹在正常返回体里（HTTP 200、JSON-RPC 无 error），正文写着
// success:false + businessCode。原样当数据回给模型，界面上就"报错都不展示了"。
function envelopeTransport(payload) {
  return fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t", inputSchema: { properties: {} } }] } });
    if (body.method === "tools/call")
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
    throw new Error("unexpected method " + body.method);
  });
}

test("下游工具失败：抛成可读错误（含 requestId），不是把 JSON 当数据", async () => {
  const { transport } = envelopeTransport({
    retryable: false,
    traceId: "63ebc93d-eac1-4ff0-b978-bd49df230322",
    auditId: "0de9fbd3-1535-45f5-adf5-71f6aee157a0",
    businessCode: "MCP_UPSTREAM_TOOL_ERROR",
    code: "MCP_UPSTREAM_TOOL_ERROR",
    success: false,
    requestId: "37fff70a-0705-4f82-892c-41b10229096e",
    suggestedAction: "CHECK_UPSTREAM_LOGS",
    message: "下游工具执行失败，请按 requestId 查看下游工具错误记录",
    category: "UPSTREAM",
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  await assert.rejects(
    () => module.call("t", {}, new AbortController().signal),
    (error) => {
      assert.match(error.message, /GEA_MCP_TOOL_ERROR/);
      assert.match(error.message, /下游工具执行失败/);
      assert.match(error.message, /requestId=37fff70a-0705-4f82-892c-41b10229096e/);
      // retryable:false → 不许原样自动重试，但可发起新的一次调用（不再用一句
      // "不要换参数重试"盖住所有错误类型）。
      assert.match(error.message, /不要原样自动重试/);
      assert.equal(error.message.includes("不要换参数重试"), false);
      return true;
    },
  );
});

// 线上真实结构：失败藏在 structuredContent 里，而且 content[].text 是**对象**。
test("structuredContent + 对象 text 的校验失败：给字段路径并允许改参数重调", async () => {
  const envelope = {
    retryable: false,
    traceId: "9354475a-5081-4520-821f-701414a89e46",
    auditId: "07d7c69d-d7c3-4089-825f-bb42477f12ff",
    businessCode: "AI_SCHEMA_INVALID",
    code: "AI_SCHEMA_INVALID",
    success: false,
    requestId: "54fa2ee8-fd5d-421a-a7d2-a830e0f876cc",
    suggestedAction: "FIX_ARGUMENTS",
    details: { stage: "ARGUMENT_VALIDATION", path: "queries[0].query.order" },
    message:
      "queries[0].query.order：order 数组元素必须为 [成员,方向]；推荐使用对象 {成员名: asc或desc}",
    category: "VALIDATION",
  };
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
        result: {
          isError: true,
          structuredContent: envelope,
          content: [{ text: envelope, type: "text" }],
        },
      });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  await assert.rejects(
    () => module.call("query_business_data", {}, new AbortController().signal),
    (error) => {
      assert.match(error.message, /AI_SCHEMA_INVALID/);
      assert.match(error.message, /字段=queries\[0\]\.query\.order/);
      assert.match(error.message, /requestId=54fa2ee8-fd5d-421a-a7d2-a830e0f876cc/);
      assert.match(error.message, /建议动作=FIX_ARGUMENTS/);
      // 校验类错误必须允许改好参数后重新调用（跟"下游错误别重试"区分开）。
      assert.match(error.message, /改好参数后可以重新调用一次/);
      assert.match(error.message, /arguments\.queries/);
      assert.equal(error.message.includes("不要换参数重试"), false);
      return true;
    },
  );
});

test("text 是对象但不是失败时：内容不能丢", async () => {
  const { transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t", inputSchema: { properties: {} } }] } });
    if (body.method === "tools/call")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: { rows: [{ base: "郑州", qty: 12 }] } }] },
      });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("t", {}, new AbortController().signal);
  assert.match(value, /郑州/);
  assert.match(value, /"qty":12/);
});

// 网关把"跨模型查询"标成 AI_GATEWAY_DATA_PERMISSION_DENIED / AUTHORIZATION，
// 按"缺授权"解释会把人带沟里——必须按 message 认出来是写法问题。
test("跨模型成员被标成 PERMISSION_DENIED 时，仍按写法问题给动作", async () => {
  const { transport } = envelopeTransport({
    retryable: false,
    traceId: "1ba26e37-253d-42d6-9093-641873f7d6c6",
    auditId: "a7013311-fbeb-4617-a918-9953d6d5488d",
    businessCode: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    success: false,
    requestId: "be732058-e66e-4b63-b252-09cf230f8125",
    message: "Cube 查询成员未唯一匹配数据目录资源；模型须与 dataAssetCode 一致，跨模型查询请分别调用",
    category: "AUTHORIZATION",
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  await assert.rejects(
    () => module.call("query_business_data", {}, new AbortController().signal),
    (error) => {
      assert.match(error.message, /dataAssetCode/);
      assert.match(error.message, /拆成两次调用/);
      assert.match(error.message, /改好参数后可以重新调用一次/);
      // 不能误导成"缺授权"。
      assert.equal(error.message.includes("模块数据未授权"), false);
      assert.equal(error.message.includes("权限或数据授权没配置"), false);
      return true;
    },
  );
});

test("授权类失败：给可读业务状态、不抛红色错误", async () => {
  const { transport } = envelopeTransport({
    retryable: false,
    businessCode: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    success: false,
    requestId: "eb0a79bc-9591-45b0-a8e9-8b8f8757fb35",
    suggestedAction: "CONFIGURE_DATA_GRANTS",
    message: "匹配策略的数据授权 grants 数组为空，未配置任何数据资源授权项",
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("t", {}, new AbortController().signal);
  assert.match(value, /模块数据未授权/);
  assert.match(value, /CONFIGURE_DATA_GRANTS/);
  assert.match(value, /不要换模块或换写法重试/);
});

test("正常返回体带 code:OK 时不能被误判成失败", async () => {
  const { transport } = envelopeTransport({
    agentId: "full-chain-inventory",
    code: "OK",
    message: "解析成功",
    realName: "陈勇浩",
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("t", {}, new AbortController().signal);
  assert.match(value, /解析成功/);
});

// 服务端 schema 是唯一契约来源：摘要照旧，完整定义按工具名两级读取，并有字节上限。
const SCHEMA_TOOLS = [
  {
    name: "query_business_data",
    description: "检查 Cube 语义模型或执行调用方明确提交的 Cube JSON Query。",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["inspect", "query"],
          description: "inspect 读取完整公开语义模型；query 执行具名查询。",
        },
        queries: {
          type: "array",
          description: "query 时传 1 到 8 个具名 Cube JSON Query。",
          items: { type: "object", properties: {} },
        },
        response_mode: {
          type: "string",
          enum: ["resource", "inline_complete"],
        },
      },
      required: ["action", "queries"],
    },
  },
];

function schemaTransport(tools) {
  return fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id: body.id, result: { tools } });
    throw new Error("unexpected method " + body.method);
  });
}

test("摘要只给字段名，完整定义按工具名展开（含类型/枚举/必填）", async () => {
  const { transport } = schemaTransport(SCHEMA_TOOLS);
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const summary = module.tools()[0];
  assert.deepEqual(summary.parameters, ["action", "queries", "response_mode"]);
  assert.deepEqual(summary.required, ["action", "queries"]);

  const full = module.schema("query_business_data");
  assert.match(full, /必填参数：action、queries/);
  assert.match(full, /枚举：inspect\|query/);
  assert.match(full, /枚举：resource\|inline_complete/);
  assert.match(full, /数组，元素结构服务端未声明/); // 空壳 schema 要如实说，不替服务端编
  assert.equal(module.schema("no_such_tool"), undefined);
});

test("服务端 schema 很大时，完整定义也不能超过上限", async () => {
  const huge = {
    name: "wide",
    description: "字段很多的工具",
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `field_${index}`,
          { type: "string", description: "说明".repeat(20) },
        ]),
      ),
      required: ["field_0"],
    },
  };
  const { transport } = schemaTransport([huge]);
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const full = module.schema("wide");
  assert.ok(full.length <= 2100, `schema 太大：${full.length}`);
  assert.match(full, /定义过长已截断/);
});

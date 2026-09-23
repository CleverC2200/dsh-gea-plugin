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

// 线上实测：大结果（37 万字符的查询制品）以前只内联前 12,000 字符，而且**不说明被截断**，
// 模型可能拿开头那一段当全量。现在：第一段 + 明确写着还有多少、下一段怎么读，
// 完整正文留在宿主缓存里按需分段取，不用重跑整条查询。
test("大结果只内联一段，并说清还有多少、下一段怎么读（不用重新查）", async () => {
  const big = JSON.stringify({
    rows: Array.from({ length: 1500 }, (_, index) => ({
      id: index,
      material_code: "SKU" + index,
      qty: index * 2,
    })),
  });
  assert.ok(big.length > 30_000, "测试数据要够大：" + big.length);
  const uri = "data-artifact://gateway/big-result";
  const { seen, transport } = fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "query_business_data", inputSchema: { properties: {} } }] } });
    if (body.method === "tools/call")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { isError: false, content: [{ type: "resource_link", uri, mimeType: "application/json" }] },
      });
    if (body.method === "resources/read")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { contents: [{ uri: body.params.uri, mimeType: "application/json", text: big }] },
      });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("query_business_data", { action: "query" }, new AbortController().signal);
  assert.ok(value.length <= 20_000, "单次结果不能超上限：" + value.length);
  assert.match(value, /只内联了前 \d+ 字符/);
  assert.match(value, new RegExp(`全文 ${big.length} 字符`));
  assert.match(value, /artifact="data-artifact:\/\/gateway\/big-result"/);
  assert.match(value, /offset=\d+/);
  assert.match(value, /不要重复整条大查询/);
  // 第一段确实是正文开头。
  const firstChunk = Number(/只内联了前 (\d+) 字符/.exec(value)[1]);
  assert.equal(value.includes(big.slice(0, 200)), true);

  // 第二段按 offset 取，命中的是缓存，不再打一次 resources/read。
  const next = await module.chunk(uri, firstChunk, 12_000, new AbortController().signal);
  assert.match(next, new RegExp(`字符 ${firstChunk}–${firstChunk + 12_000} / 共 ${big.length}`));
  assert.equal(next.includes(big.slice(firstChunk, firstChunk + 200)), true);
  assert.equal(seen.filter((item) => item.method === "resources/read").length, 1);
  // 读到结尾要明确说"已到结尾"，不能让人以为还有。
  const tail = await module.chunk(uri, big.length - 10, 12_000, new AbortController().signal);
  assert.match(tail, /已到结尾/);
});

test("一次返回多个制品时，没内联的那些要把 URI 报出来（别直接丢）", async () => {
  const links = ["a", "b", "c"].map((id) => `data-artifact://gateway/${id}`);
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
          isError: false,
          content: links.map((uri) => ({ type: "resource_link", uri, mimeType: "application/json" })),
        },
      });
    if (body.method === "resources/read")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { contents: [{ uri: body.params.uri, mimeType: "application/json", text: '{"rows":[]}' }] },
      });
    throw new Error("unexpected method " + body.method);
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("query_business_data", { action: "query" }, new AbortController().signal);
  assert.match(value, /还返回了 1 个制品没有内联/);
  assert.match(value, /data-artifact:\/\/gateway\/c/);
  assert.match(value, /artifact=<URI>/);
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
      // 线上实测：网关把下游真实原因吞了（成员名写错、查询计划被拒都长这样），
      // 所以文案不能再写"不是参数问题"，要先让模型自查成员名与 measures。
      assert.equal(error.message.includes("不是参数问题"), false);
      assert.match(error.message, /成员名是否逐字来自目录/);
      assert.match(error.message, /写进了 measures/);
      // retryable:false → 只允许"改好再发起新调用"，不给"可原样重试"的口子。
      assert.equal(error.message.includes("可按同一参数重试"), false);
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

/** 一个"网关把数据集包成字符串"的制品，跟线上原样结构一致（键名在原文里是转义的）。 */
function pageArtifact({ datasetName, totalRows, rows, pad = 0 }) {
  const inner = JSON.stringify({
    artifactId: "query-756673fc1a8e4fbfa7f05be418cf28db",
    datasetName,
    page: 1,
    pageSize: 200,
    totalRows,
    rows: [...rows, ...(pad ? ["x".repeat(pad)] : [])],
  });
  return JSON.stringify({
    queryArtifact: {
      schemaVersion: "3.0",
      hydrated: true,
      resources: [{ pageCount: 1, contents: [{ text: inner }] }],
    },
  });
}

function artifactTransport(uri, artifact) {
  return fakeTransport((body) => {
    if (body.method === "initialize")
      return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params.protocolVersion } });
    if (body.method === "notifications/initialized") return new Response("", { status: 202 });
    if (body.method === "tools/list")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [{ name: "query_business_data", inputSchema: { properties: {} } }] },
      });
    if (body.method === "tools/call")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { isError: false, content: [{ type: "resource_link", uri, mimeType: "application/json" }] },
      });
    if (body.method === "resources/read")
      return json({
        jsonrpc: "2.0",
        id: body.id,
        result: { contents: [{ uri: body.params.uri, mimeType: "application/json", text: artifact }] },
      });
    throw new Error("unexpected method " + body.method);
  });
}

// 线上实测：totalRows / complete=true / hasMore=false 都不能证明取全了——limit=10 时 totalRows 就回 10
// （把 limit 原样回显），而 offset 翻页还能翻到全新的一页、两页零重叠。结果里要当场把这件事说清楚。
test("行数正好等于 limit 时说清“别把这一页当全量”，同一段重复读要拦一下", async () => {
  const uri = "data-artifact://gateway/38789c1e";
  const artifact = pageArtifact({
    datasetName: "zz_dumpling",
    totalRows: 100,
    rows: [{ "agents_scm_safety_stock.material_name": "CX495g手打天下猪肉白菜水饺（12袋）" }],
  });
  const { seen, transport } = artifactTransport(uri, artifact);
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call(
    "query_business_data",
    {
      action: "query",
      response_mode: "resource",
      queries: [
        {
          name: "zz_dumpling",
          query: { dimensions: ["agents_scm_safety_stock.material_name"], limit: 100 },
        },
      ],
    },
    new AbortController().signal,
  );
  assert.match(value, /totalRows=100/);
  assert.match(value, /正好等于你给的 limit=100/);
  assert.match(value, /别把这一页当全量/);
  // 列比 limit 小（真取全了）时不能乱提示。
  assert.equal(value.includes("offset 翻页"), true);

  const again = await module.chunk(uri, 0, 12_000, new AbortController().signal);
  assert.match(again, /你刚读过/);
  assert.match(again, /offset=\d+/);
  // 重复读命中的是宿主缓存，不再打一次 resources/read。
  assert.equal(seen.filter((item) => item.method === "resources/read").length, 1);
});

test("取全了（行数小于 limit）时不提示截断", async () => {
  const uri = "data-artifact://gateway/small";
  const artifact = pageArtifact({
    datasetName: "zz_latest",
    totalRows: 12,
    rows: [{ "agents_scm_safety_stock.material_name": "思念1kg冷鲜肉水饺" }],
  });
  const { transport } = artifactTransport(uri, artifact);
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call(
    "query_business_data",
    { action: "query", queries: [{ name: "zz_latest", query: { limit: 100 } }] },
    new AbortController().signal,
  );
  assert.equal(value.includes("别把这一页当全量"), false);
});

test("制品贴着授权上限时先提醒缩口径，而不是等网关整批拒掉", async () => {
  const uri = "data-artifact://gateway/wide";
  const artifact = pageArtifact({
    datasetName: "wide",
    totalRows: 3,
    rows: [],
    pad: 200_000,
  });
  assert.ok(artifact.length > 180_000);
  const { transport } = artifactTransport(uri, artifact);
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call(
    "query_business_data",
    { action: "query", queries: [{ name: "wide", query: { limit: 300 } }] },
    new AbortController().signal,
  );
  assert.ok(value.length <= 20_000, "单次结果不能超上限：" + value.length);
  assert.match(value, /贴着数据授权上限/);
  assert.match(value, /只取真正用得上的 2–4 列/);
});

test("限流：HTTP 200 + 业务信封也认，给等待建议而不是让人改参数", async () => {
  // 同事核对的 GEA 实现：REST /call 回 429 + Retry-After，但标准 MCP 的工具业务失败
  // 走 HTTP 200 + 失败信封。只处理 HTTP 码会漏掉这一半。
  const envelope = {
    retryable: true,
    retryAfterMs: 2000,
    businessCode: "AI_GATEWAY_RATE_LIMITED",
    code: "AI_GATEWAY_RATE_LIMITED",
    success: false,
    message: "请求过于频繁，请稍后重试",
    category: "RATE_LIMIT",
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
      assert.match(error.message, /GEA_MCP_RATE_LIMITED/);
      assert.match(error.message, /等约 2 秒再试/);
      assert.match(error.message, /不是参数问题/);
      assert.match(error.message, /不要立刻原样重试/);
      // 限流不能被说成"改好参数后可以重新调用一次"
      assert.equal(error.message.includes("改好参数后可以重新调用一次"), false);
      return true;
    },
  );
});

test("权限失败要保留 details 里的诊断项，说清缺的是哪一项", async () => {
  // GEA 把 reasonCode/resourceCode/configurationPath/decisionId 放在 details 里，
  // suggestedAction 在信封顶层。少一项就只能回"没权限"，没人知道该配什么。
  const { transport } = envelopeTransport({
    retryable: false,
    code: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    businessCode: "AI_GATEWAY_DATA_PERMISSION_DENIED",
    success: false,
    suggestedAction: "CONFIGURE_DATA_GRANTS",
    message: "本次匹配到的访问策略中没有该资源的 ALLOW 授权",
    details: {
      reasonCode: "RESOURCE_ALLOW_MISSING",
      resourceCode: "agents_scm_inventory_age-cube",
      configurationPath: "策略 v7 / 资源授权",
      decisionId: "07d7c69d-d7c3-4089-825f-bb42477f12ff",
    },
  });
  const module = await m.openModuleMcp(transport, new AbortController().signal);
  const value = await module.call("query_business_data", {}, new AbortController().signal);
  assert.match(value, /模块数据未授权/);
  assert.match(value, /reasonCode=RESOURCE_ALLOW_MISSING/);
  assert.match(value, /资源=agents_scm_inventory_age-cube/);
  assert.match(value, /授权项=07d7c69d/);
  assert.match(value, /配置位置=策略 v7/);
});

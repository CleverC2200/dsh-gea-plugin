import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/shared/gea-stream.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { geaTextStream, geaUsage } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
const encoder = new TextEncoder();
const event = (delta, finish = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\r\n\r\n`;
const collect = async (source) => {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
};

test("SSE framing preserves split UTF-8 and multiline data in the final text block", async () => {
  const bytes = encoder.encode(
    ": heartbeat\r\n\r\n" +
      event({ reasoning_content: "private reasoning" }) +
      event({ content: "中文" }) +
      'data: {\r\ndata: "choices": [{"delta": {"content": "尾段"}, "finish_reason": "stop"}]\r\ndata: }\r\n\r\n',
  );
  let cancelled = 0;
  let offset = 0;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(bytes.slice(offset, ++offset));
    },
    cancel() {
      cancelled++;
    },
  });
  const chunks = await collect(geaTextStream(body));
  assert.deepEqual(chunks.find((chunk) => chunk.type === "block-end").block, {
    type: "text",
    text: "中文尾段",
  });
  assert.deepEqual(chunks.at(-1).reason, { kind: "stop" });
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === "block-end" && chunk.block.type === "reasoning").block,
    { type: "reasoning", text: "private reasoning" },
  );
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("EOF, unsupported tools, unknown terminal reasons and reasoning-only stops fail closed", async () => {
  for (const [wire, expected] of [
    [event({ content: "partial" }), "GEA_MODEL_INCOMPLETE_STREAM"],
    [event({ content: "partial" }) + "data: [DONE]\n\n", "GEA_MODEL_INCOMPLETE_STREAM"],
    [event({ tool_calls: [{ id: "call-1" }] }), "GEA_MODEL_UNSUPPORTED_TOOL_CALL"],
    [event({ content: "partial" }, "tool_calls"), "GEA_MODEL_INVALID_TOOL_CALL"],
    [event({ content: "partial" }, "content_filter"), "GEA_MODEL_UNSUPPORTED_FINISH_REASON"],
    [event({ reasoning_content: "reasoning only" }, "stop"), "GEA_MODEL_EMPTY_RESPONSE"],
  ]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        controller.close();
      },
    });
    await assert.rejects(collect(geaTextStream(body)), new RegExp(expected));
    assert.equal(body.locked, false);
  }
});

test("abort cancels a pending read and returning early releases the reader", async () => {
  for (const mode of ["abort", "return"]) {
    let cancelled = 0;
    const body = new ReadableStream({
      cancel() {
        cancelled++;
      },
    });
    const controller = new AbortController();
    const iterator = geaTextStream(body, controller.signal);
    assert.equal((await iterator.next()).value.type, "block-start");
    if (mode === "abort") {
      const pending = iterator.next();
      controller.abort();
      await assert.rejects(pending, { name: "AbortError" });
    } else await iterator.return();
    assert.equal(cancelled, 1, mode);
    assert.equal(body.locked, false, mode);
  }
});

const streamOf = (wire) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(wire));
      controller.close();
    },
  });
const offered = { names: ["gea_sales_plan_read"], maxBytes: 2000 };
test("raw DSML protocol is never a completed business response, including split markers", async () => {
  for (const text of [
    "<｜｜DSML｜｜ calls>",
    "<｜｜DSML｜｜ tool_calls>",
    '<||DSML||invoke name="x">',
    '  <｜｜DSML｜｜ invoke name="x">',
  ]) {
    const wire = [...text].map((c) => event({ content: c })).join("") + event({}, "stop");
    await assert.rejects(
      collect(geaTextStream(streamOf(wire), undefined, offered)),
      /GEA_MODEL_TOOL_TEXT/,
    );
  }
  const valid = await collect(
    geaTextStream(streamOf(event({ content: "已取得15个SKU，单位件。" }, "stop"))),
  );
  assert.equal(valid.at(-1).reason.kind, "stop");
});
const toolDelta = (index, id, args, name = "gea_sales_plan_read") => ({
  tool_calls: [
    {
      index,
      ...(id ? { id, type: "function" } : {}),
      function: {
        ...(name ? { name } : {}),
        arguments: args,
      },
    },
  ],
});
test("interleaved tool arguments assemble into distinct validated final blocks", async () => {
  const wire =
    event({ content: "正在读取" }) +
    event(toolDelta(0, "read-0", '{"kind":"list",')) +
    event(toolDelta(1, "read-1", '{"kind":"periods"}')) +
    event(toolDelta(0, undefined, '"query":{}}', undefined)) +
    event({}, "tool_calls");
  const chunks = await collect(geaTextStream(streamOf(wire), undefined, offered));
  const blocks = chunks.filter((x) => x.type === "block-end").map((x) => x.block);
  assert.deepEqual(blocks, [
    { type: "text", text: "正在读取" },
    {
      type: "tool-call",
      id: "read-0",
      name: "gea_sales_plan_read",
      arguments: '{"kind":"list","query":{}}',
    },
    {
      type: "tool-call",
      id: "read-1",
      name: "gea_sales_plan_read",
      arguments: '{"kind":"periods"}',
    },
  ]);
  assert.equal(chunks.at(-1).reason.kind, "tool-calls");
});
test("unoffered, duplicate, changed, oversized and incomplete tools never produce executable blocks", async () => {
  const cases = [
    event(toolDelta(0, "id", "{}", "gea_approve")) + event({}, "tool_calls"),
    event(toolDelta(0, "id", "{}")) + event(toolDelta(1, "id", "{}")) + event({}, "tool_calls"),
    event(toolDelta(0, "id", "{}")) + event(toolDelta(0, "other", "")) + event({}, "tool_calls"),
    event(toolDelta(0, "id", JSON.stringify({ huge: "中".repeat(1000) }))) +
      event({}, "tool_calls"),
    event(toolDelta(0, "id", "{}")) + event({}, "stop"),
    event(toolDelta(0, "id", "{}")) + event({}, "length"),
    event(toolDelta(0, "id", "{}")),
  ];
  for (const wire of cases) {
    const chunks = [];
    await assert.rejects(async () => {
      for await (const chunk of geaTextStream(streamOf(wire), undefined, offered))
        chunks.push(chunk);
    });
    assert.equal(
      chunks.some((x) => x.type === "block-end" && x.block.type === "tool-call"),
      false,
    );
  }
});

test("invalid tool arguments fail the whole group without invented assistant text or executable blocks", async () => {
  for (const args of ['{"private":"secret-cut', "[]", "null", "42"]) {
    const chunks = [];
    await assert.rejects(async () => {
      for await (const chunk of geaTextStream(
        streamOf(
          event(toolDelta(0, "read-bad", args)) +
            event(toolDelta(1, "read-ok", "{}")) +
            event({}, "tool_calls"),
        ),
        undefined,
        offered,
      ))
        chunks.push(chunk);
    }, /GEA_MODEL_INVALID_TOOL_CALL/);
    assert.equal(
      chunks.some((x) => x.type === "block-end"),
      false,
    );
    assert.equal(JSON.stringify(chunks).includes("secret-cut"), false);
  }
});

test("流失败的报错带上人话，同时保留错误码", async () => {
  await assert.rejects(
    collect(
      geaTextStream(
        streamOf(event(toolDelta(0, "id", "{}", "gea_approve")) + event({}, "tool_calls")),
        undefined,
        offered,
      ),
    ),
    (error) => {
      assert.match(error.message, /^GEA_MODEL_INVALID_TOOL_CALL：/);
      assert.match(error.message, /不合法/);
      assert.equal(error.code, "GEA_MODEL_INVALID_TOOL_CALL");
      return true;
    },
  );
});

// 线上实测（session-c391a75f，27 步 / 44 次调用、工具结果合计 21.3 万字符）：
// 网关在流里回了错误对象，我们却报成"格式无法解析"，真因被吞。三种要分开：
test("流里的错误对象：上下文超限单独成码，不回显网关原文", async () => {
  const frame = `data: ${JSON.stringify({
    error: {
      code: "context_length_exceeded",
      type: "invalid_request_error",
      message: "This model's maximum context length is 65536 tokens",
    },
  })}\r\n\r\n`;
  await assert.rejects(collect(geaTextStream(streamOf(frame))), (error) => {
    assert.equal(error.code, "GEA_MODEL_CONTEXT_TOO_LONG");
    assert.match(error.message, /GEA_MODEL_CONTEXT_TOO_LONG/);
    assert.doesNotMatch(error.message, /maximum context length/);
    assert.match(error.message, /上下文超出模型上限/);
    return true;
  });
});

test("流里的其它网关错误：保留安全 code，不回显原文", async () => {
  const frame = `data: ${JSON.stringify({
    error: { code: "upstream_error", message: "模型服务暂时不可用" },
  })}\r\n\r\n`;
  await assert.rejects(collect(geaTextStream(streamOf(frame))), (error) => {
    assert.equal(error.code, "GEA_MODEL_GATEWAY_ERROR");
    assert.match(error.message, /upstream_error/);
    assert.doesNotMatch(error.message, /模型服务暂时不可用/);
    return true;
  });
});

test("不是 JSON 的帧：报 INVALID_SSE，只带长度", async () => {
  await assert.rejects(
    collect(geaTextStream(streamOf("data: <html>502 Bad Gateway</html>\r\n\r\n"))),
    (error) => {
      assert.equal(error.code, "GEA_MODEL_INVALID_SSE");
      assert.match(error.message, /这一帧不是 JSON/);
      assert.doesNotMatch(error.message, /502 Bad Gateway/);
      return true;
    },
  );
});

test("choices 形状不对：也要说清是哪一项不对", async () => {
  const frame = `data: ${JSON.stringify({ choices: "nope" })}\r\n\r\n`;
  await assert.rejects(collect(geaTextStream(streamOf(frame))), (error) => {
    assert.equal(error.code, "GEA_MODEL_INVALID_SSE");
    assert.match(error.message, /choices 不是数组/);
    return true;
  });
});

test("provider usage is captured after finish without inventing zero usage or double counting cache", async () => {
  assert.equal(geaUsage(undefined), undefined);
  assert.equal(geaUsage({ prompt_tokens: 100 }), undefined);
  assert.equal(
    geaUsage({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 200 }),
    undefined,
  );
  const wire =
    event({ content: "完成" }, "stop") +
    "data: " +
    JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 10 },
      },
    }) +
    "\n\ndata: [DONE]\n\n";
  const chunks = await collect(geaTextStream(streamOf(wire)));
  assert.deepEqual(chunks.find((x) => x.type === "usage").usage, {
    inputTokens: 40,
    outputTokens: 20,
    cacheReadTokens: 60,
    reasoningTokens: 10,
    totalTokens: 120,
  });
  assert.equal(chunks.at(-1).type, "finish");
});

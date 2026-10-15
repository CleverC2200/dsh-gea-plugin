import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/host/api-log.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { GeaApiLogCenter } = await import(
  "data:text/javascript;base64," +
    Buffer.from(outputFiles[0].contents).toString("base64")
);

const json = (value, init = {}) =>
  Response.json(value, {
    ...init,
    headers: { "X-Trace-Id": "trace-1", ...init.headers },
  });

test("records known APIs and never exposes credentials", async () => {
  const calls = [];
  const center = new GeaApiLogCenter(
    () => "test",
    500,
    async (input, init) => {
      calls.push({ input: String(input), init });
      return json(
        {
          success: true,
          result: {
            id: "user-1",
            access_token: "response-secret",
            sessionId: "gateway-session-secret",
            qrcodeId: "qr-secret",
            credentials: "credential-secret",
            tokens: ["token-secret"],
            nested: { delegationToken: "delegation-secret" },
          },
        },
        {
          headers: { "MCP-Session-Id": "mcp-header-secret" },
        },
      );
    },
  );
  const response = await center.fetch(
    "https://gea.example/company/gea/sys/user/getUserInfo",
    {
      headers: {
        "X-Access-Token": "request-secret",
        Authorization: "Bearer bearer-secret",
      },
    },
  );
  await response.body.cancel();
  const snapshot = center.snapshot();
  assert.ok(snapshot.catalog.length >= 20);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].catalogId, "identity.profile");
  assert.equal(snapshot.records[0].outcome, "success");
  assert.equal(snapshot.records[0].source, "daily");
  assert.equal(snapshot.records[0].replayAvailable, true);
  const wire = JSON.stringify(snapshot);
  assert.equal(wire.includes("request-secret"), false);
  assert.equal(wire.includes("bearer-secret"), false);
  assert.equal(wire.includes("response-secret"), false);
  assert.equal(wire.includes("gateway-session-secret"), false);
  assert.equal(wire.includes("mcp-header-secret"), false);
  assert.equal(wire.includes("qr-secret"), false);
  assert.equal(wire.includes("credential-secret"), false);
  assert.equal(wire.includes("token-secret"), false);
  assert.equal(wire.includes("delegation-secret"), false);
  assert.match(wire, /已脱敏/);

  const replay = await center.replay(snapshot.records[0].id, false);
  assert.equal(calls.length, 2);
  const replayed = center
    .snapshot()
    .records.find((record) => record.id === replay.recordId);
  assert.equal(replayed.replayedFrom, snapshot.records[0].id);
  assert.equal(replayed.source, "replay");
});

test("idempotent writes require confirmation and retain the original intent", async () => {
  const calls = [];
  const center = new GeaApiLogCenter(
    () => "production",
    500,
    async (input, init) => {
      calls.push({
        url: String(input),
        body: init.body,
        requestId: new Headers(init.headers).get("X-Request-Id"),
        idempotencyKey: new Headers(init.headers).get("Idempotency-Key"),
      });
      return json({ success: true, result: { auditId: "audit-1" } });
    },
  );
  const body = JSON.stringify({ action: "APPROVE", expectedStatus: 1 });
  const response = await center.fetch(
    "https://gea.example/sales-plan/plans/versions/v-1/actions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "request-1",
        "Idempotency-Key": "intent-1",
        "X-Access-Token": "secret",
      },
      body,
    },
  );
  await response.body.cancel();
  const record = center.snapshot().records[0];
  assert.equal(record.replayPolicy, "idempotent");
  await assert.rejects(
    center.replay(record.id, false),
    /API_LOG_REPLAY_CONFIRMATION_REQUIRED/,
  );
  await center.replay(record.id, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], calls[0]);
});

test("identity changes disable old replay closures and the ring stays bounded", async () => {
  const center = new GeaApiLogCenter(
    () => "test",
    2,
    async () => json({ success: true, result: {} }),
  );
  for (const path of [
    "/sys/user/getUserInfo",
    "/sys/permission/getPermCode",
    "/sales-plan/plans?pageNo=1&pageSize=20",
  ]) {
    const response = await center.fetch("https://gea.example" + path);
    await response.body.cancel();
  }
  assert.equal(center.snapshot().records.length, 2);
  assert.ok(
    center.snapshot().records.every((record) => record.replayAvailable),
  );
  center.invalidateReplays();
  assert.ok(
    center.snapshot().records.every((record) => !record.replayAvailable),
  );
  await assert.rejects(
    center.replay(center.snapshot().records[0].id, false),
    /API_LOG_REPLAY_UNAVAILABLE/,
  );
});

test("concurrent calls cannot steal a replay's source relationship", async () => {
  let calls = 0;
  let center;
  center = new GeaApiLogCenter(
    () => "test",
    10,
    async () => {
      calls++;
      if (calls === 2) {
        const nested = await center.fetch(
          "https://gea.example/sys/permission/getPermCode",
        );
        await nested.body.cancel();
      }
      return json({ success: true, result: {} });
    },
  );
  const original = await center.fetch(
    "https://gea.example/sys/user/getUserInfo",
  );
  await original.body.cancel();
  const source = center.snapshot().records[0];
  const replay = await center.replay(source.id, false);
  const records = center.snapshot().records;
  const replayed = records.find((record) => record.id === replay.recordId);
  const nested = records.find(
    (record) => record.catalogId === "identity.permissions",
  );
  assert.equal(replayed.catalogId, "identity.profile");
  assert.equal(replayed.replayedFrom, source.id);
  assert.equal(nested.replayedFrom, undefined);
  assert.equal(nested.source, "daily");
  assert.equal(replayed.source, "replay");
});

test("streaming and oversized response bodies are summarized instead of buffered into logs", async () => {
  for (const [response, expected] of [
    [
      new Response("data: secret\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
      "流式响应正文未保存",
    ],
    [
      new Response("x".repeat(5 * 1024 * 1024), {
        headers: { "Content-Type": "text/plain" },
      }),
      "正文超过 4 MiB",
    ],
  ]) {
    const center = new GeaApiLogCenter(
      () => "test",
      10,
      async () => response,
    );
    const result = await center.fetch(
      response.headers.get("content-type")?.startsWith("text/event-stream")
        ? "https://model.example/chat/completions"
        : "https://fixture/unknown-json",
      {
        method: "POST",
        body: "{}",
      },
    );
    await result.body.cancel();
    assert.match(
      String(center.snapshot().records[0].response.body),
      new RegExp(expected),
    );
  }
});

test("authorized resource discovery is classified, redacted and cannot replay short-lived credentials", async () => {
  const center = new GeaApiLogCenter(
    () => "test",
    20,
    async () => Response.json({ success: true, resources: [] }),
  );
  const response = await center.fetch(
    "https://fixture/ai/gateway/mcp/proxy/resources",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentCode: "sales_forecast",
        mcpCode: "cube",
        toolName: "query_business_data",
        delegationToken: "private-delegation",
        sessionId: "private-session",
        conversationId: "conversation",
      }),
    },
  );
  await response.text();
  const snapshot = center.snapshot();
  assert.equal(snapshot.records[0].catalogId, "gateway.authorized-resources");
  assert.equal(snapshot.records[0].replayAvailable, false);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private-delegation|private-session/,
  );
  await assert.rejects(center.replay(snapshot.records[0].id, false), /REPLAY/);
});

test("model request/history and JSON response text stay out of the API log snapshot", async () => {
  const center = new GeaApiLogCenter(
    () => "test",
    500,
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "PRIVATE_ANSWER_SENTINEL",
                reasoning_content: "PRIVATE_REASONING_SENTINEL",
              },
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  const response = await center.fetch("https://fixture/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "model-id",
      messages: [
        {
          role: "assistant",
          content: "PRIVATE_PROMPT_SENTINEL",
          reasoning_content: "PRIVATE_HISTORY_SENTINEL",
          tool_calls: [
            { function: { arguments: "PRIVATE_ARGUMENTS_SENTINEL" } },
          ],
        },
      ],
    }),
  });
  assert.match(
    await response.text(),
    /PRIVATE_REASONING_SENTINEL/,
    "the model adapter still owns the original response",
  );
  const snapshot = JSON.stringify(center.snapshot());
  assert.doesNotMatch(
    snapshot,
    /PRIVATE_(?:ANSWER|REASONING|PROMPT|HISTORY|ARGUMENTS)_SENTINEL/,
  );
  assert.equal(center.snapshot().records[0].replayAvailable, false);
});

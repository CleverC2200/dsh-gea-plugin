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
      return json({
        success: true,
        result: {
          id: "user-1",
          access_token: "response-secret",
          nested: { delegationToken: "delegation-secret" },
        },
      });
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
  assert.equal(snapshot.records[0].replayAvailable, true);
  const wire = JSON.stringify(snapshot);
  assert.equal(wire.includes("request-secret"), false);
  assert.equal(wire.includes("bearer-secret"), false);
  assert.equal(wire.includes("response-secret"), false);
  assert.equal(wire.includes("delegation-secret"), false);
  assert.match(wire, /已脱敏/);

  const replay = await center.replay(snapshot.records[0].id, false);
  assert.equal(calls.length, 2);
  const replayed = center
    .snapshot()
    .records.find((record) => record.id === replay.recordId);
  assert.equal(replayed.replayedFrom, snapshot.records[0].id);
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
      "https://model.example/chat/completions",
      { method: "POST", body: "{}" },
    );
    await result.body.cancel();
    assert.match(
      String(center.snapshot().records[0].response.body),
      new RegExp(expected),
    );
  }
});

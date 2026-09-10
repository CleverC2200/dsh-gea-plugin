import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { startAionUiWire } from "../scripts/aionui-wire.mjs";

test("AionUi wire converts text blocks without losing text and rejects non-text input", async (t) => {
  let body;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.setHeader("Content-Type", "text/event-stream");
    res.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const wire = await startAionUiWire({
    baseUrl: `http://127.0.0.1:${upstream.address().port}/personal/test`,
    credential: "fixture-key",
    model: "fixture-model",
    contextWindow: 32768,
  });
  t.after(async () => {
    await wire.close();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
  });
  const call = (content, extra = {}) =>
    fetch(wire.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + wire.credential,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "fixture-model",
        stream: true,
        messages: [{ role: "user", content }],
        ...extra,
      }),
    });
  const response = await call([
    { type: "text", text: "1.2300\n" },
    { type: "text", text: "2.3400" },
  ]);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "data: [DONE]\n\n");
  assert.equal(body.messages[0].content, "1.2300\n2.3400");
  assert.equal(
    (
      await call([
        { type: "image_url", image_url: { url: "https://example.test/a.png" } },
      ])
    ).status,
    400,
  );
  assert.equal((await call("test", { tools: {} })).status, 400);
  assert.equal(
    (await call("test", { tools: [{ type: "function" }] })).status,
    400,
  );
  assert.equal(
    (
      await fetch(wire.baseUrl + "/chat/completions", {
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
  );
});

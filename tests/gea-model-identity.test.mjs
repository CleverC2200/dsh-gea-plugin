import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { profile, readSession } from "./profile.mjs";

test("the public model catalog follows GEA identity without rewriting Session selection", {
  skip: process.env.GEA_TEST_SOURCE_CORE !== "1", timeout: 90000,
}, async t => {
  const app = await profile(t, { config: () => ({
    analysis: { mode: "model", source: "gea", agentCode: "sales_forecast", model: "original-model", contextWindow: 32768, maxTokens: 2048 },
  }) });
  let model = "first-model";
  app.route((request, response, reply) => {
    const path = request.url.pathname;
    if (path === "/gea/aidata/user-agent-credential/my/list") {
      reply({ success: true, result: { records: [{ id: "credential-1", status: "ACTIVE" }] } });
    } else if (path === "/gea/aidata/user-agent-credential/my/claim") {
      reply({ success: true, result: { credentialId: "credential-1", status: "ACTIVE", baseUrl: app.base + "/personal", secret: "fixture-only-secret" } });
    } else if (path === "/personal/models") {
      assert.equal(request.headers["x-gea-agent-code"], "sales_forecast");
      reply({ data: [{ id: model, name: model === "first-model" ? "首次目录模型" : "新身份目录模型" }] });
    } else return false;
    return true;
  });
  const catalog = async () => {
    const response = await fetch(app.origin + "/api/session/modelCatalog", {
      method: "POST", headers: { "Content-Type": "application/json", Cookie: app.cookie, Origin: app.origin },
      body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "session/modelCatalog", payload: { args: {} } }),
    });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const absent = value => {
    assert.equal(value.groups.some(group => group.id === "gea-analysis"), false);
    assert.equal(value.failures.some(group => group.id === "gea-analysis"), false, "anonymous GEA must withdraw its route rather than cache LOGIN_REQUIRED in the UI");
  };
  absent(await catalog());
  assert.equal((await app.login()).ok, true);
  const initial = await catalog();
  assert.deepEqual(initial.groups.find(group => group.id === "gea-analysis").models.map(row => [row.id, row.name]), [["first-model", "首次目录模型"]]);
  const created = await app.remote("session/create", { cwd: app.runtime + "/workspace" });
  assert.equal(created.ok, true, JSON.stringify(created));
  const sessionId = created.value.sessionId;
  assert.equal((await app.remote("session/selectModel", { sessionId, provider: "gea-analysis", model: "first-model" })).ok, true);
  const selected = await readSession(app.runtime, sessionId);
  const selectedDefault = (await catalog()).default;
  assert.equal((await app.rpc("logout")).ok, true);
  absent(await catalog());
  model = "second-model";
  assert.equal((await app.login()).ok, true);
  const next = await catalog();
  assert.deepEqual(next.groups.find(group => group.id === "gea-analysis").models.map(row => [row.id, row.name]), [["second-model", "新身份目录模型"]]);
  assert.deepEqual(next.default, selectedDefault, "directory refresh must preserve the user's selected default intent");
  assert.deepEqual(await readSession(app.runtime, sessionId), selected, "identity changes must preserve the durable Session and selected model intent");
  assert.equal(app.requests.some(request => request.url.pathname.endsWith("/chat/completions")), false);
});

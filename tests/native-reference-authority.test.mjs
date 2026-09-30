import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

test("native references require a registered surface, current page context and current business identity", { timeout: 60000 }, async t => {
  const app = await profile(t);
  await app.login();
  const session = (await app.remote("session/create", { cwd: app.runtime + "/workspace", agentPreset: "gea-readonly" })).value.sessionId;
  const save = async (surface, sessionId = session) => {
    const generation = await (await fetch(app.origin + "/api/page-interaction/binding", { headers: { Cookie: app.cookie } })).json();
    return fetch(app.origin + "/api/page-interaction/reference", { method: "POST", headers: { Cookie: app.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ...generation, sessionId, surface, page: "测试页面", label: "行", text: "数量：1", targets: [], capturedAt: new Date().toISOString() }) });
  };
  await app.rpc("surface", { sessionId: session, menu: "gea-proof" });
  assert.equal((await save("gea-workbench")).status, 200);
  assert.equal((await save("unknown-surface")).status, 400);
  assert.equal((await save("gea-regional-plan")).status, 400, "another Native page cannot borrow this Session's context");
  assert.equal((await save("gea-workbench", "session-00000000-0000-0000-0000-000000000000")).status, 400);
  for (const surface of ["gea-regional-plan", "plan-region-category", "plan-category-production"]) {
    await app.rpc("surface", { sessionId: session, menu: surface });
    assert.equal((await save(surface)).status, 200, "actual registered Native consumers remain usable without an HTML lease");
  }
  await app.rpc("logout");
  assert.equal((await save("plan-category-production")).status, 400);
  await app.login();
  assert.equal((await save("plan-category-production")).status, 400, "identity changes invalidate the previous Native page context");
  await app.rpc("surface", { sessionId: session, menu: "plan-category-production" });
  assert.equal((await save("plan-category-production")).status, 200);
});

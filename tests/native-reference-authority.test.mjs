import test from "node:test";
import assert from "node:assert/strict";
import { createBusinessSession, fixtureRequest } from "./fixtures/business-session.mjs";
import { profile } from "./profile.mjs";

test(
  "native references require a registered surface, current page context and current business identity",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    await app.login();
    const session = await createBusinessSession(app);
    const open = () =>
      fixtureRequest(app, "/api/agent-workbench/page", {
        operation: "open",
        pageId: "gea-proof",
        sessionId: session,
        resourceId: "gea-readonly",
      });
    const connected = await open();
    assert.equal(connected.ok, true, JSON.stringify(connected));
    let owner = connected.value.owner;
    const save = async (surface, sessionId = session) => {
      const generation = await (
        await fetch(app.origin + "/api/page-interaction/binding", {
          headers: { Cookie: app.cookie },
        })
      ).json();
      return fetch(app.origin + "/api/page-interaction/reference", {
        method: "POST",
        headers: { Cookie: app.cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          ...generation,
          owner,
          sessionId,
          surface,
          page: "测试页面",
          label: "行",
          text: "数量：1",
          targets: [],
          capturedAt: new Date().toISOString(),
        }),
      });
    };
    assert.equal(
      (await save("gea-workbench")).status,
      200,
      "the registered Native consumer remains usable without an HTML lease",
    );
    assert.equal((await save("unknown-surface")).status, 400);
    assert.equal(
      (await save("gea-regional-plan")).status,
      400,
      "another page cannot borrow this Session's context",
    );
    assert.equal(
      (await save("gea-workbench", "session-00000000-0000-0000-0000-000000000000")).status,
      400,
    );
    for (const surface of [
      "gea-regional-plan",
      "plan-region-category",
      "plan-category-production",
    ]) {
      assert.equal(
        (await save(surface)).status,
        400,
        "static planning prototypes cannot claim the Native business owner's authority",
      );
    }
    await app.rpc("logout");
    assert.equal((await save("gea-workbench")).status, 400);
    await app.login();
    assert.equal(
      (await save("gea-workbench")).status,
      400,
      "identity changes invalidate the previous Native page owner",
    );
    const renewed = await open();
    assert.equal(renewed.ok, true, JSON.stringify(renewed));
    owner = renewed.value.owner;
    assert.equal((await save("gea-workbench")).status, 200);
  },
);

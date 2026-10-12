import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { waitForNativeOwner } from "./fixtures/native-page.mjs";

const session = "session-11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";

class BrowserPage extends EventEmitter {
  association = undefined;
  operations = [];
  evaluate(_read, id) {
    this.operations.push("presentation/read");
    return Promise.resolve(this.association?.page === id ? this.association : undefined);
  }
  waitForResponse(predicate) {
    this.operations.push("response/observe");
    return new Promise((resolve, reject) => {
      const observe = async (response) => {
        try {
          if (!(await predicate(response))) return;
          this.off("response", observe);
          resolve(response);
        } catch (error) {
          this.off("response", observe);
          reject(error);
        }
      };
      this.on("response", observe);
    });
  }
}
function pageOpen({
  sessionId = session,
  pageId = "gea-proof",
  resourceId = "gea-readonly",
  status = 200,
  body = { owner, binding: { surface: "gea-workbench", tool: "gea_page" } },
} = {}) {
  return {
    url: () => "http://127.0.0.1:12345/api/agent-workbench/page",
    request: () => ({ postDataJSON: () => ({ operation: "open", pageId, sessionId, resourceId }) }),
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  };
}
function associate(page) {
  page.association = {
    page: "gea-proof",
    sessionId: session,
    preset: "gea-readonly",
    active: true,
  };
}

test("initial native visibility and an active association cannot replace the current owner receipt", async () => {
  const page = new BrowserPage();
  let returned = false;
  const ready = waitForNativeOwner(page, "gea-proof", "gea-readonly").then(() => {
    returned = true;
  });
  await setImmediate();
  assert.equal(returned, false, "a visible unassociated native frame is still preparing");
  associate(page);
  page.emit("response", pageOpen({ sessionId: "session-33333333-3333-4333-8333-333333333333" }));
  page.emit("response", pageOpen({ pageId: "inventory-fc" }));
  await setImmediate();
  assert.equal(returned, false, "association and stale or different-page owners are insufficient");
  page.emit("response", pageOpen());
  await ready;
  assert.equal(returned, true);
  assert.ok(
    page.operations.every((operation) =>
      ["presentation/read", "response/observe"].includes(operation),
    ),
  );
  assert.equal(page.listenerCount("response"), 0);
});

test("the current owner authorization failure rejects instead of accepting the frame", async () => {
  const page = new BrowserPage();
  associate(page);
  const ready = waitForNativeOwner(page, "gea-proof", "gea-readonly");
  const rejected = assert.rejects(ready, /PAGE_ACCESS_DENIED/);
  page.emit("response", pageOpen({ status: 403, body: { error: "PAGE_ACCESS_DENIED" } }));
  await rejected;
});

test("a successful HTTP response without an owner does not claim readiness", async () => {
  const page = new BrowserPage();
  associate(page);
  const ready = waitForNativeOwner(page, "gea-proof", "gea-readonly");
  const rejected = assert.rejects(ready, /NATIVE_PAGE_OWNER_UNAVAILABLE/);
  page.emit("response", pageOpen({ body: { binding: { surface: "gea-workbench" } } }));
  await rejected;
});

test("an owner receipt without the declared binding rejects", async () => {
  const page = new BrowserPage();
  associate(page);
  const ready = waitForNativeOwner(page, "gea-proof", "gea-readonly");
  const rejected = assert.rejects(ready, /NATIVE_PAGE_BINDING_UNAVAILABLE/);
  page.emit("response", pageOpen({ body: { owner } }));
  await rejected;
});

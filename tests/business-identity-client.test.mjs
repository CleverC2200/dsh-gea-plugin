import test from "node:test";
import assert from "node:assert/strict";
import { createBusinessIdentityReader } from "../src/business-identity-client.ts";

test("page and observer reads share one identity, ignore older replies and stop after cancellation", async t => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; });
  globalThis.window = new EventTarget();
  const pending = [], changes = [];
  window.addEventListener("gea-business-identity-changed", () => changes.push("changed"));
  globalThis.fetch = () => {
    const request = Promise.withResolvers();
    pending.push(request);
    return request.promise;
  };
  const read = createBusinessIdentityReader();
  const initial = read();
  pending[0].resolve(Response.json({ scope: "A" }));
  assert.equal(await initial, "A");
  assert.equal(changes.length, 0, "initial confirmation must preserve a legitimate restored association");
  const older = read(), newer = read();
  pending[2].resolve(Response.json({ scope: "B" }));
  assert.equal(await newer, "B");
  pending[1].resolve(Response.json({ scope: "A" }));
  assert.equal(await older, "B", "an older response cannot restore an already superseded identity");
  assert.equal(changes.length, 1);
  const controller = new AbortController();
  const cancelled = read(controller.signal);
  controller.abort();
  pending[3].resolve(Response.json({ scope: "C" }));
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(changes.length, 1, "an aborted read cannot notify mounted pages");
  await assert.rejects(read(controller.signal), { name: "AbortError" });
  assert.equal(pending.length, 4, "an already aborted owner cannot start another request");
});

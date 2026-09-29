import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "../packages/page-interaction/src/host.ts";

const input = { sessionId: "session-test", page: "页面", label: "行", surface: "fixture", text: "数量：1", targets: [], capturedAt: "fixture" };
function host(authorize) {
  const routes = new Map();
  const disposals = [];
  const scope = {
    effect(fn) { const dispose = fn(); if (dispose) disposals.push(dispose); },
    connection: { fetch: { register(options) { routes.set(options.path, options.fetch); return () => {}; } } },
    tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
  };
  const clear = apply({ ...scope, on: () => () => {}, inject: (_services, install) => install(scope) }, { authorize });
  return { clear, confirm: request => routes.get("/api/page-interaction/reference/confirm")(request), request: request => routes.get("/api/page-interaction/reference")(request), payload: async () => ({ ...input, ...(await (await routes.get("/api/page-interaction/binding")()).json()) }), dispose: () => disposals.reverse().forEach(dispose => dispose()) };
}

test("clearing references invalidates a POST already parsing, while a new authorized POST can succeed", async () => {
  const subject = host(() => {});
  const saved = await subject.payload();
  const body = Promise.withResolvers();
  const pending = subject.request({ json: () => body.promise });
  subject.clear();
  body.resolve(saved);
  assert.equal((await pending).status, 400);
  assert.equal((await subject.request({ json: async () => saved })).status, 400, "a POST arriving only after clear cannot reuse the old generation");
  const freshPayload = await subject.payload();
  const fresh = await subject.request({ json: async () => freshPayload });
  assert.equal(fresh.status, 200);
  assert.match((await fresh.json()).id, /^R[a-f0-9]{12}$/);
  subject.dispose();
});

test("authorization runs on the parsed POST and teardown prevents a late commit", async () => {
  let authorized = false;
  const subject = host(value => { assert.equal(value.sessionId, input.sessionId); if (!authorized) throw Error("DENIED"); });
  const saved = await subject.payload();
  assert.equal((await subject.request({ json: async () => saved })).status, 400);
  authorized = true;
  const body = Promise.withResolvers();
  const pending = subject.request({ json: () => body.promise });
  subject.dispose();
  body.resolve(saved);
  assert.equal((await pending).status, 400);
});

test("confirming a saved receipt rechecks its generation, authorization and stored surface", async () => {
  let authorized = true;
  const subject = host(() => { if (!authorized) throw Error("LEASE_EXPIRED"); });
  const payload = await subject.payload();
  const receipt = await (await subject.request({ json: async () => payload })).json();
  const confirm = { ...payload, id: receipt.id };
  assert.equal((await subject.confirm({ json: async () => confirm })).status, 200);
  authorized = false;
  assert.equal((await subject.confirm({ json: async () => confirm })).status, 400);
  authorized = true;
  assert.equal((await subject.confirm({ json: async () => ({ ...confirm, surface: "another-page" }) })).status, 400);
  const body = Promise.withResolvers();
  const pending = subject.confirm({ json: () => body.promise });
  subject.clear();
  body.resolve(confirm);
  assert.equal((await pending).status, 400, "identity clear during body parsing invalidates confirmation");
  const current = await subject.payload();
  assert.equal((await subject.confirm({ json: async () => ({ ...current, id: receipt.id }) })).status, 400,
    "using the new generation cannot restore a cleared receipt");
  subject.dispose();
});

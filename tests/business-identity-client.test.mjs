import test from "node:test";
import assert from "node:assert/strict";
import { createBusinessIdentityReader } from "../src/business-identity-client.ts";

test("page and observer reads share one identity, ignore older replies and stop after cancellation", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const pending = [],
    changes = [];
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
  assert.equal(
    changes.length,
    0,
    "initial confirmation must preserve a legitimate restored association",
  );
  const older = read(),
    newer = read();
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
  const disposing = new AbortController();
  const committing = read(disposing.signal);
  pending[4].resolve({
    ok: true,
    json: () => {
      queueMicrotask(() => queueMicrotask(() => disposing.abort()));
      return Promise.resolve({ scope: "C" });
    },
  });
  await assert.rejects(committing, { name: "AbortError" });
  assert.equal(
    changes.length,
    1,
    "disposal between parsing and publishing must not notify a newer page",
  );
});

test("concurrent initial reads share one Host request and errors never invent a login", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const pending = Promise.withResolvers();
  let requests = 0;
  globalThis.fetch = () => {
    requests++;
    return pending.promise;
  };
  const read = createBusinessIdentityReader();
  assert.equal(read.getSnapshot().state, "unknown");
  const first = read.readScope(),
    second = read.readScope(new AbortController().signal);
  assert.equal(requests, 1);
  pending.resolve(
    Response.json({
      scope: "A",
      status: {
        environment: "test",
        authenticated: true,
        loginState: "authenticated",
        user: { name: "Alice" },
      },
    }),
  );
  assert.deepEqual(await Promise.all([first, second]), ["A", "A"]);
  assert.equal(read.getSnapshot().status.user.name, "Alice");
  let notices = 0;
  const unsubscribe = read.subscribe(() => notices++);
  globalThis.fetch = async () => {
    throw Error("offline");
  };
  for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(read.refresh(), /offline/);
  assert.equal(
    read.getSnapshot().scope,
    "A",
    "a transient read failure keeps the last confirmed identity",
  );
  assert.equal(read.getSnapshot().state, "confirmed");
  assert.equal(read.getSnapshot().error, "offline");
  assert.equal(
    await read.readScope(),
    "A",
    "page opens consume the confirmed projection without another read",
  );
  assert.equal(notices, 1, "a repeated identical failure is one visible condition");
  globalThis.fetch = async () =>
    Response.json({
      scope: "A",
      status: {
        environment: "test",
        authenticated: true,
        loginState: "authenticated",
        user: { name: "Alice" },
      },
    });
  assert.equal(await read.refresh(), "A");
  assert.equal(read.getSnapshot().error, undefined);
  assert.equal(notices, 2, "recovery clears the warning even when identity is unchanged");
  unsubscribe();
});

test("a confirmed refresh wins over a late initial response", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const pending = [];
  globalThis.fetch = () => {
    const request = Promise.withResolvers();
    pending.push(request);
    return request.promise;
  };
  const read = createBusinessIdentityReader();
  const initial = read();
  const refresh = read.refresh();
  pending[1].resolve(
    Response.json({
      scope: null,
      status: { authenticated: false, loginState: "signed-out", user: null, environment: "test" },
    }),
  );
  assert.equal(await refresh, null);
  pending[0].resolve(
    Response.json({
      scope: "old",
      status: {
        authenticated: true,
        loginState: "authenticated",
        user: { name: "Old" },
        environment: "test",
      },
    }),
  );
  assert.equal(await initial, null);
  assert.equal(read.getSnapshot().status.authenticated, false);
});

test("the reader preserves the Host subject verbatim and notifies a subject change without deriving identity or writing credentials", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const requests = [],
    events = [];
  let subject = "host-canonical-A";
  window.addEventListener("gea-business-identity-changed", (event) => events.push(event.detail));
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return Response.json({
      scope: "unchanged-live-scope",
      subject,
      status: {
        authenticated: true,
        user: { name: "same display name" },
        environment: "test",
        loginState: "authenticated",
      },
      delegationToken: "must-not-be-projected",
    });
  };
  const reader = createBusinessIdentityReader();
  let notices = 0;
  reader.subscribe(() => notices++);
  await reader();
  assert.equal(reader.getSnapshot().subject, "host-canonical-A");
  subject = "host-canonical-B";
  await reader.refresh();
  assert.equal(reader.getSnapshot().subject, "host-canonical-B");
  assert.equal(notices, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].subject, "host-canonical-B");
  assert.equal(JSON.stringify(reader.getSnapshot()).includes("must-not-be-projected"), false);
  assert.ok(
    requests.every(
      (request) => request.options.method === undefined && request.options.body === undefined,
    ),
  );
});

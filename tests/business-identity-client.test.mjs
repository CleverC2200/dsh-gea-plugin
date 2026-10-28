import test from "node:test";
import assert from "node:assert/strict";
import { createBusinessIdentityReader } from "../src/business-identity-client.ts";
import { mountBusinessIdentity } from "../src/host/business-identity.ts";

test("Host user identifiers remain exact strings and notify changes without accepting numeric IDs", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const user = {
    id: "9007199254740993",
    tenantId: "0",
    username: "alice",
    name: "Alice",
    avatar: "avatar",
  };
  globalThis.fetch = async () =>
    Response.json({
      scope: "host-scope",
      subject: "host-subject",
      status: { environment: "test", authenticated: true, loginState: "authenticated", user },
    });
  const read = createBusinessIdentityReader();
  let notices = 0;
  t.after(read.subscribe(() => notices++));
  await read.refresh();
  assert.deepEqual(read.getSnapshot().status.user, user);
  user.id = "9007199254740994";
  await read.refresh();
  assert.equal(read.getSnapshot().status.user.id, user.id);
  assert.equal(notices, 2);
  user.id = 9007199254740994;
  await assert.rejects(read.refresh(), { code: "IDENTITY_INVALID_RESPONSE" });
  assert.equal(read.getSnapshot().status.user.id, "9007199254740994");
});

test("the read-only identity route exposes configured environment choices without endpoint or credential state", async (t) => {
  const routes = new Map(),
    cleanups = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === "function") cleanups.push(dispose);
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };
  t.after(() => {
    for (const dispose of cleanups.reverse()) dispose();
  });
  const status = {
    environment: "test",
    environments: ["production", "test"],
    authenticated: false,
    loginState: "signed-out",
    user: null,
    source: "must-not-be-exposed",
    token: "must-not-be-exposed",
  };
  mountBusinessIdentity(ctx, { status: () => status, pageSessionScope: () => undefined });
  const route = routes.get("/api/gea-html/identity");
  assert.deepEqual(route.methods, ["GET"]);
  const response = await route.fetch(new Request("https://fixture.invalid/api/gea-html/identity"));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    scope: null,
    subject: null,
    status: {
      environment: "test",
      environments: ["production", "test"],
      authenticated: false,
      loginState: "signed-out",
      user: null,
    },
    customerInventory: null,
  });
});

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
  pending[0].resolve(
    Response.json({
      scope: "A",
      status: { environment: "test", authenticated: true, loginState: "authenticated", user: null },
    }),
  );
  assert.equal(await initial, "A");
  assert.equal(
    changes.length,
    0,
    "initial confirmation must preserve a legitimate restored association",
  );
  const older = read(),
    newer = read();
  pending[2].resolve(
    Response.json({
      scope: "B",
      status: { environment: "test", authenticated: true, loginState: "authenticated", user: null },
    }),
  );
  assert.equal(await newer, "B");
  pending[1].resolve(
    Response.json({
      scope: "A",
      status: { environment: "test", authenticated: true, loginState: "authenticated", user: null },
    }),
  );
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
      return Promise.resolve({
        scope: "C",
        status: {
          environment: "test",
          authenticated: true,
          loginState: "authenticated",
          user: null,
        },
      });
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
  await assert.rejects(
    read.readScope(),
    /offline/,
    "new page opens require current identity confirmation",
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
      status: {
        authenticated: false,
        loginState: "signed-out",
        user: null,
        environment: "test",
        environments: ["production", "test"],
      },
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
        environment: "production",
        environments: ["production"],
      },
    }),
  );
  assert.equal(await initial, null);
  assert.equal(read.getSnapshot().status.authenticated, false);
  assert.equal(read.getSnapshot().status.environment, "test");
  assert.deepEqual(read.getSnapshot().status.environments, ["production", "test"]);
});

test("the Host environment choices notify subscribers without changing the identity scope", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  let environments = ["production"],
    notices = 0,
    identityChanges = 0;
  window.addEventListener("gea-business-identity-changed", () => identityChanges++);
  globalThis.fetch = async () =>
    Response.json({
      scope: null,
      subject: null,
      status: {
        environment: "production",
        environments,
        authenticated: false,
        loginState: "signed-out",
        user: null,
      },
    });
  const reader = createBusinessIdentityReader();
  reader.subscribe(() => notices++);
  await reader.refresh();
  await reader.refresh();
  assert.equal(notices, 1);
  environments = ["production", "test"];
  await reader.refresh();
  assert.equal(notices, 2);
  assert.deepEqual(reader.getSnapshot().status.environments, environments);
  assert.equal(identityChanges, 0, "a changed choice list does not invent a new Host identity");
  const controller = new AbortController();
  const pending = Promise.withResolvers();
  globalThis.fetch = () => pending.promise;
  const cancelled = reader.refresh(controller.signal);
  controller.abort();
  pending.resolve(
    Response.json({
      scope: null,
      status: { environment: "test", environments: ["test"], authenticated: false, user: null },
    }),
  );
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(notices, 2);
  assert.equal(reader.getSnapshot().status.environment, "production");
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

test("first connection failure stays unknown until Host recovery without emitting a logout", async (t) => {
  const originalFetch = globalThis.fetch,
    originalWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.window = originalWindow;
  });
  globalThis.window = new EventTarget();
  const events = [];
  window.addEventListener("gea-business-identity-changed", (event) => events.push(event.detail));
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const reader = createBusinessIdentityReader();
  await assert.rejects(reader(), /Failed to fetch/);
  assert.deepEqual(reader.getSnapshot(), {
    state: "unknown",
    scope: null,
    subject: null,
    status: null,
    customerInventory: null,
  });
  globalThis.fetch = async () =>
    Response.json({
      scope: "host-A",
      subject: "user-A",
      status: {
        environment: "test",
        environments: ["test"],
        authenticated: true,
        loginState: "authenticated",
        user: { name: "Alice" },
      },
    });
  await reader.refresh();
  assert.equal(reader.getSnapshot().status.user.name, "Alice");
  assert.equal(reader.getSnapshot().error, undefined);
  assert.equal(
    reader.getSnapshot().customerInventory,
    null,
    "recovery cannot invent customer grants",
  );
  assert.deepEqual(events, [], "initial recovery must not invalidate restored Sessions or drafts");
});

test("invalid identity and local HTTP authorization failures are visible immediately without inventing signed out", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const response of [
    Response.json({ unexpected: true }),
    Response.json({}, { status: 401 }),
    Response.json({}, { status: 403 }),
  ]) {
    globalThis.fetch = async () => response;
    const reader = createBusinessIdentityReader();
    await assert.rejects(reader());
    assert.equal(reader.getSnapshot().state, "error");
    assert.equal(reader.getSnapshot().status, null);
    assert.match(reader.getSnapshot().errorCode, /^IDENTITY_(INVALID_RESPONSE|HTTP_40[13])$/);
  }
});

test("startup budget is fixed across retries and publishes failure even while a request is pending", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({}, { status: 404 });
  const reader = createBusinessIdentityReader();
  await assert.rejects(reader());
  assert.equal(reader.getSnapshot().state, "unknown");
  t.mock.timers.tick(4000);
  await assert.rejects(reader());
  const pending = Promise.withResolvers();
  globalThis.fetch = () => pending.promise;
  const reading = reader.refresh();
  t.mock.timers.tick(999);
  assert.equal(reader.getSnapshot().state, "unknown");
  t.mock.timers.tick(1);
  assert.equal(reader.getSnapshot().state, "error");
  assert.equal(reader.getSnapshot().errorCode, "IDENTITY_STARTUP_TIMEOUT");
  pending.resolve(
    Response.json({
      scope: "A",
      status: { environment: "test", authenticated: true, loginState: "authenticated", user: null },
    }),
  );
  await reading;
  assert.equal(reader.getSnapshot().state, "confirmed");
  assert.equal(reader.getSnapshot().error, undefined);
});

test("a stopped observer cancels its request and a later owner cannot renew the initial budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let signal;
  globalThis.fetch = async (_path, options) => {
    signal = options.signal;
    throw new TypeError("offline");
  };
  const reader = createBusinessIdentityReader();
  const stop = reader.start();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4000);
  stop();
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(2000);
  const stopNext = reader.start();
  t.after(stopNext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reader.getSnapshot().state, "error");
});

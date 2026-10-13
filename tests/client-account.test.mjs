import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  external: ["react", "react/jsx-runtime"],
  loader: { ".css": "text" },
});
test("public account actions consume the same GEA Host identity and reject expired login without inventing client authentication", async () => {
  const module = { exports: {} };
  const endpoints = [];
  let authenticated = false;
  let pollStatus = "pending";
  let environment = "production";
  const fetch = async (url, options) => {
    endpoints.push([url, options]);
    if (url === "/api/gea-html/identity")
      return Response.json({
        scope: authenticated ? "host-owned" : null,
        status: {
          environment,
          environments: ["production", "test"],
          authenticated,
          user: authenticated ? { name: "真实Host投影" } : null,
        },
      });
    const endpoint = url.split("/").pop();
    let value;
    if (endpoint === "start") {
      environment = JSON.parse(options.body).environment;
      authenticated = false;
      value = { loginId: "host-qr", image: "data:image/png;base64,host", expiresIn: 120 };
    }
    if (endpoint === "poll") {
      authenticated = pollStatus === "authenticated";
      value = { status: pollStatus };
    }
    if (endpoint === "logout") {
      authenticated = false;
      value = { authenticated: false };
    }
    return Response.json({ ok: true, value });
  };
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    fetch,
    Response,
    AbortController,
    AbortSignal,
    CustomEvent,
    window: new EventTarget(),
    crypto: globalThis.crypto,
    console,
    setTimeout,
    clearTimeout,
  });
  const provided = new Map();
  const ctx = {
    effect: () => {},
    provide: (name, value) => provided.set(name, value),
    locale: { bind: () => (key) => key },
    slots: { inject: () => {} },
    agentWorkbench: {},
    remote: {},
  };
  module.exports.apply(ctx);
  const account = provided.get("businessAccount"),
    identity = provided.get("geaIdentity");
  assert.equal(account.getSnapshot, identity.getSnapshot);
  assert.equal(account.subscribe, identity.subscribe);
  const signal = new AbortController().signal;
  assert.equal((await account.startLogin(signal, "test")).loginId, "host-qr");
  assert.equal(account.getSnapshot().status.environment, "test");
  assert.deepEqual([...account.getSnapshot().status.environments], ["production", "test"]);
  assert.equal(await account.pollLogin("host-qr", signal), false);
  assert.equal(account.getSnapshot().state, "confirmed");
  pollStatus = "expired";
  await assert.rejects(account.pollLogin("host-qr", signal), /过期/);
  assert.equal(account.getSnapshot().status.authenticated, false);
  pollStatus = "authenticated";
  assert.equal(await account.pollLogin("host-qr", signal), true);
  assert.equal(account.getSnapshot().status.authenticated, true);
  await account.logout(signal);
  assert.equal(account.getSnapshot().status.authenticated, false);
  assert.equal(account.getSnapshot().scope, null);
  await account.startLogin(signal, "production");
  assert.equal(account.getSnapshot().status.environment, "production");
  assert.deepEqual(
    endpoints
      .filter(([url]) => url.includes("/login/start"))
      .map(([, options]) => JSON.parse(options.body)),
    [{ environment: "test" }, { environment: "production" }],
  );
  assert.deepEqual(
    endpoints
      .filter(([url]) => url.includes("/login/poll"))
      .map(([, options]) => JSON.parse(options.body)),
    [{ loginId: "host-qr" }, { loginId: "host-qr" }, { loginId: "host-qr" }],
  );
});

test("a cancelled account login cannot refresh the identity or accept its late challenge", async () => {
  const module = { exports: {} };
  const pending = Promise.withResolvers();
  let reads = 0;
  const fetch = async (url) => {
    if (url === "/api/gea-html/identity") {
      reads++;
      return Response.json({
        scope: null,
        status: { environment: "test", environments: ["test"], authenticated: false, user: null },
      });
    }
    return pending.promise;
  };
  runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    require,
    fetch,
    Response,
    AbortController,
    AbortSignal,
    CustomEvent,
    window: new EventTarget(),
    crypto: globalThis.crypto,
    console,
    setTimeout,
    clearTimeout,
  });
  const provided = new Map();
  module.exports.apply({ effect: () => {}, provide: (name, value) => provided.set(name, value) });
  const account = provided.get("businessAccount"),
    controller = new AbortController();
  const cancelled = account.startLogin(controller.signal, "test");
  controller.abort();
  pending.resolve(
    Response.json({ ok: true, value: { loginId: "late", image: "fixture", expiresIn: 120 } }),
  );
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(reads, 0);
  assert.equal(account.getSnapshot().state, "unknown");
});

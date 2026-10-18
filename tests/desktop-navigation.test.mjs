import test from "node:test";
import assert from "node:assert/strict";
let api;
try {
  api = await import("../src/host/desktop-navigation.ts");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  api = {};
}
function fixture() {
  let logged = false;
  let epoch = new AbortController();
  const listeners = new Set();
  let pending = { id: "delivery-1", navigationReference: "private-reference", schemaVersion: 1 };
  let resolves = 0;
  const acks = [];
  const business = {
    status: () => ({ authenticated: logged }),
    identitySignal: () => epoch.signal,
    watchIdentity: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    resolveClientNavigation: async () => {
      resolves++;
      return { intentId: "intent-1", panel: "gea-proof", expiresAt: Date.now() + 60000 };
    },
    acknowledgeClientNavigation: async (...args) => {
      acks.push(args.slice(0, 2));
    },
  };
  const request = async (path, body) => {
    if (path === "/navigation/pending") return pending;
    assert.equal(body.id, pending.id);
    pending = null;
  };
  return {
    business,
    request,
    acks,
    resolves: () => resolves,
    enqueue: () => {
      pending = { id: "delivery-2", navigationReference: "second-reference", schemaVersion: 1 };
    },
    change: () => {
      epoch.abort();
      epoch = new AbortController();
      logged = !logged;
      listeners.forEach((fn) => fn());
    },
  };
}
test("未登录不解析，登录后并发读取只解析一次且不暴露 Reference，visible 前不 ACK", async () => {
  assert.equal(typeof api.createDesktopNavigation, "function");
  const f = fixture();
  const nav = api.createDesktopNavigation(f.business, f.request);
  assert.equal((await nav.poll()).state, "login");
  assert.equal(f.resolves(), 0);
  f.change();
  const [first, second] = await Promise.all([nav.poll(), nav.poll()]);
  assert.equal(first.state, "ready");
  assert.deepEqual(second, first);
  assert.equal(f.resolves(), 1);
  assert.equal(JSON.stringify(first).includes("private-reference"), false);
  assert.equal(f.acks.length, 0);
  await nav.finish({ receipt: first.receipt, outcome: "visible" });
  assert.equal(f.acks.length, 1);
  assert.equal((await nav.poll()).state, "idle");
  nav.dispose();
});
test("切换身份使旧页面回执失效，迟到解析不会发布到新身份", async () => {
  assert.equal(typeof api.createDesktopNavigation, "function");
  const f = fixture();
  f.change();
  let release;
  f.business.resolveClientNavigation = () => new Promise((resolve) => (release = resolve));
  const nav = api.createDesktopNavigation(f.business, f.request);
  const reading = nav.poll();
  await new Promise((resolve) => setImmediate(resolve));
  f.change();
  release({ intentId: "intent-1", panel: "gea-proof", expiresAt: Date.now() + 60000 });
  assert.equal((await reading).state, "login");
  assert.equal(f.acks.length, 0);
  await assert.rejects(
    nav.finish({ receipt: "stale", outcome: "visible" }),
    /NAVIGATION_RECEIPT_STALE/,
  );
  nav.dispose();
});
test("ACK 失败重试复用幂等键且不再次解析或打开目标", async () => {
  assert.equal(typeof api.createDesktopNavigation, "function");
  const f = fixture();
  f.change();
  let attempts = 0;
  f.business.acknowledgeClientNavigation = async (id, key) => {
    f.acks.push([id, key]);
    if (!attempts++) throw Error("NAVIGATION_NETWORK_ERROR");
  };
  const nav = api.createDesktopNavigation(f.business, f.request);
  const first = await nav.poll();
  assert.equal((await nav.finish({ receipt: first.receipt, outcome: "visible" })).state, "error");
  await nav.retry();
  assert.equal((await nav.poll()).state, "idle");
  assert.equal(f.acks.length, 2);
  assert.deepEqual(f.acks[0], f.acks[1]);
  assert.equal(f.resolves(), 1);
  nav.dispose();
});
test("旧桌面没有导航通道时返回不可用，拒绝不受控输入", async () => {
  assert.equal(typeof api.createDesktopNavigation, "function");
  const f = fixture();
  const nav = api.createDesktopNavigation(f.business, async () => undefined);
  assert.equal((await nav.poll()).state, "unavailable");
  await assert.rejects(
    nav.finish({ receipt: "x", outcome: "visible", navigationReference: "injected" }),
    /NAVIGATION_REQUEST_INVALID/,
  );
  nav.dispose();
});

test("desktop service observation failure preserves an already claimed receipt and its phase", async () => {
  const f = fixture();
  f.change();
  let failed = false;
  const nav = api.createDesktopNavigation(f.business, async (path, body) => {
    if (failed) throw Error("NAVIGATION_CONTROL_UNAVAILABLE");
    return f.request(path, body);
  });
  const ready = await nav.poll();
  failed = true;
  const failure = await nav.poll();
  assert.equal(failure.state, "error");
  assert.equal(failure.receipt, ready.receipt);
  assert.equal(failure.stage, "poll");
  assert.equal(f.acks.length, 0);
  nav.dispose();
});

test("an empty desktop queue does not ask a signed-out account to open a message", async () => {
  const f = fixture();
  const nav = api.createDesktopNavigation(f.business, async () => null);
  assert.equal((await nav.poll()).state, "idle");
  assert.equal(f.resolves(), 0);
  assert.equal(f.acks.length, 0);
  nav.dispose();
});

test("完成响应丢失后以原 receipt 重试 finish 幂等，切身份后旧 receipt 仍拒绝", async () => {
  const f = fixture();
  f.change();
  const nav = api.createDesktopNavigation(f.business, f.request);
  const first = await nav.poll();
  assert.equal((await nav.finish({ receipt: first.receipt, outcome: "visible" })).state, "idle");
  assert.equal((await nav.finish({ receipt: first.receipt, outcome: "visible" })).state, "idle");
  assert.equal(f.acks.length, 1);
  assert.equal(f.resolves(), 1);
  f.enqueue();
  const next = await nav.poll();
  assert.equal(next.state, "ready");
  assert.notEqual(next.receipt, first.receipt);
  assert.equal((await nav.finish({ receipt: first.receipt, outcome: "visible" })).state, "idle");
  assert.equal((await nav.poll()).receipt, next.receipt);
  assert.equal(f.acks.length, 1);
  f.change();
  await assert.rejects(
    nav.finish({ receipt: first.receipt, outcome: "visible" }),
    /NAVIGATION_RECEIPT_STALE/,
  );
  nav.dispose();
});

test("旧壳 pending 404 保持安静，真实 receipt 的 complete 404 保留 finish 失败", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.GEA_DESKTOP_CONTROL_URL;
  const originalToken = process.env.GEA_DESKTOP_CONTROL_TOKEN;
  process.env.GEA_DESKTOP_CONTROL_URL = "http://127.0.0.1:32123";
  process.env.GEA_DESKTOP_CONTROL_TOKEN = "fixture-token";
  let pendingMissing = true;
  globalThis.fetch = async (url) =>
    new URL(url).pathname === "/navigation/pending" && !pendingMissing
      ? Response.json({
          id: "delivery-1",
          navigationReference: "private-reference",
          schemaVersion: 1,
        })
      : new Response(null, { status: 404 });
  const f = fixture();
  f.change();
  const nav = api.createDesktopNavigation(f.business);
  try {
    assert.equal((await nav.poll()).state, "unavailable");
    pendingMissing = false;
    const first = await nav.poll();
    const failed = await nav.finish({ receipt: first.receipt, outcome: "visible" });
    assert.equal(failed.state, "error");
    assert.equal(failed.receipt, first.receipt);
    assert.equal(failed.stage, "finish");
    assert.equal(failed.code, "NAVIGATION_CONTROL_UNAVAILABLE");
    assert.equal((await nav.poll()).receipt, first.receipt);
    assert.equal(f.acks.length, 1);
  } finally {
    nav.dispose();
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.GEA_DESKTOP_CONTROL_URL;
    else process.env.GEA_DESKTOP_CONTROL_URL = originalUrl;
    if (originalToken === undefined) delete process.env.GEA_DESKTOP_CONTROL_TOKEN;
    else process.env.GEA_DESKTOP_CONTROL_TOKEN = originalToken;
  }
});

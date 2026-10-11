import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { profile } from "./profile.mjs";
import { build } from "esbuild";
import { createRequire } from "node:module";

test("cancelled login requests cannot publish a late QR challenge or identity", async (t) => {
  const { outputFiles } = await build({
    entryPoints: ["src/host/business.ts"],
    bundle: true,
    packages: "external",
    write: false,
    platform: "node",
    format: "cjs",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const business = new module.exports.Business({
    geaEnvironments: {
      production: "https://production.example/gea",
      test: "https://test.example/gea",
    },
    requestTimeoutMs: 1000,
  });
  t.after(() => business.dispose());
  let held = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    entered.resolve();
    return held.promise;
  });
  const controller = new AbortController();
  const cancelled = business.loginStart(controller.signal, { environment: "test" });
  await entered.promise;
  controller.abort();
  held.resolve(Response.json({ success: true, result: { qrcodeId: "late" } }));
  await assert.rejects(cancelled, /STALE_SELECTION/);
  assert.equal(business.status().authenticated, false);
  await assert.rejects(
    business.loginPoll({ loginId: "late" }, new AbortController().signal),
    /STALE_LOGIN/,
  );
  held = Promise.withResolvers();
  entered = Promise.withResolvers();
  fetchMock.mock.mockImplementation(async (url) => {
    if (url.includes("getLoginQrcode"))
      return Response.json({ success: true, result: { qrcodeId: "current" } });
    if (url.includes("getQrcodeToken"))
      return Response.json({ success: true, result: { success: true, token: "synthetic" } });
    entered.resolve();
    return held.promise;
  });
  const qr = await business.loginStart(new AbortController().signal, { environment: "production" });
  const polling = new AbortController();
  const late = business.loginPoll({ loginId: qr.loginId }, polling.signal);
  await entered.promise;
  polling.abort();
  held.resolve(
    Response.json({
      success: true,
      result: { userInfo: { id: "late", realname: "Late", tenantId: "0" } },
    }),
  );
  await assert.rejects(late, /STALE_SELECTION/);
  assert.equal(business.status().authenticated, false);
  assert.equal(business.status().user, null);
});

test(
  "Lark avatar is exposed without credentials and cleared on logout",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    for (const avatar of ["https://example.com/lark-avatar.png", "", null, "javascript:alert(1)"]) {
      app.route((req, res, reply) => {
        if (!req.url.pathname.endsWith("/getUserInfo")) return false;
        reply({
          success: true,
          result: { userInfo: { id: "user", realname: "测试用户", tenantId: "0", avatar } },
        });
        return true;
      });
      await app.login();
      const status = (await app.rpc("status")).value;
      assert.equal(status.user.avatar, avatar?.startsWith("https:") ? avatar : undefined);
      assert.equal(status.user.name, "测试用户");
      assert.equal("token" in status.user, false);
      await app.rpc("logout");
      assert.equal((await app.rpc("status")).value.user, null);
    }
  },
);

test(
  "expired QR, late identity, 401 and business 403 preserve distinct states",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t);
    assert.equal(
      (
        await fetch(app.origin + "/api/gea-proof/status", {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/gea-proof/status", {
          method: "POST",
          headers: { Cookie: app.cookie, Origin: "https://foreign.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await app.rpc("plans")).error.code, "LOGIN_REQUIRED");
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/getQrcodeToken")) {
        reply({ success: true, result: { token: "-2" } });
        return true;
      }
    });
    const qr = (await app.rpc("login/start")).value;
    assert.equal((await app.rpc("login/poll", { loginId: qr.loginId })).value.status, "expired");
    let release, started;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    app.route(async (req, res, reply) => {
      if (req.url.pathname.endsWith("/getUserInfo")) {
        started();
        await held;
        reply({
          success: true,
          result: {
            userInfo: { id: "old", realname: "Old identity", tenantId: "0" },
          },
        });
        return true;
      }
    });
    const first = (await app.rpc("login/start")).value;
    const late = app.rpc("login/poll", { loginId: first.loginId });
    await entered;
    await app.rpc("login/start");
    release();
    assert.equal((await late).ok, false);
    assert.equal((await app.rpc("status")).value.authenticated, false);
    app.route(undefined);
    await app.login();
    const page = (await app.rpc("plans")).value;
    const selected = { queryId: page.queryId, planId: page.records[0].planId };
    const prepared = (await app.rpc("prepare", selected)).value;
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans")) {
        reply({ message: "Please sign in again" }, 401);
        return true;
      }
    });
    assert.equal((await app.rpc("plans")).error.code, "GEA_HTTP_401");
    assert.equal((await app.rpc("status")).value.loginState, "expired");
    assert.equal((await app.rpc("prepare", selected)).error.code, "LOGIN_REQUIRED");
    assert.equal(
      (await app.rpc("submit", { previewId: prepared.previewId })).error.code,
      "LOGIN_REQUIRED",
    );
    app.route(undefined);
    await app.login();
    app.route((req, res, reply) => {
      if (req.url.pathname.endsWith("/plans")) {
        reply(
          {
            message: "No sales-plan permission",
            errorCode: "SALES_PLAN_FORBIDDEN",
          },
          403,
        );
        return true;
      }
    });
    const denied = await app.rpc("plans");
    assert.equal(denied.error.code, "GEA_HTTP_403");
    assert.match(denied.error.message, /No sales-plan permission/);
    assert.equal((await app.rpc("status")).value.authenticated, true);
    app.route(undefined);
    assert.equal((await app.rpc("plans")).ok, true);
    // 审批身份要走网关会话解析当前用户角色：这两条是身份查询（POST 只为带 body），
    // 不是业务写入；可见 MCP 目录只允许初始化与列工具，不能发送工具执行。
    const identityLookups = [
      "/ai/gateway/session",
      "/ai/gateway/agent/session",
      "/ai/gateway/agent/session/current-user/resolve",
    ];
    const isMcpDiscovery = (request) =>
      request.method === "POST" &&
      request.url.pathname.endsWith("/ai/gateway/mcp/proxy/mcp") &&
      ["initialize", "notifications/initialized", "tools/list"].includes(
        JSON.parse(request.body).method,
      );
    assert.ok(
      app.requests.every(
        (request) =>
          request.method === "GET" ||
          identityLookups.some((path) => request.url.pathname.endsWith(path)) ||
          isMcpDiscovery(request),
      ),
      JSON.stringify(
        app.requests
          .filter(
            (request) =>
              request.method !== "GET" &&
              !identityLookups.some((path) => request.url.pathname.endsWith(path)) &&
              !isMcpDiscovery(request),
          )
          .map((request) => ({ method: request.method, path: request.url.pathname })),
      ),
    );
  },
);

test(
  "restored desktop login fetches its missing avatar on status",
  { timeout: 60000 },
  async (t) => {
    let saved;
    const control = createServer((req, res) => {
      // The desktop fixture owns login only; other mounted plugins may probe updates.
      if (req.url !== "/login") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "DESKTOP_ACTION_UNSUPPORTED" }));
        return;
      }
      if (req.method === "GET") {
        res.end(JSON.stringify(saved));
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        saved = JSON.parse(body);
        res.end("null");
      });
    });
    await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          control.closeAllConnections();
          control.close(resolve);
        }),
    );
    const app = await profile(t, {
      env: {
        GEA_DESKTOP_CONTROL_URL: `http://127.0.0.1:${control.address().port}`,
        GEA_DESKTOP_CONTROL_TOKEN: "fixture",
      },
      config: (base) => {
        saved = {
          schema: 1,
          environment: "production",
          base: base + "/gea",
          auth: {
            token: "fixture-token",
            tenantId: "0",
            id: "user",
            name: "旧登录",
            username: "user",
          },
        };
        return {};
      },
    });
    let reads = 0;
    app.route((req, res, reply) => {
      if (!req.url.pathname.endsWith("/getUserInfo")) return false;
      reads++;
      reply({
        success: true,
        result: { userInfo: { id: "user", avatar: "https://example.com/restored.png" } },
      });
      return true;
    });
    const result = await app.rpc("status");
    assert.equal(result.value.user.avatar, "https://example.com/restored.png");
    assert.equal(saved.auth.avatar, "https://example.com/restored.png");
    await app.rpc("status");
    assert.equal(reads, 1);
  },
);

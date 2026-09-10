import test from "node:test";
import assert from "node:assert/strict";
import { profile } from "./profile.mjs";

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
    assert.equal(
      (await app.rpc("login/poll", { loginId: qr.loginId })).value.status,
      "expired",
    );
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
    assert.equal(
      (await app.rpc("prepare", selected)).error.code,
      "LOGIN_REQUIRED",
    );
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
    assert.ok(app.requests.every((request) => request.method === "GET"));
  },
);

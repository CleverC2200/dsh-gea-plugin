import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";

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
const signal = () => new AbortController().signal;
const image = "data:image/jpg;base64,c3ludGhldGlj";
const user = { id: "user-1", username: "employee", realname: "测试用户", loginTenantId: 7 };
function fixture(t, override = () => undefined) {
  const business = new module.exports.Business({
    runtimeDir: tmpdir(),
    geaEnvironments: {
      production: "https://production.example/gea-boot",
      test: "https://test.example/gea-boot",
    },
    requestTimeoutMs: 1000,
  });
  t.after(() => business.dispose());
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = { url: new URL(url), init };
    calls.push(request);
    const custom = await override(request);
    if (custom) return custom;
    const path = request.url.pathname;
    let result = {};
    if (path.includes("/randomImage/"))
      return Response.json({ success: true, code: 0, result: image });
    if (path.endsWith("/sys/login")) result = { token: "fixture-login-token", userInfo: user };
    if (path.endsWith("/getLoginQrcode")) result = { qrcodeId: "fixture-qr" };
    if (path.endsWith("/getQrcodeToken")) result = { success: true, token: "fixture-login-token" };
    if (path.endsWith("/getUserInfo")) result = { userInfo: user };
    if (path.endsWith("/getPermCode")) result = { codeList: ["read"] };
    return Response.json({ success: true, code: 200, result });
  });
  const prepare = () => business.passwordLoginPrepare(signal(), { environment: "production" });
  const input = (challenge) => ({
    challengeId: challenge.challengeId,
    username: " employee ",
    password: "  password-kept  ",
    captcha: "a1B2",
  });
  const login = async () => business.passwordLogin(input(await prepare()), signal());
  return { business, calls, prepare, input, login };
}

test("both login methods publish the same identity and revoke the token on logout without exposing credentials", async (t) => {
  const f = fixture(t);
  await f.login();
  const passwordIdentity = f.business.status();
  const request = f.calls.find((call) => call.url.pathname.endsWith("/sys/login"));
  assert.deepEqual(JSON.parse(request.init.body), {
    username: "employee",
    password: "  password-kept  ",
    captcha: "a1B2",
    checkKey: JSON.parse(request.init.body).checkKey,
  });
  assert.equal(new Headers(request.init.headers).get("X-Version"), "v3");
  assert.equal(new Headers(request.init.headers).get("X-Access-Token"), null);
  assert.equal(passwordIdentity.user.tenantId, "7");
  assert.equal(f.business.desktopLoginSnapshot().auth.token, "fixture-login-token");
  assert.equal(JSON.stringify(passwordIdentity).includes("fixture-login-token"), false);
  const loggedOut = await f.business.logout({});
  assert.equal(loggedOut.remoteLogout, "confirmed");
  assert.equal(f.business.desktopLoginSnapshot(), null);
  const logout = f.calls.find((call) => call.url.pathname.endsWith("/sys/logout"));
  assert.equal(logout.init.method, "POST");
  assert.equal(new Headers(logout.init.headers).get("X-Access-Token"), "fixture-login-token");
  const qr = await f.business.loginStart(signal(), { environment: "production" });
  await f.business.loginPoll({ loginId: qr.loginId }, signal());
  assert.deepEqual(f.business.status().user, passwordIdentity.user);
  assert.equal((await f.business.logout({})).authenticated, false);
});

for (const [code, failure] of [
  [412, "CAPTCHA_INVALID"],
  [500, "REJECTED"],
  [429, "RATE_LIMITED"],
  [503, "UNAVAILABLE"],
]) {
  test(`HTTP 200 with authentication failure ${code} preserves its meaning and never retries`, async (t) => {
    const f = fixture(
      t,
      ({ url }) =>
        url.pathname.endsWith("/sys/login") &&
        Response.json({
          success: false,
          code,
          message: "echo password-kept",
          result: { token: "must-not-accept" },
        }),
    );
    await assert.rejects(f.login(), { message: "GEA_LOGIN_" + failure });
    assert.equal(f.business.status().authenticated, false);
    assert.equal(f.calls.filter((call) => call.url.pathname.endsWith("/sys/login")).length, 1);
  });
}

test("login rejects missing token and wrong success code before requesting user info", async (t) => {
  for (const result of [
    { success: true, code: 201, result: { token: "bad" } },
    { success: true, code: 200, result: {} },
  ]) {
    const f = fixture(t, ({ url }) => url.pathname.endsWith("/sys/login") && Response.json(result));
    await assert.rejects(f.login(), /GEA_INVALID_LOGIN/);
    assert.equal(f.business.status().authenticated, false);
    assert.equal(
      f.calls.some((call) => call.url.pathname.endsWith("/getUserInfo")),
      false,
    );
    t.mock.restoreAll();
  }
});

test("refresh, expiry and environment changes invalidate old challenges before sending a password", async (t) => {
  const f = fixture(t);
  const first = await f.prepare();
  const next = await f.prepare();
  assert.notEqual(first.challengeId, next.challengeId);
  await assert.rejects(f.business.passwordLogin(f.input(first), signal()), /STALE_LOGIN/);
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 61000);
  await assert.rejects(f.business.passwordLogin(f.input(next), signal()), /CAPTCHA_INVALID/);
  f.business.selectEnvironment({ environment: "test" });
  await assert.rejects(f.business.passwordLogin(f.input(next), signal()), /STALE_LOGIN/);
  assert.equal(
    f.calls.some((call) => call.url.pathname.endsWith("/sys/login")),
    false,
  );
});

test("switching methods rejects late passwords and late QR results", async (t) => {
  let held, entered;
  const f = fixture(t, async ({ url }) => {
    if (held && url.pathname.endsWith("/sys/login")) {
      entered.resolve();
      return held.promise;
    }
  });
  const qr = await f.business.loginStart(signal(), { environment: "production" });
  const challenge = await f.prepare();
  await assert.rejects(f.business.loginPoll({ loginId: qr.loginId }, signal()), /STALE_LOGIN/);
  held = Promise.withResolvers();
  entered = Promise.withResolvers();
  const pending = f.business.passwordLogin(f.input(challenge), signal());
  await entered.promise;
  await assert.rejects(f.business.passwordLogin(f.input(challenge), signal()), /IN_PROGRESS/);
  await f.business.loginStart(signal(), { environment: "test" });
  held.resolve(Response.json({ success: true, code: 200, result: { token: "late" } }));
  await assert.rejects(pending);
  assert.equal(f.business.status().authenticated, false);
  assert.equal(f.business.status().environment, "test");
});

test("cancelled identity reads never publish a password identity", async (t) => {
  const entered = Promise.withResolvers(),
    held = Promise.withResolvers();
  const f = fixture(t, ({ url }) => {
    if (url.pathname.endsWith("/getUserInfo")) {
      entered.resolve();
      return held.promise;
    }
  });
  const challenge = await f.prepare(),
    controller = new AbortController();
  const pending = f.business.passwordLogin(f.input(challenge), controller.signal);
  await entered.promise;
  controller.abort();
  held.resolve(Response.json({ success: true, result: { userInfo: user } }));
  await assert.rejects(pending);
  assert.equal(f.business.status().authenticated, false);
});

test("failed or late server logout clears local persistence and cannot clear a new login", async (t) => {
  const entered = Promise.withResolvers(),
    held = Promise.withResolvers();
  const f = fixture(t, ({ url }) => {
    if (url.pathname.endsWith("/sys/logout")) {
      entered.resolve();
      return held.promise;
    }
  });
  await f.login();
  const pending = f.business.logout({});
  await entered.promise;
  assert.equal(f.business.desktopLoginSnapshot(), null);
  await f.login();
  held.resolve(Response.json({ success: false }, { status: 503 }));
  assert.equal((await pending).remoteLogout, "unconfirmed");
  assert.equal(f.business.status().authenticated, true);
});

test("HTTP rate limits without JSON retain rate-limit semantics", async (t) => {
  const f = fixture(
    t,
    ({ url }) =>
      url.pathname.endsWith("/sys/login") && new Response("upstream unavailable", { status: 429 }),
  );
  await assert.rejects(f.login(), /GEA_LOGIN_RATE_LIMITED/);
  assert.equal(f.business.status().authenticated, false);
});

test("password login rejects incomplete identity and accepts tenant zero without inventing permissions", async (t) => {
  for (const tenant of ["invalid", 0]) {
    const f = fixture(
      t,
      ({ url }) =>
        url.pathname.endsWith("/getUserInfo") &&
        Response.json({ success: true, result: { userInfo: { ...user, loginTenantId: tenant } } }),
    );
    if (tenant === 0) {
      await f.login();
      assert.equal(f.business.status().user.tenantId, "0");
    } else {
      await assert.rejects(f.login(), /GEA_IDENTITY_INCOMPLETE/);
      assert.equal(f.business.status().authenticated, false);
    }
    t.mock.restoreAll();
  }
});

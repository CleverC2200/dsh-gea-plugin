import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnvironments } from "../src/shared/environments.js";
import { profile } from "./profile.mjs";
import { build } from "esbuild";
import { createRequire } from "node:module";

async function loginHost(t) {
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
  return business;
}

test("login/start uses the selected environment and revokes the previous QR and authenticated identity", async (t) => {
  const business = await loginHost(t),
    paths = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    options.signal.throwIfAborted();
    paths.push(url);
    return Response.json({ success: true, result: { qrcodeId: "fixture-qr" } });
  });
  const signal = new AbortController().signal;
  const first = await business.loginStart(signal, { environment: "production" });
  const next = await business.loginStart(signal, { environment: "test" });
  assert.notEqual(next.loginId, first.loginId);
  await assert.rejects(business.loginPoll({ loginId: first.loginId }, signal), /STALE_LOGIN/);
  assert.equal(business.status().environment, "test");
  assert.deepEqual(business.status().environments, ["production", "test"]);
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: "https://production.example/gea",
    auth: {
      token: "synthetic",
      tenantId: "0",
      id: "fixture",
      name: "Fixture",
      username: "fixture",
    },
  });
  assert.equal(business.status().authenticated, true);
  await business.loginStart(signal, { environment: "test" });
  assert.equal(business.status().authenticated, false);
  assert.equal(business.pageSessionScope(), undefined);
  assert.equal(paths.at(-1), "https://test.example/gea/sys/getLoginQrcode");
});

test("login/start environment replacement rejects a late identity from the previous QR", async (t) => {
  const business = await loginHost(t),
    entered = Promise.withResolvers(),
    held = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.includes("getLoginQrcode"))
      return Response.json({ success: true, result: { qrcodeId: "fixture-qr" } });
    if (url.includes("getQrcodeToken"))
      return Response.json({ success: true, result: { success: true, token: "synthetic" } });
    if (url.includes("getUserInfo")) {
      entered.resolve();
      await held.promise;
      return Response.json({
        success: true,
        result: { userInfo: { id: "old", realname: "Old", tenantId: "0" } },
      });
    }
    assert.fail("unexpected fixture endpoint");
  });
  const signal = new AbortController().signal,
    first = await business.loginStart(signal, { environment: "production" });
  const late = business.loginPoll({ loginId: first.loginId }, signal);
  await entered.promise;
  const current = await business.loginStart(signal, { environment: "test" });
  held.resolve();
  await assert.rejects(late, /STALE_LOGIN|STALE_SELECTION/);
  assert.equal(business.status().environment, "test");
  assert.equal(business.status().authenticated, false);
  assert.equal(business.status().user, null);
  assert.notEqual(current.loginId, first.loginId);
});

test("environment selection only resolves deployment-owned endpoints", () => {
  const config = {
    environment: "test",
    geaEnvironments: {
      production: "https://production.example/gea",
      test: "https://test.example/gea/",
    },
  };
  assert.equal(resolveEnvironments(config).baseUrl, "https://test.example/gea");
  for (const change of [
    { environment: "custom" },
    { geaEnvironments: { production: "https://production.example/gea" } },
    {
      geaEnvironments: {
        production: "http://unsafe.example",
        test: "https://test.example",
      },
    },
  ])
    assert.throws(() => resolveEnvironments({ ...config, ...change }), /INVALID_GEA/);
});

test(
  "switching environment invalidates QR, login, previews and redirects subsequent requests",
  { timeout: 60000 },
  async (t) => {
    const app = await profile(t, {
      config: (base) => ({
        environment: "test",
        geaEnvironments: {
          production: base + "/production",
          test: base + "/test",
        },
      }),
    });
    let paths = [];
    app.route((request) => {
      paths.push(request.url.pathname);
      return false;
    });
    const qr = (await app.rpc("login/start")).value;
    assert.equal(
      (await app.rpc("environment/select", { environment: "production" })).value.authenticated,
      false,
    );
    assert.equal((await app.rpc("login/poll", { loginId: qr.loginId })).error.code, "STALE_LOGIN");
    await app.login();
    assert.ok(paths.some((path) => path === "/production/sys/getLoginQrcode"));
    const page = (await app.rpc("plans")).value;
    const preview = (
      await app.rpc("prepare", {
        queryId: page.queryId,
        planId: page.records[0].planId,
      })
    ).value;
    assert.equal(
      (await app.rpc("environment/select", { environment: "test" })).value.environment,
      "test",
    );
    assert.equal(
      (await app.rpc("submit", { previewId: preview.previewId })).error.code,
      "LOGIN_REQUIRED",
    );
    assert.equal((await app.rpc("plans")).error.code, "LOGIN_REQUIRED");
    assert.equal(
      (
        await app.rpc("environment/select", {
          environment: "test",
          url: "https://attacker.invalid",
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await app.rpc("environment/select", {
          environment: "https://attacker.invalid",
        })
      ).ok,
      false,
    );
    await app.login();
    assert.ok(paths.some((path) => path === "/test/sys/getLoginQrcode"));
  },
);

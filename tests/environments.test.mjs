import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnvironments } from "../src/environments.js";
import { profile } from "./profile.mjs";

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
    assert.throws(
      () => resolveEnvironments({ ...config, ...change }),
      /INVALID_GEA/,
    );
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
      (await app.rpc("environment/select", { environment: "production" })).value
        .authenticated,
      false,
    );
    assert.equal(
      (await app.rpc("login/poll", { loginId: qr.loginId })).error.code,
      "STALE_LOGIN",
    );
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
      (await app.rpc("environment/select", { environment: "test" })).value
        .environment,
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

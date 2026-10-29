import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

const built = await build({
  stdin: {
    contents:
      "export {Business} from './src/host/business.ts'; export {initializeGeaDefaultModel} from './src/host/gea-model.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const mod = { exports: {} };
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports,
);
const { Business, initializeGeaDefaultModel } = mod.exports;

function fixture(
  t,
  {
    current = { provider: "deepseek-official", model: "deepseek-flash" },
    configured = "removed-model",
    models = ["managed-first", "managed-second"],
    credentials = [{ id: "fixture-credential", status: "ACTIVE" }],
    modelResponse,
    deniedAt,
  } = {},
) {
  const business = new Business({
    geaBaseUrl: "https://fixture.invalid/gea-boot",
    analysisAgentCode: "sales_forecast",
    analysisModel: configured,
    workbenchCapability: { enabled: true },
    requestTimeoutMs: 1000,
    runtimeDir: "/unused/default-model-fixture",
  });
  business.restoreDesktopLogin({
    schema: 1,
    environment: "production",
    base: business.base,
    auth: {
      token: "fixture-login",
      tenantId: "0",
      id: "fixture-user",
      name: "Fixture",
      username: "fixture",
    },
  });
  t.after(() => business.dispose());
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (deniedAt && url.includes("/my/" + deniedAt))
      return Response.json({ success: false, message: "Permission denied" }, { status: 403 });
    if (url.includes("/my/list"))
      return Response.json({ success: true, result: { records: credentials } });
    if (url.includes("/my/claim"))
      return Response.json({
        success: true,
        result: {
          credentialId: "fixture-credential",
          status: "ACTIVE",
          baseUrl: "https://model.invalid",
          secret: "fixture-secret",
        },
      });
    if (url.endsWith("/models")) {
      assert.equal(init.headers["X-GEA-Agent-Code"], "workbench");
      return modelResponse
        ? modelResponse()
        : Response.json({ data: models.map((id) => ({ id, name: id })) });
    }
    assert.fail("Unexpected request: " + url);
  });
  const saved = [];
  const defaults = {
    currentSelection: () => current,
    saveSelection: async (value) => {
      saved.push(value);
    },
  };
  return {
    business,
    defaults,
    saved,
    run: () => initializeGeaDefaultModel(business, defaults, business.identitySignal()),
  };
}

test("first installation replaces the removed official default with the first GEA-managed model", async (t) => {
  const f = fixture(t);
  await f.run();
  assert.deepEqual(f.saved, [{ provider: "gea-analysis", model: "managed-first" }]);
});
test("an available deployment preference takes priority over the first managed model", async (t) => {
  const f = fixture(t, { configured: "managed-second" });
  await f.run();
  assert.equal(f.saved[0].model, "managed-second");
});
test("a user's still-authorized GEA model and reasoning effort are retained", async (t) => {
  const f = fixture(t, {
    current: { provider: "gea-analysis", model: "managed-second", reasoningEffort: "max" },
  });
  await f.run();
  assert.deepEqual(f.saved, []);
});
test("a removed GEA default switches to a managed model and retains its supported effort", async (t) => {
  const f = fixture(t, {
    current: { provider: "gea-analysis", model: "removed-model", reasoningEffort: "max" },
  });
  await f.run();
  assert.deepEqual(f.saved, [
    { provider: "gea-analysis", model: "managed-first", reasoningEffort: "max" },
  ]);
});
for (const [name, options, code] of [
  ["missing credentials", { credentials: [] }, "GEA_MODEL_CREDENTIAL_MISSING"],
  [
    "disabled credentials",
    { credentials: [{ id: "fixture-credential", status: "DISABLED" }] },
    "GEA_MODEL_CREDENTIAL_DISABLED",
  ],
  ["no authorized models", { models: [] }, "GEA_MODEL_EMPTY"],
])
  test(
    name + " direct the user to the administrator and withdraw the retired official default",
    async (t) => {
      const f = fixture(t, options);
      await assert.rejects(
        f.run(),
        (error) => error.code === code && /联系管理员/.test(error.message),
      );
      assert.deepEqual(f.saved, [{ provider: "gea-analysis", model: "removed-model" }]);
    },
  );
test("a model list from an expired identity cannot overwrite the new account's defaults", async (t) => {
  const entered = Promise.withResolvers();
  const response = Promise.withResolvers();
  const f = fixture(t, {
    modelResponse: () => {
      entered.resolve();
      return response.promise;
    },
  });
  const result = f.run();
  await entered.promise;
  f.business.logout({});
  response.resolve(Response.json({ data: [{ id: "old-identity-model", name: "Old" }] }));
  await assert.rejects(result);
  assert.deepEqual(f.saved, []);
});

for (const deniedAt of ["list", "claim"])
  test(`credential ${deniedAt} denial retains its status and directs the user to the administrator`, async (t) => {
    const f = fixture(t, { deniedAt });
    await assert.rejects(
      f.run(),
      (error) =>
        error.code === (deniedAt === "list" ? "GEA_HTTP_403" : "GEA_MODEL_HTTP_403") &&
        /联系管理员/.test(error.message),
    );
    assert.deepEqual(f.saved, [{ provider: "gea-analysis", model: "removed-model" }]);
    assert.equal(f.business.status().authenticated, true);
  });

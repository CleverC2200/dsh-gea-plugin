import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { build } from "esbuild";

test("demo analysis admits only its bound readonly page and keeps execution denied", async () => {
  const { outputFiles } = await build({
    entryPoints: ["src/host/business.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const business = Object.create(module.exports.Business.prototype);
  const contract = {
    id: "inventory-orderworkbench",
    data: { consumerCode: "order", mock: true },
    enabled: true,
    maxEffect: "view",
    view: { surface: "gea-html-inventory-orderworkbench" },
  };
  business.config = { analysisAgentCode: "sales" };
  let page = { pluginId: contract.id, consumerCode: "order", mock: true };
  business.currentPageIdentity = (session) => (session === "owned" ? page : undefined);
  business.setCapabilities({
    list: () => [contract],
    allows: (_surface, effect) => effect === "view",
  });
  assert.throws(() => business.assertExecutionAllowed("order"), /GEA_CAPABILITY_MOCK_ONLY/);
  assert.doesNotThrow(() => business.assertExecutionAllowed("order", "view", "owned"));
  assert.throws(
    () => business.assertExecutionAllowed("order", "draft", "owned"),
    /GEA_CAPABILITY_MOCK_ONLY/,
  );
  assert.throws(
    () => business.assertExecutionAllowed("order", "view", "other"),
    /GEA_CAPABILITY_MOCK_ONLY/,
  );
  page = { ...page, consumerCode: "other" };
  assert.throws(
    () => business.assertExecutionAllowed("order", "view", "owned"),
    /GEA_CAPABILITY_MOCK_ONLY/,
  );
  page = { ...page, consumerCode: "order", pluginId: "other" };
  assert.throws(
    () => business.assertExecutionAllowed("order", "view", "owned"),
    /GEA_CAPABILITY_MOCK_ONLY/,
  );
  page = { ...page, pluginId: contract.id };
  contract.enabled = false;
  assert.throws(
    () => business.assertExecutionAllowed("order", "view", "owned"),
    /GEA_CAPABILITY_DISABLED/,
  );
  contract.enabled = true;
  business.setCapabilities({ list: () => [contract], allows: () => false });
  assert.throws(
    () => business.assertExecutionAllowed("order", "view", "owned"),
    /GEA_CAPABILITY_EFFECT_NOT_ALLOWED/,
  );
});

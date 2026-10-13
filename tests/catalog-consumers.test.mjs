import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const { outputFiles } = await build({
  entryPoints: ["tests/fixtures/retired-query/catalog-consumers.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { resourceConsumers } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
test("resource-to-consumer projection is snapshot-local, excludes non-Cube resources and keeps two identities independent", () => {
  const resource = {
    capabilityCode: "tool",
    resourceCode: "r",
    resourceType: "EXTERNAL_MCP",
    resourceName: "r",
    queryTarget: "model",
    version: "1",
    maxRows: null,
    maxBytes: null,
  };
  const a = resourceConsumers({ resources: [resource], fetchedAt: "now" }, "agent-a");
  const b = resourceConsumers({ resources: [resource], fetchedAt: "now" }, "agent-b");
  assert.equal(a.get("model"), "agent-a");
  assert.equal(b.get("model"), "agent-b");
  assert.equal(resourceConsumers({ resources: [], fetchedAt: "next" }, "agent-a").size, 0);
  assert.equal(
    resourceConsumers(
      { resources: [{ ...resource, resourceType: "TABLE" }], fetchedAt: "now" },
      "agent-a",
    ).size,
    0,
  );
});

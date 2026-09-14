import test from "node:test";
import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { deploymentPatch } from "../scripts/deployment.mjs";
const require = createRequire(import.meta.url);
test("the runtime resolves pinned published packages and replaces layout by ordinary patch rows", async () => {
  const path = require.resolve("@deepseek-ai/dsh/package.json");
  assert.equal(JSON.parse(await readFile(path, "utf8")).version, "0.1.5-rc.2");
  assert.ok((await realpath(path)).includes("/node_modules/"));
  const layout = await readFile(
    require.resolve("@deepseek-ai/dsh-client-ui-layout/client"),
    "utf8",
  );
  assert.equal(layout.includes("registerConversationPanel"), false);
  const patch = deploymentPatch(
    { analysis: { mode: "receipt" } },
    "/plugin",
    "/runtime",
  );
  assert.equal(patch.find((row) => row.id === "ui-layout").disabled, true);
  assert.ok(
    patch.some((row) =>
      row.insert?.some((entry) => entry.id === "agent-workbench"),
    ),
  );
  assert.equal(
    patch.some((row) =>
      row.insert?.some((entry) => entry.id === "workbench-example"),
    ),
    false,
  );
});

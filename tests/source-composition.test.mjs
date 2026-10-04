import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sourcePlugins } from "../scripts/source-composition.mjs";

test("the registered source composition contains the five current owners and only the fixed latest official release", async () => {
  assert.deepEqual(
    sourcePlugins.map((plugin) => plugin.repo),
    [
      "dsh-agent-workbench",
      "dsh-agent-manage",
      "dsh-gea-plugin",
      "dsh-genui",
      "dsh-better-sidebar",
    ],
  );
  assert.ok(sourcePlugins.every((plugin) => plugin.bundleOrder !== undefined));
  assert.ok(sourcePlugins.every((plugin) => plugin.example === undefined));
  const input = JSON.parse(
    await readFile(
      new URL("../scripts/current-core.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(input, {
    version: "0.2.1-alpha.1",
    upstream: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
    adaptation: "5badb15009ae1756c3afe0ae0cef1faafc290ccc",
  });
});

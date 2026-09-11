import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareDshSource } from "../scripts/dsh-source.mjs";

async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), "gea-dsh-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = resolve(root, "plugin");
  const source = resolve(root, "dsh");
  const layout = resolve(source, "packages/client/ui-layout");
  await mkdir(resolve(source, "apps/cli/lib"), { recursive: true });
  await mkdir(resolve(layout, "lib"), { recursive: true });
  await mkdir(plugin);
  await writeFile(resolve(source, "apps/cli/lib/bin.js"), "");
  await writeFile(
    resolve(layout, "lib/client.js"),
    "registerConversationPanel() {}",
  );
  await writeFile(
    resolve(layout, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-client-ui-layout" }),
  );
  await writeFile(
    resolve(plugin, "package.json"),
    JSON.stringify({
      devDependencies: { "@deepseek-ai/dsh-client-ui-layout": "0.1.5-rc.1" },
    }),
  );
  return { plugin, source, layout };
}

test("fork preparation links the selected checkout and reuses its recorded path", async (t) => {
  const { plugin, source, layout } = await fixture(t);
  const first = await prepareDshSource(plugin, source);
  assert.equal(first.source, source);
  assert.equal(
    await realpath(
      resolve(plugin, "node_modules/@deepseek-ai/dsh-client-ui-layout"),
    ),
    await realpath(layout),
  );
  assert.equal((await prepareDshSource(plugin, "")).source, source);
});

test("a clean install without an explicit fork refuses the unsupported published UI", async (t) => {
  const { plugin } = await fixture(t);
  await assert.rejects(prepareDshSource(plugin, ""), /GEA_DSH_SOURCE_REQUIRED/);
});

test("missing fork packages fail before replacing installed dependencies", async (t) => {
  const { plugin, source } = await fixture(t);
  await writeFile(
    resolve(plugin, "package.json"),
    JSON.stringify({
      dependencies: { "@deepseek-ai/dsh-missing": "0.1.5-rc.1" },
    }),
  );
  const installed = resolve(plugin, "node_modules/@deepseek-ai/dsh-missing");
  await mkdir(installed, { recursive: true });
  await writeFile(resolve(installed, "keep.txt"), "keep");
  await assert.rejects(
    prepareDshSource(plugin, source),
    /GEA_DSH_SOURCE_PACKAGE_MISSING/,
  );
  assert.equal(await readFile(resolve(installed, "keep.txt"), "utf8"), "keep");
});

test("an older built layout fails before dependency links are changed", async (t) => {
  const { plugin, source, layout } = await fixture(t);
  await writeFile(resolve(layout, "lib/client.js"), "registerGlobalPanel() {}");
  await assert.rejects(
    prepareDshSource(plugin, source),
    /GEA_DSH_LAYOUT_INCOMPATIBLE/,
  );
});

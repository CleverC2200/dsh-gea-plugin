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
  const workbench = patch.flatMap(row => row.insert ?? []).find(entry => entry.id === "agent-workbench");
  assert.equal(workbench.name, require.resolve("@cleverc2200/dsh-agent-workbench"));
  assert.ok((await realpath(workbench.name)).includes("/node_modules/"));
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

test('GEA exposes a standard bundle that composes the independent workbench', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dsh.bundle?.patch, './cordis.patch.yml');
  const { loadProfile } = await import('@deepseek-ai/dsh-app-boot');
  assert.equal(typeof loadProfile, 'function');
});

test('missing and incompatible workbench dependencies fail with actionable diagnostics', async t => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { resolveWorkbench } = await import('../scripts/deployment.mjs');
  const root = await mkdtemp(join(tmpdir(), 'workbench-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => resolveWorkbench(join(root, 'package.json')), /WORKBENCH_MISSING/);
  const dep = join(root, 'node_modules/@cleverc2200/dsh-agent-workbench');
  await mkdir(dep, { recursive: true });
  await writeFile(join(dep, 'package.json'), JSON.stringify({ name: '@cleverc2200/dsh-agent-workbench', version: '9.0.0' }));
  assert.throws(() => resolveWorkbench(join(root, 'package.json')), /WORKBENCH_INCOMPATIBLE/);
});

test('bundle overlays keep the data workspace independent of the installed version', () => {
  const patch = deploymentPatch({ analysis: { mode: 'receipt' } }, '/version-b', '/user-data', { bundle: true });
  assert.equal(patch.find(row => row.id === 'agent-workbench').config.cwd, '/user-data/workspace');
  assert.equal(patch.find(row => row.id === 'gea-proof').config.runtimeDir, '/user-data');
  assert.equal(patch.some(row => row.insert?.some(entry => entry.id === 'gea-proof')), false);
});

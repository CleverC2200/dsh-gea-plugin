import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const names = [
  "@cleverc2200/dsh-agent-workbench",
  "dsh-agent-manage",
  "@cleverc2200/gea-dsh-prototype",
];
async function fixture(t, capable = true) {
  await mkdir(".runtime", { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), ".runtime/plugin-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "client.mjs");
  await build({
    entryPoints: ["src/plugin-updates-client.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outfile: file,
  });
  const { createPluginDetailUpdates } = await import(pathToFileURL(file));
  const state = { phase: "available", requests: [], writes: [], release: undefined };
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (url) => {
    if (!url.endsWith("/status")) state.writes.push(url);
    return Response.json({
      ok: true,
      value: url.endsWith("/status")
        ? {
            revision: 1,
            hostProcessIdentity: "host",
            challenge: "nonce",
            checkTimeoutMs: 1000,
            pollIntervalMs: 1000,
            restartReady: true,
            items: names.map((packageName) => ({
              packageName,
              state: state.phase,
              installedVersion: "1.2.3",
              runningHostVersion: "1.2.3",
              runningClientVersion: "1.2.3",
              candidateVersion: "1.2.4",
              planId: "11111111-1111-4111-8111-111111111111",
              diagnostic: null,
            })),
          }
        : null,
    });
  };
  const owner = createPluginDetailUpdates(
    { get: () => undefined },
    {
      restartUpdate: capable
        ? async (request) => {
            state.requests.push(request);
            if (state.release) await state.release;
          }
        : undefined,
    },
  );
  t.after(() => owner.dispose());
  const close = owner.retain();
  await new Promise(setImmediate);
  return { owner, state, close };
}
test("suite click passes approved plans directly to native takeover without renderer writes", async (t) => {
  const { owner, state } = await fixture(t);
  await owner.updateAll();
  assert.deepEqual(state.requests, [
    {
      kind: "plugins",
      plans: names.map((packageName) => ({
        packageName,
        planId: "11111111-1111-4111-8111-111111111111",
      })),
    },
  ]);
  assert.deepEqual(state.writes, []);
});
test("duplicate clicks join native takeover and page closure does not cancel it", async (t) => {
  const { owner, state, close } = await fixture(t);
  let finish;
  state.release = new Promise((resolve) => (finish = resolve));
  const first = owner.updateAll();
  const second = owner.updateAll();
  close();
  finish();
  await Promise.all([first, second]);
  assert.equal(state.requests.length, 1);
});
test("pending restart uses native takeover and never the normal restart bridge", async (t) => {
  const { owner, state } = await fixture(t);
  state.phase = "pending-restart";
  await owner.check();
  state.writes = [];
  await owner.restart();
  assert.deepEqual(state.requests, [{ kind: "plugins-restart" }]);
  assert.deepEqual(state.writes, []);
});
test("unsupported clients require upgrade and cannot fall back to renderer installation", async (t) => {
  const { owner, state } = await fixture(t, false);
  await owner.updateAll();
  assert.equal(owner.getSnapshot().restart, "unsupported");
  assert.deepEqual(state.writes, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { until } from "./profile.mjs";
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
  const state = {
    phase: "available",
    requests: [],
    writes: [],
    release: undefined,
    prepareError: undefined,
    durable: false,
    loseResponse: false,
  };
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (url, options) => {
    if (!url.endsWith("/status")) state.writes.push({ url, payload: JSON.parse(options.body) });
    if (url.endsWith("/update-all")) {
      if (state.release) await state.release;
      if (state.prepareError)
        return Response.json({ ok: false, error: { code: state.prepareError } }, { status: 409 });
      state.phase = "downloading";
      if (state.loseResponse) throw Error("connection lost after acceptance");
    }
    return Response.json({
      ok: true,
      value: url.endsWith("/status")
        ? {
            revision: 1,
            hostProcessIdentity: "host",
            challenge: "nonce",
            checkTimeoutMs: 1000,
            pollIntervalMs: 1000,
            restartReady: state.durable && state.phase === "pending-restart",
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
test("suite click prepares approved plans in the Host without native takeover", async (t) => {
  const { owner, state } = await fixture(t);
  await owner.updateAll();
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.writes, [
    {
      url: "/api/gea/plugin-updates/update-all",
      payload: {
        plans: names.map((packageName) => ({
          packageName,
          planId: "11111111-1111-4111-8111-111111111111",
        })),
      },
    },
  ]);
  assert.equal(owner.getSnapshot().restart, "idle");
});
test("duplicate clicks join Host preparation and page closure does not cancel it", async (t) => {
  const { owner, state, close } = await fixture(t);
  let finish;
  state.release = new Promise((resolve) => (finish = resolve));
  const first = owner.updateAll();
  const second = owner.updateAll();
  close();
  finish();
  await Promise.all([first, second]);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.requests, []);
});
test("pending restart uses native takeover and never the normal restart bridge", async (t) => {
  const { owner, state } = await fixture(t);
  state.phase = "pending-restart";
  state.durable = true;
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

test("only a durable candidate hands off to native restart after background preparation", async (t) => {
  const { owner, state } = await fixture(t);
  await owner.updateAll();
  state.phase = "pending-restart";
  await until(
    () => owner.getSnapshot(),
    (snapshot) => snapshot.items.every((row) => row.state === "pending-restart"),
  );
  assert.deepEqual(state.requests, []);
  state.durable = true;
  await until(
    () => state.requests.length,
    (count) => count === 1,
  );
  assert.deepEqual(state.requests, [{ kind: "plugins-restart" }]);
  assert.equal(owner.getSnapshot().restart, "requested");
});

test("a stale plan stays outside native takeover and can be checked again", async (t) => {
  const { owner, state } = await fixture(t);
  state.prepareError = "UPDATE_PLAN_EXPIRED";
  await owner.updateAll();
  assert.deepEqual(state.requests, []);
  assert.equal(owner.getSnapshot().restart, "idle");
  assert.equal(await owner.check(), true);
  assert.equal(owner.getSnapshot().submitting, null);
});

test("a lost preparation response recovers durable status before requesting native restart", async (t) => {
  const { owner, state } = await fixture(t);
  state.loseResponse = true;
  await owner.updateAll();
  assert.deepEqual(state.requests, []);
  assert.equal(owner.getSnapshot().restart, "idle");
  state.phase = "pending-restart";
  state.durable = true;
  await until(
    () => state.requests.length,
    (count) => count === 1,
  );
  assert.deepEqual(state.requests, [{ kind: "plugins-restart" }]);
});

test("manual restart also waits for the Host durable confirmation", async (t) => {
  const { owner, state } = await fixture(t);
  state.phase = "pending-restart";
  await owner.check();
  await owner.restart();
  assert.deepEqual(state.requests, []);
  assert.equal(owner.getSnapshot().restart, "idle");
});

test("slow accepted preparation still restarts when its candidate later becomes durable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { owner, state } = await fixture(t);
  await owner.updateAll();
  t.mock.timers.tick(120_000);
  await new Promise(setImmediate);
  assert.deepEqual(state.requests, []);
  state.phase = "pending-restart";
  state.durable = true;
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  assert.deepEqual(state.requests, [{ kind: "plugins-restart" }]);
});

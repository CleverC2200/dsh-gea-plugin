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
async function fixture(t, restart = async () => true) {
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
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = {
    phases: names.map(() => "available"),
    restartReady: false,
    calls: 0,
    companyUpdate: null,
    nativeBusy: false,
    rejectUpdate: false,
  };
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (url) => {
    if (url.endsWith("/status"))
      return Response.json({
        ok: true,
        value: {
          revision: 1,
          hostProcessIdentity: "host-fixture",
          challenge: "nonce-fixture",
          checkTimeoutMs: 1000,
          pollIntervalMs: 1000,
          restartReady: state.restartReady,
          companyUpdate: state.companyUpdate,
          items: names.map((packageName, index) => ({
            packageName,
            state: state.phases[index],
            installedVersion: "1.2.3",
            runningHostVersion: "1.2.3",
            runningClientVersion: "1.2.3",
            candidateVersion: "1.2.4",
            planId: "11111111-1111-4111-8111-111111111111",
            diagnostic: null,
          })),
        },
      });
    assert.ok(url.endsWith("/check") || url.endsWith("/update-all"));
    if (state.rejectUpdate && url.endsWith("/update-all")) throw Error("disconnected");
    return Response.json({ ok: true, value: {} });
  };
  const owner = createPluginDetailUpdates(
    { get: () => undefined },
    {
      restart: async () => {
        state.calls++;
        return restart();
      },
      nativeUpdateActive: () => state.nativeBusy,
    },
  );
  t.after(() => owner.dispose());
  const close = owner.retain();
  await new Promise(setImmediate);
  return {
    owner,
    state,
    close,
    async poll() {
      t.mock.timers.tick(1000);
      await new Promise(setImmediate);
    },
  };
}

test("a user suite update restarts once after all installation writes end, even with the page closed", async (t) => {
  const { owner, state, close, poll } = await fixture(t);
  await owner.updateAll();
  close();
  state.phases = names.map(() => "pending-restart");
  await poll();
  await owner.restart();
  assert.equal(state.calls, 0);
  state.restartReady = true;
  await poll();
  assert.equal(state.calls, 1);
  const closeAgain = owner.retain();
  await poll();
  closeAgain();
  assert.equal(state.calls, 1);
  assert.ok(owner.getSnapshot().items.every((row) => row.state === "pending-restart"));
});

test("cancelled or failed normal restarts remain pending and can be retried from the shared owner", async (t) => {
  for (const outcome of ["cancelled", "failed"]) {
    await t.test(outcome, async (t) => {
      let recover = false;
      const { owner, state, poll } = await fixture(t, async () => {
        if (recover) return true;
        if (outcome === "failed") throw Error("restart failed");
        return false;
      });
      await owner.updateAll();
      state.phases = names.map(() => "pending-restart");
      state.restartReady = true;
      await poll();
      assert.equal(state.calls, 1);
      assert.equal(owner.getSnapshot().restart, outcome);
      await poll();
      assert.equal(state.calls, 1);
      recover = true;
      await Promise.all([owner.restart(), owner.restart()]);
      assert.equal(state.calls, 2);
      assert.equal(owner.getSnapshot().restart, "requested");
      assert.ok(owner.getSnapshot().items.every((row) => row.state === "pending-restart"));
    });
  }
});

test("partial, failed, restored, or unknown suites never trigger an automatic restart", async (t) => {
  for (const phase of ["installing", "failed", "restored", "unknown"]) {
    await t.test(phase, async (t) => {
      const { owner, state, poll } = await fixture(t);
      await owner.updateAll();
      state.phases = ["pending-restart", "pending-restart", phase];
      state.restartReady = true;
      await poll();
      assert.equal(state.calls, 0);
    });
  }
});

test("an unconfirmed submission stays manual even if a later status reports pending restart", async (t) => {
  const { owner, state, poll } = await fixture(t);
  state.rejectUpdate = true;
  await owner.updateAll();
  state.phases = names.map(() => "pending-restart");
  state.restartReady = true;
  await poll();
  assert.equal(state.calls, 0);
});

test("read-only recovery and checks do not restart an already pending installation", async (t) => {
  const { owner, state, poll } = await fixture(t);
  state.phases = names.map(() => "pending-restart");
  state.restartReady = true;
  await owner.resume();
  await poll();
  await owner.check();
  assert.equal(state.calls, 0);
});

test("an older Host without write-completion proof keeps the manual restart action", async (t) => {
  const { owner, state, poll } = await fixture(t);
  await owner.updateAll();
  state.phases = names.map(() => "pending-restart");
  state.restartReady = undefined;
  await poll();
  assert.equal(state.calls, 0);
  await owner.restart();
  assert.equal(state.calls, 1);
});

test("a long-running installation still restarts after its progress notice expires", async (t) => {
  const { owner, state, close, poll } = await fixture(t);
  await owner.updateAll();
  state.phases = names.map(() => "installing");
  close();
  t.mock.timers.tick(120_001);
  await new Promise(setImmediate);
  state.phases = names.map(() => "pending-restart");
  state.restartReady = true;
  await poll();
  assert.equal(state.calls, 1);
});

test("native client updates own the restart once they take over", async (t) => {
  for (const takeover of ["native", "company"]) {
    await t.test(takeover, async (t) => {
      const { owner, state, poll } = await fixture(t);
      await owner.updateAll();
      state.phases = names.map(() => "pending-restart");
      state.restartReady = true;
      if (takeover === "native") state.nativeBusy = true;
      else state.companyUpdate = { phase: "installing", desktopVersion: "2.0.0" };
      await poll();
      await owner.restart();
      assert.equal(state.calls, 0);
    });
  }
});

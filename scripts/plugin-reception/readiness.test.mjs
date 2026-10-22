import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { FIBER_ACTIVE, waitForMainPlugins, createReceptionReady } from "./readiness.mjs";

test("waits for a pending Host to finish asynchronous service initialization", async () => {
  const entry = {
    options: { name: "gea" },
    disabled: false,
    fiber: { state: 0 },
  };
  const loader = { entries: () => [entry] };
  let settled = false;
  const observation = waitForMainPlugins(loader, ["gea"], Date.now() + 5000).then(() => {
    settled = true;
  });
  await setTimeout(40);
  assert.equal(settled, false);
  entry.fiber.state = FIBER_ACTIVE;
  await observation;
  assert.equal(settled, true);
});

test("a Host that never activates still fails within the original deadline", async () => {
  const loader = {
    entries: () => [{ options: { name: "gea" }, disabled: false, fiber: { state: 0 } }],
  };
  await assert.rejects(
    waitForMainPlugins(loader, ["gea"], Date.now() + 30),
    /MAIN_PLUGIN_NOT_ACTIVE/,
  );
});

test("missing, duplicate and disabled mounts keep their original failures", async () => {
  const entry = {
    options: { name: "gea" },
    disabled: false,
    fiber: { state: FIBER_ACTIVE },
  };
  for (const entries of [[], [entry, entry]]) {
    await assert.rejects(
      waitForMainPlugins({ entries: () => entries }, ["gea"], Date.now() + 5000),
      /MAIN_PLUGIN_NOT_SINGLE_MOUNT/,
    );
  }
  await assert.rejects(
    waitForMainPlugins(
      { entries: () => [{ ...entry, disabled: true }] },
      ["gea"],
      Date.now() + 5000,
    ),
    /MAIN_PLUGIN_DISABLED/,
  );
});

test("reception readiness notifies late plugin startup listeners once, matching the launcher", () => {
  const readiness = createReceptionReady();
  const observed = [];
  readiness.service.onReady(() => observed.push("early"));
  const cancel = readiness.service.onReady(() => observed.push("cancelled"));
  cancel();
  readiness.commit();
  readiness.service.onReady(() => observed.push("late"));
  readiness.commit();
  assert.deepEqual(observed, ["early", "late"]);
});

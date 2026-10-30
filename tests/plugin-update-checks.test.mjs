import test from "node:test";
import assert from "node:assert/strict";
import {
  startPluginUpdateChecks,
  pluginUpdateCheckIntervalMs,
} from "../src/host/plugin-update-checks.ts";
const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};

test("checks at startup and every two hours from startup, stops on disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0;
  const owner = startPluginUpdateChecks(async () => {
    calls++;
  });
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(pluginUpdateCheckIntervalMs - 1);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  owner.dispose();
  t.mock.timers.tick(pluginUpdateCheckIntervalMs);
  await flush();
  await owner.check();
  assert.equal(calls, 2);
});

test("slow checks do not overlap and failed checks retry next interval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let calls = 0,
    reject;
  const owner = startPluginUpdateChecks(() => {
    calls++;
    return new Promise((_, fail) => {
      reject = fail;
    });
  });
  await flush();
  t.mock.timers.tick(pluginUpdateCheckIntervalMs * 2);
  await flush();
  assert.equal(calls, 1);
  reject(Error("offline"));
  await flush();
  t.mock.timers.tick(pluginUpdateCheckIntervalMs);
  await flush();
  assert.equal(calls, 2);
  owner.dispose();
  reject(Error("closed"));
  await flush();
});

test("different startup times keep different periodic check times", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let first = 0,
    second = 0;
  const one = startPluginUpdateChecks(async () => {
    first++;
  });
  await flush();
  t.mock.timers.tick(15000);
  const two = startPluginUpdateChecks(async () => {
    second++;
  });
  await flush();
  t.mock.timers.tick(pluginUpdateCheckIntervalMs - 15000);
  await flush();
  assert.deepEqual([first, second], [2, 1]);
  t.mock.timers.tick(15000);
  await flush();
  assert.deepEqual([first, second], [2, 2]);
  one.dispose();
  two.dispose();
});

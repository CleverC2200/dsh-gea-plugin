import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";

export const FIBER_ACTIVE = 2;

export function createReceptionReady() {
  let ready = false;
  const listeners = new Set();
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener();
          return () => {};
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    commit() {
      if (ready) return;
      ready = true;
      const committedListeners = [...listeners];
      for (const listener of committedListeners) listener();
      listeners.clear();
    },
  };
}

export async function waitForMainPlugins(loader, names, deadline) {
  while (true) {
    const entries = [...loader.entries()];
    const active = names.map((name) => {
      const found = entries.filter((entry) => entry.options.name === name);
      assert.equal(found.length, 1, "MAIN_PLUGIN_NOT_SINGLE_MOUNT");
      assert.equal(found[0].disabled, false, "MAIN_PLUGIN_DISABLED");
      return found[0].fiber?.state === FIBER_ACTIVE;
    });
    if (active.every(Boolean)) return;
    assert(Date.now() < deadline, "MAIN_PLUGIN_NOT_ACTIVE");
    await setTimeout(25);
  }
}

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const observations = new AsyncLocalStorage();

export function withSourcePhaseObserver(observer, run) {
  const parent = observations.getStore();
  return observations.run(
    {
      ...parent,
      observer,
      observationId: parent?.observationId ?? randomUUID(),
      sequence: parent?.sequence ?? { next: 0 },
    },
    run,
  );
}

export function sourcePhase(step, run) {
  return function (...args) {
    if (!observations.getStore()) return run(...args);
    return measureSourcePhase(step, () => run(...args));
  };
}

export function measureSourcePhase(step, run, counts) {
  const parent = observations.getStore();
  if (!parent) return run();
  const id = ++parent.sequence.next;
  const started = performance.now();
  return observations.run({ ...parent, parentId: id }, async () => {
    let status = "failed";
    try {
      const result = await run();
      status = "passed";
      return result;
    } finally {
      try {
        const result = parent.observer({
          event: "source-preparation-phase-completed",
          observationId: parent.observationId,
          processId: process.pid,
          id,
          parentId: parent.parentId ?? null,
          step,
          status,
          durationMs: performance.now() - started,
          ...counts?.(),
        });
        if (result?.then) Promise.resolve(result).catch(() => {});
      } catch {}
    }
  });
}

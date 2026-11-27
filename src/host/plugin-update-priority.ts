import { setTimeout as delay } from "node:timers/promises";

export function createPluginUpdatePriority() {
  let companyOperations = 0;
  let managedPreparation: { controller: AbortController; completed: Promise<unknown> } | undefined;
  return {
    async company<T>(run: () => Promise<T>): Promise<T> {
      companyOperations++;
      try {
        if (managedPreparation) {
          const { controller, completed } = managedPreparation;
          controller.abort();
          const timeout = new AbortController();
          try {
            await Promise.race([
              completed.catch(() => undefined),
              delay(12_000, undefined, { signal: timeout.signal, ref: false }),
            ]);
          } finally {
            timeout.abort();
          }
        }
        return await run();
      } finally {
        companyOperations--;
      }
    },
    async managed<T>(
      signal: AbortSignal,
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<T | undefined> {
      if (companyOperations || managedPreparation) return;
      const controller = new AbortController();
      const completed = Promise.resolve().then(() =>
        run(AbortSignal.any([signal, controller.signal])),
      );
      managedPreparation = { controller, completed };
      try {
        return await completed;
      } finally {
        managedPreparation = undefined;
      }
    },
  };
}

export type PluginUpdatePriority = ReturnType<typeof createPluginUpdatePriority>;

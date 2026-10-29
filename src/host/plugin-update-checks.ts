export const pluginUpdateCheckIntervalMs = 2 * 60 * 60 * 1000;

export function startPluginUpdateChecks(check: () => Promise<void>) {
  let pending: Promise<void> | undefined;
  let disposed = false;
  const run = () => {
    if (disposed) return Promise.resolve();
    return (pending ??= Promise.resolve()
      .then(check)
      .catch(() => {})
      .finally(() => {
        pending = undefined;
      }));
  };
  const timer = setInterval(() => void run(), pluginUpdateCheckIntervalMs);
  timer.unref?.();
  void run();
  return {
    check: run,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

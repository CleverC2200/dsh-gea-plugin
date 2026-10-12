/** Source preparation has its own finite deadline; action and Node cancellation stay authoritative. */
import nodeTest from "node:test";
const contexts = new WeakMap();
const setupLimit = 90000;
export default function sourceTest(name, options, run) {
  if (typeof options === "function") {
    run = options;
    options = {};
  }
  const { sourceSetupTimeoutMs = setupLimit, sourceSetupCount, ...nodeOptions } = options ?? {};
  if (process.env.GEA_TEST_SOURCE_CORE !== "1" || !Number.isFinite(nodeOptions.timeout))
    return nodeTest(name, nodeOptions, run);
  if (
    !Number.isFinite(sourceSetupTimeoutMs) ||
    sourceSetupTimeoutMs <= 0 ||
    sourceSetupTimeoutMs > setupLimit
  )
    throw Error("SOURCE_SETUP_LIMIT_INVALID");
  if (
    sourceSetupCount !== undefined &&
    (!Number.isSafeInteger(sourceSetupCount) || sourceSetupCount <= 0)
  )
    throw Error("SOURCE_SETUP_COUNT_INVALID");
  const controller = new AbortController();
  return nodeTest(
    name,
    {
      ...nodeOptions,
      timeout: nodeOptions.timeout + (sourceSetupCount ?? 1) * sourceSetupTimeoutMs,
      signal: nodeOptions.signal
        ? AbortSignal.any([nodeOptions.signal, controller.signal])
        : controller.signal,
    },
    async (t) => {
      let timer, phaseStarted;
      const state = {
        actionRemaining: nodeOptions.timeout,
        setupRemaining: sourceSetupCount,
        depth: 0,
        phase: "action",
        switchTo(phase) {
          clearTimeout(timer);
          if (state.phase === "action" && phaseStarted !== undefined)
            state.actionRemaining -= performance.now() - phaseStarted;
          state.phase = phase;
          phaseStarted = performance.now();
          if (t.signal.aborted) return;
          timer = setTimeout(
            () =>
              controller.abort(
                Error(phase === "setup" ? "SOURCE_SETUP_TIMEOUT" : "SOURCE_ACTION_TIMEOUT"),
              ),
            phase === "setup" ? sourceSetupTimeoutMs : Math.max(0, state.actionRemaining),
          );
        },
      };
      contexts.set(t, state);
      state.switchTo("action");
      try {
        return await run(t);
      } finally {
        clearTimeout(timer);
        contexts.delete(t);
      }
    },
  );
}
export async function withSourceSetup(t, prepare) {
  t.signal?.throwIfAborted();
  const state = contexts.get(t);
  if (state?.depth === 0 && state.setupRemaining !== undefined) {
    if (state.setupRemaining === 0) throw Error("SOURCE_SETUP_COUNT_EXCEEDED");
    state.setupRemaining--;
  }
  if (state && state.depth++ === 0) state.switchTo("setup");
  try {
    const result = await prepare();
    t.signal?.throwIfAborted();
    return result;
  } finally {
    if (state && --state.depth === 0) state.switchTo("action");
  }
}

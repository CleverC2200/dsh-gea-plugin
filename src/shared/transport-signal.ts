export function transportSignal(source: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    const timeout = source.reason instanceof Error && source.reason.name === "TimeoutError";
    controller.abort(
      new DOMException(
        timeout ? "Request timed out" : "Request aborted",
        timeout ? "TimeoutError" : "AbortError",
      ),
    );
  };
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => source.removeEventListener("abort", abort),
  };
}

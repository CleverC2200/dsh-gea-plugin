/** Keep transport libraries from mutating Harness cancellation records. */

/** Relay cancellation using a transport-owned error rather than the caller's durable reason.
 * @param source - Caller-owned signal, whose reason may be a Session event value.
 * @returns Signal for Fetch and a disposer for the relay listener.
 */
export function transportSignal(source: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new DOMException("Request aborted", "AbortError"));
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => source.removeEventListener("abort", abort),
  };
}

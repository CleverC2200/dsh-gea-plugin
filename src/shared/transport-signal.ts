/**
 * 用新的 AbortController 转发取消，避免把上游 Session 事件对象泄露给 Fetch 或第三方库。
 * @param source 调用方持有的信号，其 reason 可能是 Session 事件对象。
 * @returns 供 Fetch 使用的信号及取消监听器释放函数。
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

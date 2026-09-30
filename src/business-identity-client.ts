/** Read the Host-owned authority; clients never derive a scope from user labels. */
async function requestBusinessIdentityScope(signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(5000);
  try {
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch("/api/gea-html/identity", { cache: "no-store", signal: requestSignal });
    const value = await response.json();
    requestSignal.throwIfAborted();
    if (!response.ok) throw Error(value.error ?? "登录状态读取失败，请重试。");
    return typeof value.scope === "string" ? value.scope : null;
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw Error("登录状态读取超时，请重试。");
    throw error;
  }
}

/** One reader per GEA client shares observations from polling and page opens. */
export function createBusinessIdentityReader() {
  let scope: string | null | undefined;
  let issued = 0, accepted = 0;
  return async (signal?: AbortSignal): Promise<string | null> => {
    const request = ++issued;
    const next = await requestBusinessIdentityScope(signal);
    if (request < accepted && scope !== undefined) return scope;
    const previous = scope;
    accepted = request;
    scope = next;
    if (previous !== undefined && previous !== next)
      window.dispatchEvent(new CustomEvent("gea-business-identity-changed", { detail: { scope: next } }));
    return next;
  };
}

/** Read the Host-owned authority; clients never derive a scope from user labels. */
export async function readBusinessIdentityScope(signal?: AbortSignal): Promise<string | null> {
  const timeout = AbortSignal.timeout(5000);
  try {
    const response = await fetch("/api/gea-html/identity", {
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? "登录状态读取失败，请重试。");
    return typeof value.scope === "string" ? value.scope : null;
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw Error("登录状态读取超时，请重试。");
    throw error;
  }
}

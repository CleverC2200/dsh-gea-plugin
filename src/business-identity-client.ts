import type { Business } from "./host/business.ts";

type IdentityStatus = Pick<ReturnType<Business["status"]>, "environment" | "authenticated" | "loginState" | "user">;
export type IdentitySnapshot = { state: "unknown" | "confirmed" | "error"; scope: string | null; status: IdentityStatus | null; error?: string };

/** Read the Host-owned authority; clients never derive a scope from user labels. */
async function requestBusinessIdentityScope(signal?: AbortSignal): Promise<{ scope: string | null; status: IdentityStatus | null }> {
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(5000);
  try {
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch("/api/gea-html/identity", { cache: "no-store", signal: requestSignal });
    const value = await response.json();
    requestSignal.throwIfAborted();
    if (!response.ok) throw Error(value.error ?? "登录状态读取失败，请重试。");
    return { scope: typeof value.scope === "string" ? value.scope : null, status: value.status ?? null };
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw Error("登录状态读取超时，请重试。");
    throw error;
  }
}

/** One read-only projection per GEA client. The Host remains the authority. */
export function createBusinessIdentityReader() {
  let snapshot: IdentitySnapshot = { state: "unknown", scope: null, status: null };
  let issued = 0, accepted = 0;
  let initial: Promise<string | null> | undefined;
  let initialController: AbortController | undefined;
  const listeners = new Set<() => void>();
  const read = async (signal?: AbortSignal): Promise<string | null> => {
    signal?.throwIfAborted();
    const request = ++issued;
    try {
      const next = await requestBusinessIdentityScope(signal);
      signal?.throwIfAborted();
      if (request < accepted) return snapshot.scope;
      const previous = snapshot;
      accepted = request;
      snapshot = { state: "confirmed", ...next };
      if (previous.state !== "confirmed" || previous.scope !== next.scope || previous.status?.loginState !== next.status?.loginState ||
          previous.status?.environment !== next.status?.environment || previous.status?.user?.name !== next.status?.user?.name ||
          previous.status?.user?.avatar !== next.status?.user?.avatar) {
        for (const listener of listeners) listener();
        if (previous.state !== "unknown" && previous.scope !== next.scope)
          window.dispatchEvent(new CustomEvent("gea-business-identity-changed", { detail: { scope: next.scope } }));
      }
      return next.scope;
    } catch (error) {
      if (!signal?.aborted && request >= accepted && snapshot.state !== "confirmed") {
        snapshot = { ...snapshot, state: "error", error: error instanceof Error ? error.message : String(error) };
        for (const listener of listeners) listener();
      }
      throw error;
    }
  };
  const reader = ((signal?: AbortSignal) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (snapshot.state !== "unknown") return read(signal);
    if (!initial) {
      initialController = new AbortController();
      initial = read(initialController.signal).finally(() => { initial = undefined; initialController = undefined; });
    }
    if (!signal) return initial;
    return new Promise<string | null>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void initial!.then(resolve, reject).then(() => signal.removeEventListener("abort", abort));
    });
  }) as typeof read & {
    getSnapshot(): IdentitySnapshot;
    subscribe(listener: () => void): () => void;
    start(): () => void;
    refresh(signal?: AbortSignal): Promise<string | null>;
  };
  reader.getSnapshot = () => snapshot;
  reader.subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  reader.refresh = read;
  reader.start = () => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await reader(controller.signal); } catch { /* Keep the last Host confirmation. */ }
      if (!controller.signal.aborted) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { controller.abort(); initialController?.abort(); clearTimeout(timer); };
  };
  return reader;
}

import { randomUUID } from "node:crypto";
import { LAYER_POLICY } from "./capability/layers.ts";

type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Conversation-owned leases; models and HTML cannot choose another conversation. Destruction releases the owning page's projections. */
export function createHtmlSessions(onClose?: (plugin: string, session: string) => void) {
  const pages = new Map<string, any>();
  const destroy = (key: string) => {
    const page = pages.get(key);
    if (!page) return;
    page.controller.abort();
    for (const item of page.pending.values()) {
      clearTimeout(item.timer);
      item.reject(Error("页面已关闭或登录已变化"));
    }
    pages.delete(key);
    onClose?.(page.plugin, page.session);
  };
  return {
    open(plugin: string, session: string, credentials: any, access: any) {
      if (!/^session-[a-z0-9-]{20,80}$/.test(session))
        throw Error("INVALID_CONVERSATION");
      for (const [key, p] of pages)
        if (p.plugin === plugin && p.session === session) destroy(key);
      const lease = randomUUID();
      pages.set(lease, {
        plugin,
        session,
        credentials,
        access,
        context: null,
        actions: [],
        queue: [],
        pending: new Map<string, Pending>(),
        controller: new AbortController(),
        expires: Date.now() + 300000,
      });
      return lease;
    },
    get(lease: string, plugin?: string) {
      const p = pages.get(lease);
      if (!p || p.expires < Date.now()) {
        destroy(lease);
        throw Error("PAGE_LEASE_EXPIRED");
      }
      if (plugin && p.plugin !== plugin) throw Error("WRONG_PLUGIN");
      // This is an idle lease, not a five-minute cap on an actively used page.
      // GEA still validates delegation-token expiry on every business request;
      // logout/identity changes explicitly destroy all leases.
      p.expires = Date.now() + 300000;
      return p;
    },
    /** 这个会话当前有没有打开该插件的业务页面（模型读页面之前先问一次，避免直接抛错）。 */
    has(plugin: string, session: string): boolean {
      for (const p of pages.values()) if (p.plugin === plugin && p.session === session) return true;
      return false;
    },
    close: destroy,
    clear() {
      for (const key of pages.keys()) destroy(key);
    },
    async invoke(
      plugin: string,
      session: string,
      name: string,
      args: any,
      signal: AbortSignal,
    ) {
      const pair = [...pages].find(
        ([, p]) => p.plugin === plugin && p.session === session,
      );
      if (!pair) throw Error("该会话还没有打开业务页面：请先在左侧「功能区」打开对应业务页面再操作");
      const p = this.get(pair[0]);
      if (name === "context")
        return {
          context: p.context,
          actions: p.actions,
          source: "page-observation",
          authority: "GEA owns data permissions; drafts are not submitted",
        };
      if (!p.actions.some((a: any) => a.name === name))
        throw Error("PAGE_ACTION_NOT_REGISTERED");
      signal.throwIfAborted();
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => finish(Error("PAGE_ACTION_CANCELLED"));
        const finish = (error?: Error, value?: any) => {
          const item = p.pending.get(id);
          if (!item) return;
          clearTimeout(item.timer);
          p.pending.delete(id);
          p.queue = p.queue.filter((m: any) => m.id !== id);
          signal.removeEventListener("abort", abort);
          error ? reject(error) : resolve(value);
        };
        const timer = setTimeout(
          () => finish(Error("PAGE_ACTION_TIMEOUT")),
          // 页面动作可能落在提交/审批这两层，超时按能力层策略表走。
          LAYER_POLICY.submit.timeoutMs,
        );
        p.pending.set(id, {
          resolve: (v: any) => finish(undefined, v),
          reject: (e: Error) => finish(e),
          timer,
        });
        signal.addEventListener("abort", abort, { once: true });
        p.queue.push({ type: "invoke", id, name, arguments: args });
      });
    },
    reply(lease: string, message: any) {
      const page = this.get(lease),
        item = page.pending.get(message.id);
      if (!item) return;
      message.error
        ? item.reject(Error(String(message.error)))
        : item.resolve(message.result);
    },
  };
}

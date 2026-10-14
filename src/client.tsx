import { mountPluginUpdatesClient } from "./plugin-updates-client.ts";
import type {} from "@cleverc2200/dsh-agent-workbench/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import { createBusinessIdentityReader } from "./business-identity-client.ts";

export const inject = [];
/** GEA contributes business views and its read-only identity. Workbench owns navigation and HTML. */
export function apply(ctx: Context): void {
  ctx.effect(() => mountPluginUpdatesClient(ctx));
  const identity = createBusinessIdentityReader();
  ctx.provide("geaIdentity", {
    getSnapshot: identity.getSnapshot,
    subscribe: identity.subscribe,
    readScope: identity.readScope,
  });
  ctx.effect(() => identity.start());
  ctx.provide("businessAccount", {
    getSnapshot: identity.getSnapshot,
    subscribe: identity.subscribe,
    startLogin: async (signal, environment) => {
      const challenge = await request<
        Awaited<ReturnType<Context["businessAccount"]["startLogin"]>>
      >("login/start", { environment }, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
      await identity.refresh(signal);
      return challenge;
    },
    pollLogin: async (loginId, signal) => {
      const value = await request<{ status: string }>(
        "login/poll",
        { loginId },
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      );
      if (value.status === "expired") throw Error("二维码已过期，请重新登录。");
      if (value.status === "authenticated") await identity.refresh(signal);
      return value.status === "authenticated";
    },
    logout: async (signal) => {
      const value = await request<{ authenticated: boolean }>(
        "logout",
        {},
        AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      );
      if (value.authenticated !== false) throw Error("LOGOUT_FAILED");
      await identity.refresh(signal);
    },
  });
}
async function request<T>(
  endpoint: string,
  payload: object = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/api/gea-proof/" + endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true)
    throw Error(result.error?.message ?? result.error?.code ?? "GEA_REQUEST_FAILED");
  return result.value as T;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    geaIdentity: import("./business-identity-client.ts").BusinessIdentityProjection;
  }
}
export { pluginPackageVersion } from "./plugin-package-version.ts";

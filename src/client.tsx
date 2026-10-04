import type { Context } from "@deepseek-ai/cordis";
import type {} from "@cleverc2200/dsh-agent-workbench/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { zh, en, type CopyKey } from "./client/locales.ts";
import { Inbox } from "./client/inbox.tsx";
import { DesktopNavigation, createNavigationSelection, type ReadyNavigation } from "./client/desktop-navigation.tsx";
import { createBusinessIdentityReader } from "./business-identity-client.ts";
import { ApiLogCenter } from "./workbench/api-log-center.tsx";
import nativeCss from "./client/native-pages.css";
import categoryPlanPrototype from "./workbench/prototypes/category-plan-v5.html";
import mpsPlanPrototype from "./workbench/prototypes/mps-plan-v0.html";
import regionalPlanPrototype from "./workbench/prototypes/regional-plan-v9.html";

export const inject = ["slots", "layout", "locale", "agentWorkbench", "theme"];
const PANEL = "gea-proof" as MainPanelId;
const INBOX = "gea-inbox" as MainPanelId;
const API_LOG_PANEL = "gea-api-log" as MainPanelId;
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap { geaProof: CopyKey; }
}

/** GEA contributes business views and its read-only identity. Workbench owns navigation and HTML. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register("geaProof", { zh, en }));
  const t = ctx.locale.bind("geaProof");
  const identity = createBusinessIdentityReader();
  ctx.provide("geaIdentity", { getSnapshot: identity.getSnapshot, subscribe: identity.subscribe, readScope: identity.readScope });
  ctx.effect(() => identity.start());
  const incoming = createNavigationSelection();

  function Workbench() {
    const frame = useRef<HTMLIFrameElement>(null);
    const [loaded, setLoaded] = useState(false);
    const snapshot = useSyncExternalStore(identity.subscribe, identity.getSnapshot);
    const navigation = useSyncExternalStore(incoming.subscribe, incoming.getSnapshot);
    const send = () => {
      frame.current?.contentWindow?.postMessage({ type: "gea:identity-snapshot", snapshot: identity.getSnapshot() }, window.location.origin);
      const theme = ctx.theme.getTheme();
      frame.current?.contentWindow?.postMessage({ protocol: "agent-workbench-theme", dark: theme.active.colorScheme === "dark", fontSize: theme.fontSize }, window.location.origin);
    };
    useEffect(send, [snapshot]);
    useEffect(() => { const stop = ctx.on("theme/change", send); return () => { stop(); }; }, []);
    useEffect(() => {
      if (loaded && snapshot.status?.authenticated && navigation?.panel === PANEL) navigation.visible();
    }, [loaded, snapshot, navigation]);
    useEffect(() => {
      const changed = (event: MessageEvent) => {
        if (event.source === frame.current?.contentWindow && event.origin === window.location.origin && event.data?.type === "gea:identity")
          void identity.refresh().catch(() => {});
      };
      window.addEventListener("message", changed);
      return () => window.removeEventListener("message", changed);
    }, []);
    const language = ctx.locale.getSnapshot().active;
    return <iframe ref={frame} title={t("approvalTitle")} className="agent-workbench-html" src={`/api/gea-proof/workbench?locale=${encodeURIComponent(language)}`} onLoad={() => { setLoaded(true); send(); }} />;
  }
  function InboxPage() {
    const navigation = useSyncExternalStore(incoming.subscribe, incoming.getSnapshot);
    return <section className="agent-workbench-ui gea-native-page" style={{ height: "100%", overflow: "auto" }}><style>{nativeCss}</style><Inbox t={t} navigation={navigation?.panel === INBOX ? navigation : null} /></section>;
  }
  function LogPage() {
    const [environment, setEnvironment] = useState<"production" | "test">("production");
    useEffect(() => {
      const controller = new AbortController();
      void request<{ environment: "production" | "test" }>("status", {}, controller.signal).then(status => {
        if (!controller.signal.aborted) setEnvironment(status.environment);
      }).catch(() => {});
      return () => controller.abort();
    }, []);
    return <section className="agent-workbench-ui gea-native-page" style={{ height: "100%" }}><style>{nativeCss}</style><ApiLogCenter environment={environment} request={request} onClose={() => ctx.layout.selectPanel(PANEL)} /></section>;
  }
  for (const [id, label, component] of [
    [PANEL, "salesPlan", Workbench], [INBOX, "businessInbox", InboxPage], [API_LOG_PANEL, "apiLog", LogPage],
  ] as const) ctx.slots.inject("main", () => {
    const unregister = ctx.agentWorkbench.register({id, label: () => t(label)});
    const dispose = ctx.slots.register({ name: "main", key: id }, component);
    return () => { dispose(); unregister(); };
  });
  ctx.slots.inject("main", () => {
    const disposers = [
      ctx.agentWorkbench.registerHtml({ id: "gea-regional-plan" as MainPanelId, label: () => t("regionalPlanWorkbench"), html: regionalPlanPrototype }),
      ctx.agentWorkbench.registerHtml({ id: "plan-region-category" as MainPanelId, label: () => t("categoryPlanWorkbench"), html: categoryPlanPrototype }),
      ctx.agentWorkbench.registerHtml({ id: "plan-category-production" as MainPanelId, label: () => t("mpsPlanWorkbench"), html: mpsPlanPrototype }),
    ];
    return () => disposers.reverse().forEach(dispose => dispose());
  });
  const openNavigation = async (target: ReadyNavigation, signal: AbortSignal) => {
    if (![PANEL, INBOX].includes(target.panel as MainPanelId)) throw Error("NAVIGATION_TARGET_UNSUPPORTED");
    signal.throwIfAborted();
    let clear = () => {};
    const arrival = new Promise<void>((resolve, reject) => {
      const cancel = () => { if (incoming.getSnapshot()?.receipt === target.receipt) incoming.set(null); reject(Error("NAVIGATION_REQUEST_CANCELLED")); };
      const timer = setTimeout(() => { cancel(); }, 30000);
      clear = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      signal.addEventListener("abort", cancel, {once: true});
      incoming.set({...target, visible: resolve, failed: reject});
      if (signal.aborted) cancel();
    });
    try { await Promise.all([ctx.agentWorkbench.open(target.panel as MainPanelId), arrival]); signal.throwIfAborted(); }
    finally { clear(); }
  };
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "gea-desktop-navigation" }, () => <DesktopNavigation t={t} open={openNavigation} login={() => ctx.layout.selectPanel(PANEL)} />));
}

async function request<T>(endpoint: string, payload: object = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/gea-proof/" + endpoint, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw Error(result.error?.message ?? result.error?.code ?? "GEA_REQUEST_FAILED");
  return result.value as T;
}

declare module "@deepseek-ai/cordis" { interface Context { geaIdentity: import("./business-identity-client.ts").BusinessIdentityProjection; } }

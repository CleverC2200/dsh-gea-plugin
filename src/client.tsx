import type { Context } from "@deepseek-ai/cordis";
import type {WorkbenchPageExecution,PageExecutionConnection} from "@cleverc2200/dsh-agent-workbench/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import {brandString} from "@deepseek-ai/dsh-brand";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { zh, en, type CopyKey } from "./client/locales.ts";
import { Inbox } from "./client/inbox.tsx";
import { DesktopNavigation, createNavigationSelection, type ReadyNavigation } from "./client/desktop-navigation.tsx";
import { createBusinessIdentityReader } from "./business-identity-client.ts";
import { ApiLogCenter } from "./workbench/api-log-center.tsx";
import nativeCss from "./client/native-pages.css";

export const inject = ["slots", "layout", "locale", "agentWorkbench", "theme", "remote", "remote.session"];
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
    [INBOX, "businessInbox", InboxPage], [API_LOG_PANEL, "apiLog", LogPage],
  ] as const) ctx.slots.inject("main", () => {
    const unregister = ctx.agentWorkbench.register({id, label: () => t(label)});
    const dispose = ctx.slots.register({ name: "main", key: id }, component);
    return () => { dispose(); unregister(); };
  });
  const execution:WorkbenchPageExecution={
    identity,
    open:async(page,sessionId,resourceId,signal)=>{
      const scope=await identity.readScope(signal);if(!scope)throw Error("请先登录 GEA");
      if(page.kind==="html"){
        const result=await htmlRequest<{lease:string}>(page.pluginId+"/open",{session:sessionId,agentPreset:resourceId,scope},signal);
        signal.throwIfAborted();return {page,sessionId,resourceId,scope,lease:result.lease};
      }
      if(resourceId!==page.resourceId)throw Error("PAGE_RESOURCE_NOT_ALLOWED");
      const result=await request<{lease:string}>("surface",{sessionId,menu:page.id,title:typeof page.label==="function"?page.label():page.label},signal);
      signal.throwIfAborted();return {page,sessionId,resourceId,scope,lease:result.lease};
    },
    call:async(connection,method,parameters,signal)=>{
      if(connection.page.kind!=="html"||!connection.lease)throw Error("HTML_CONNECTION_REQUIRED");
      return htmlRequest(connection.page.pluginId+"/call",{lease:connection.lease,method,parameters},signal);
    },
    close:async(connection)=>{
      if(connection.page.kind==="html"&&connection.lease)await htmlRequest(connection.page.pluginId+"/call",{lease:connection.lease,method:"close"},AbortSignal.timeout(5000));
      else await request("workbench/context",{sessionId:connection.sessionId,lease:connection.lease,context:null},AbortSignal.timeout(5000));
    },
    prompt:async(connection,text,signal)=>{
      const currentScope=await identity.refresh(signal);
      signal.throwIfAborted();if(currentScope!==connection.scope)throw Error("PAGE_IDENTITY_CHANGED");
      const result=await ctx.remote.session.prompt({sessionId:connection.sessionId as Parameters<typeof ctx.remote.session.prompt>[0]["sessionId"],requestId:brandString<Parameters<typeof ctx.remote.session.prompt>[0]["requestId"]>(crypto.randomUUID()),mode:"queue",content:[{type:"text",text}]});
      signal.throwIfAborted();if(!result.ok)throw Error(result.error.message);
    },
  };
  ctx.provide("geaPageExecution",execution);
  ctx.slots.inject("main",()=>ctx.agentWorkbench.registerFrame({id:PANEL,label:()=>t("salesPlan"),kind:"native",resourceId:"gea-readonly",src:()=>`/api/gea-proof/workbench?locale=${encodeURIComponent(ctx.locale.getSnapshot().active)}`,onVisible:()=>{const navigation=incoming.getSnapshot();if(identity.getSnapshot().status?.authenticated&&navigation?.panel===PANEL)navigation.visible();}}));
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

async function htmlRequest<T>(endpoint:string,payload:object|undefined,signal:AbortSignal):Promise<T>{
 const response=await fetch("/api/gea-html/"+endpoint,{method:payload===undefined?"GET":"POST",credentials:"same-origin",headers:payload===undefined?undefined:{"content-type":"application/json"},body:payload===undefined?undefined:JSON.stringify(payload),cache:"no-store",signal});
 const value=await response.json();signal.throwIfAborted();if(!response.ok)throw Error(value.error??"GEA_HTML_FAILED");return value as T;
}

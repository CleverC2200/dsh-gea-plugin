import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import { businessMenuLabel } from "./business-navigation.ts";
import type { BusinessIdentityProjection } from "./business-identity-client.ts";
import { startPageBridgeClient } from "./page-bridge/client.ts";
import type { PageInteraction } from "../packages/page-interaction/src/client.ts";
export function registerHtmlClient(ctx: any, pageInteraction: PageInteraction | undefined, identity: BusinessIdentityProjection, t: (key: "pageDiscoveryFailed" | "retryAction") => string) {
  async function request(path: string, body?: any, signal?: AbortSignal) {
    const response = await fetch("/api/gea-html/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error ?? "GEA 页面连接失败");
    return value;
  }
  function Frame({ plugin, useMainSessionId }: any) {
    const workbenchId = plugin.workbenchId ?? plugin.id;
    const session = useMainSessionId((id: string | undefined) => id),
      frame = useRef<HTMLIFrameElement>(null),
      [connection, setConnection] = useState<any>(null),
      [error, setError] = useState(""),
      [revision, setRevision] = useState(0),
      [opened, setOpened] = useState(false),
      [agents, setAgents] = useState<Array<{ preset: string; label: string }>>([]),
      [switchingAgent, setSwitchingAgent] = useState(false);
    const preset = session
      ? ctx.sessions?.list?.getSnapshot()?.byId?.[session]?.projectionValues?.agentPreset
      : undefined;
    const binding = useRef<any>(null);
    const readyBinding = useRef<Promise<any>>(Promise.resolve(null));
    const rebindPage = useRef<((value: any) => void) | null>(null);
    const suspendPage = useRef<(() => void) | null>(null);
    const registrations = useRef(new Map<string, any>());
    const pageContext = useRef<any>(undefined);
    const identityRevision = useRef(0);
    useEffect(() => {
      const changed = () => {
        identityRevision.current++;
        binding.current = null;
        readyBinding.current = Promise.resolve(null);
        setOpened(false);
        setConnection(null);
        setAgents([]);
        setSwitchingAgent(false);
        setError("登录身份已变化，请重新打开业务页");
        setRevision((value) => value + 1);
      };
      window.addEventListener("gea-business-identity-changed", changed);
      return () => window.removeEventListener("gea-business-identity-changed", changed);
    }, []);
    useEffect(() => {
      if (plugin.mock) return;
      const controller = new AbortController();
      const revisionAtStart = identityRevision.current;
      void request(plugin.id + "/agents", undefined, controller.signal)
        .then((value) => { if (!controller.signal.aborted && revisionAtStart === identityRevision.current) setAgents(value); })
        .catch((failure) => { if (!controller.signal.aborted && revisionAtStart === identityRevision.current) setError(failure.message); });
      return () => controller.abort();
    }, [plugin.id, revision, opened]);
    useEffect(() => {
      let active = true;
      const revisionAtStart = identityRevision.current;
      let hide = () => {};
      const defaultPreset = plugin.presetHidden === true ? "auto-negotiation" : `gea-html-${plugin.id}`;
      void (async () => {
        const committed = await ctx.agentWorkbench.open(workbenchId, undefined, undefined, defaultPreset);
        if (committed === false) {
          if (active && revisionAtStart === identityRevision.current)
            setError("页面会话切换未完成，请重新打开业务页");
          return;
        }
        if (active && revisionAtStart === identityRevision.current) {
          hide = ctx.agentWorkbench.showConversation(workbenchId);
          setOpened(true);
        }
      })()
        .catch((e: Error) => {
          if (active && revisionAtStart === identityRevision.current) setError(e.message);
        });
      return () => {
        active = false;
        hide();
      };
    }, [workbenchId, revision]);
    const switchAgent = async (nextPreset: string) => {
      if (switchingAgent || !agents.some((agent) => agent.preset === nextPreset)) return;
      const revisionAtStart = identityRevision.current;
      setSwitchingAgent(true);
      setError("");
      try {
        await ctx.agentWorkbench.open(workbenchId, nextPreset, undefined, nextPreset);
      } catch (failure) {
        if (revisionAtStart === identityRevision.current)
          setError(failure instanceof Error ? failure.message : "能力切换失败");
      } finally {
        if (revisionAtStart === identityRevision.current) setSwitchingAgent(false);
      }
    };
    useEffect(() => {
      if (!session || !opened) {
        readyBinding.current = Promise.resolve(null);
        return;
      }
      const controller = new AbortController();
      const revisionAtStart = identityRevision.current;
      let lease: string | undefined;
      pageContext.current = undefined;
      setError("");
      const opening = identity.readScope(controller.signal)
        .then(scope => request(plugin.id + "/open", { session, agentPreset: preset, scope }, controller.signal))
        .then((result) => {
          lease = result.lease;
          if (controller.signal.aborted || revisionAtStart !== identityRevision.current) return null;
          const next = { ...result, session };
          binding.current = next;
          return Promise.all([
            ...[...registrations.current.values()].map(parameters => request(plugin.id + "/call", { lease, method: "register", parameters }, controller.signal)),
            ...(pageContext.current === undefined ? [] : [request(plugin.id + "/call", { lease, method: "context", parameters: pageContext.current }, controller.signal)]),
          ]).then(() => {
            if (controller.signal.aborted || revisionAtStart !== identityRevision.current) return null;
            // A new conversation changes authority, never the mounted business page.
            setConnection((current: any) => current ?? next);
            rebindPage.current?.(next);
            return next;
          });
        })
        .catch((e) => {
          if (!controller.signal.aborted && revisionAtStart === identityRevision.current) setError(e.message);
          return null;
        });
      readyBinding.current = opening;
      return () => {
        controller.abort();
        suspendPage.current?.();
        if (binding.current?.lease === lease) binding.current = null;
        if (lease)
          void request(plugin.id + "/call", { lease, method: "close" }).catch(
            () => {},
          );
      };
    }, [session, preset, revision, opened]);
    useEffect(() => {
      if (!pageInteraction || !connection || !session || !frame.current) return;
      return pageInteraction.bindFrame({
        frame: frame.current, sessionId: session, page: plugin.name,
        surface: `gea-html-${plugin.id}`, tool: "gea_plugin_page_apply",
        referenceLease: () => binding.current?.session === session ? binding.current.lease : undefined,
      });
    }, [connection, session]);
    useEffect(() => {
      if (!connection) return;
      const controller = new AbortController(),
        port = new MessageChannel();
      let elements: unknown[] | null = null;
      const pendingApplies = new Map<
        string,
        (result: { applied: boolean; error?: string }) => void
      >();
      let connected = false,
        pollTimer: any;
      let readyWindow: Window | null = null;
      const connectPage = async () => {
        if (!readyWindow || connected || controller.signal.aborted) return;
        const current = await readyBinding.current;
        if (
          !current || current !== binding.current || connected ||
          controller.signal.aborted || readyWindow !== frame.current?.contentWindow
        ) return;
        connected = true;
        readyWindow.postMessage(
          {
            protocol: "gea-html-v2",
            type: "connect",
            context: { plugin: plugin.id, session: current.session },
          },
          { targetOrigin: "*", transfer: [port.port2] },
        );
      };
      let themeRequested = false;
      // Forward the current ui-theme projection; pages present their own shared stylesheet.
      const sendTheme = () => {
        if (!connected || !themeRequested || !binding.current || controller.signal.aborted) return;
        const theme = ctx.theme.getTheme();
        port.port1.postMessage({
          type: "theme",
          context: { plugin: plugin.id, session: binding.current.session },
          version: "1.0.0",
          colorScheme: theme.active.colorScheme,
          fontSize: theme.fontSize,
          tokens: theme.active.tokens,
        });
      };
      const stopTheme = ctx.on("theme/change", sendTheme);
      const pending = new Map<string, AbortController>();
      suspendPage.current = () => {
        elements = null;
        for (const task of pending.values()) task.abort();
        port.port1.postMessage({ type: "context", context: null });
      };
      const requireBinding = (expected: any) => {
        if (!expected || expected !== binding.current || controller.signal.aborted)
          throw Error("页面会话已切换，请重新操作");
      };
      const call = async (
        method: string,
        parameters?: any,
        expected?: any,
        signal = controller.signal,
      ) => {
        requireBinding(expected);
        const current = await readyBinding.current;
        if (current !== expected) throw Error("页面会话已切换，请重新操作");
        const result = await request(plugin.id + "/call", { lease: current.lease, method, parameters }, signal);
        requireBinding(expected);
        return result;
      };
      const fail = (e: Error) => {
        if (controller.signal.aborted) return;
        port.port1.postMessage({ type: "identity-changed" });
        controller.abort();
        setAgents([]);
        setConnection(null);
        setError(e.message);
      };
      port.port1.onmessage = async (event) => {
        const m = event.data;
        if (!m || typeof m !== "object") return;
        const requestBinding = binding.current;
        try {
          if (["request", "register", "invoked", "catalog", "applied", "cancel"].includes(m.type) &&
              m.session !== requestBinding?.session)
            throw Error("页面会话已切换，请重新操作");
          if (m.type === "theme:subscribe") {
            const current = await readyBinding.current;
            if (!current || current !== binding.current || m.session !== current.session || controller.signal.aborted) return;
            themeRequested = true;
            sendTheme();
            return;
          }
          if (m.type === "catalog") {
            elements = Array.isArray(m.elements) && m.elements.length ? m.elements : null;
            return;
          }
          if (m.type === "applied" && typeof m.toolCallId === "string") {
            const settle = pendingApplies.get(m.toolCallId);
            if (settle) settle({applied: m.applied === true, ...(typeof m.error === "string" ? {error: m.error} : {})});
            return;
          }
          if (m.type === "register") {
            const definition = { name: m.name, description: m.description };
            registrations.current.set(m.name, definition);
            await call("register", definition, requestBinding);
            return;
          }
          if (m.type === "invoked") {
            await call("reply", m, requestBinding);
            return;
          }
          if (m.type === "cancel") {
            pending.get(m.id)?.abort();
            return;
          }
          if (m.type !== "request" || typeof m.id !== "string") return;
          let result: any;
          const task = new AbortController();
          pending.set(m.id, task);
          try {
            if (m.method === "conversation") {
              const text = m.parameters?.text,
                context = m.parameters?.context;
              if (
                typeof text !== "string" ||
                text.length > 10000 ||
                JSON.stringify(context ?? {}).length > 100000
              )
                throw Error("对话内容过长");
              requireBinding(requestBinding);
              pageContext.current = context;
              const current = await readyBinding.current;
              if (current !== requestBinding) throw Error("会话已切换，请重新发送");
              await call("context", context, requestBinding, AbortSignal.any([controller.signal, task.signal]));
              requireBinding(requestBinding);
              const sent = await ctx.remote.session.prompt({
                sessionId: current.session,
                requestId: crypto.randomUUID(),
                mode: "queue",
                content: [
                  {
                    type: "text",
                    text:
                      text +
                      "\n请先读取当前业务页的证据、计算口径和缺失说明，再依据该范围回答。",
                  },
                ],
              });
              if (!sent.ok) throw Error(sent.error.message);
              requireBinding(requestBinding);
              result = { sent: true };
            } else if (["sql", "workspace", "access", "context"].includes(m.method)) {
              result = await call(
                m.method,
                m.parameters,
                requestBinding,
                AbortSignal.any([controller.signal, task.signal]),
              );
              if (m.method === "context") pageContext.current = m.parameters;
            } else throw Error("HTML_METHOD_NOT_ALLOWED");
            requireBinding(requestBinding);
            port.port1.postMessage({ type: "response", id: m.id, result });
          } finally {
            pending.delete(m.id);
          }
        } catch (e) {
          if (!controller.signal.aborted)
            port.port1.postMessage({
              type: "response",
              id: m.id,
              error: (e as Error).message,
            });
        }
      };
      const attach = (event: MessageEvent) => {
        if (event.source !== frame.current?.contentWindow) return;
        if (event.data?.protocol !== "gea-html-v2") return;
        if (event.data.type === "navigate") {
          const panel = event.data.panel;
          if (typeof panel === "string" && /^inventory-[a-z]+$/.test(panel))
            ctx.layout.selectPanel(panel);
          return;
        }
        if (event.data.type !== "ready" || connected) return;
        readyWindow = frame.current!.contentWindow;
        void connectPage();
      };
      window.addEventListener("message", attach);
      port.port1.start();
      const createPageBridge = (current: any) => startPageBridgeClient({
        endpoint: "page-bridge",
        request: (endpoint, payload) => request(plugin.id + "/call", { lease: current.lease, method: endpoint, parameters: payload }),
        sessionId: current.session,
        pageSource: "self-report",
        catalog: () => elements === null ? null : { elements },
        apply: (args, meta, signal) =>
          new Promise((resolve) => {
            const cancel = () => {
              if (!pendingApplies.has(meta.toolCallId)) return;
              port.port1.postMessage(
                {
                  session: current.session,
                  type: "cancel",
                  toolCallId: meta.toolCallId,
                },
              );
              settle({ applied: false, error: "PAGE_ACTION_CANCELLED" });
            };
            const settle = (result: { applied: boolean; error?: string }) => {
              pendingApplies.delete(meta.toolCallId);
              signal.removeEventListener("abort", cancel);
              resolve(result);
            };
            pendingApplies.set(meta.toolCallId, settle);
            if (signal.aborted) return settle({ applied: false, error: "PAGE_ACTION_CANCELLED" });
            signal.addEventListener("abort", cancel, { once: true });
            port.port1.postMessage(
              {
                session: current.session,
                type: "apply",
                toolCallId: meta.toolCallId,
                toolCallName: meta.toolCallName,
                args,
              },
            );
          }),
      });
      let pageBridge = createPageBridge(binding.current ?? connection);
      rebindPage.current = current => {
        pageBridge();
        pageBridge = createPageBridge(current);
        // A first ready can precede this lease, or wait on a Session that was superseded.
        void connectPage();
        port.port1.postMessage({ type: "context", context: { plugin: plugin.id, session: current.session } });
        sendTheme();
      };
      const poll = async () => {
        const pollBinding = await readyBinding.current;
        try {
          if (!pollBinding) throw Error("页面会话连接暂不可用，请重试");
          const events = await request(plugin.id + "/call", { lease: pollBinding.lease, method: "events" }, controller.signal);
          if (pollBinding === binding.current)
            for (const event of events) port.port1.postMessage(event);
          if (!controller.signal.aborted) pollTimer = setTimeout(poll, 1000);
        } catch (e) {
          // Closing an old lease during New conversation must not tear down the page.
          if (pollBinding !== binding.current) {
            if (!controller.signal.aborted) pollTimer = setTimeout(poll, 1000);
          } else fail(e as Error);
        }
      };
      void poll();
      return () => {
        rebindPage.current = null;
        suspendPage.current = null;
        stopTheme();
        pageBridge();
        controller.abort();
        clearTimeout(pollTimer);
        window.removeEventListener("message", attach);
        port.port1.close();
        port.port2.close();
        for (const task of pending.values()) task.abort();
        for (const settle of pendingApplies.values()) settle({ applied: false, error: "PAGE_ACTION_CANCELLED" });
      };
    }, [connection]);
    return (
      <section
        style={{ height: "100%", display: "flex", flexDirection: "column" }}
      >
        {error && (
          <p role="alert">
            {error}{" "}
            <button onClick={() => setRevision((x) => x + 1)}>重新连接</button>
          </p>
        )}
        {agents.length > 1 && <label style={{ padding: "6px 12px" }}>
          解读能力{" "}
          <select aria-label="选择解读能力" value={typeof preset === "string" ? preset : `gea-html-${plugin.id}`}
            disabled={switchingAgent || !opened}
            onChange={(event) => void switchAgent(event.target.value)}>
            {agents.map((agent) => <option key={agent.preset} value={agent.preset}>{agent.label}</option>)}
          </select>
        </label>}
        {connection ? (
          <iframe
            ref={frame}
            title={plugin.name}
            sandbox="allow-scripts allow-downloads"
            src={"/api/gea-html/" + plugin.id + "/html" + (plugin.pageView ? "?page=" + encodeURIComponent(plugin.pageView) : "")}
            style={{ border: 0, width: "100%", flex: 1 }}
          />
        ) : (
          <p>正在连接 GEA…</p>
        )}
      </section>
    );
  }
  const discoveryError = createSnapshotStore<string | null>(null);
  let retryDiscovery = () => {};
  function DiscoveryNotice() {
    const error = useSyncExternalStore(discoveryError.subscribe, discoveryError.getSnapshot, discoveryError.getSnapshot);
    return error === null ? null : <div className="gea-page-discovery-error" role="alert">
      <span>{t("pageDiscoveryFailed")} <span>{error}</span></span>
      <button type="button" onClick={() => retryDiscovery()}>{t("retryAction")}</button>
    </div>;
  }
  ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "gea-page-discovery" }, DiscoveryNotice));
  // Public manifest metadata uses DSH connection authentication; business reads additionally require GEA login.
  ctx.effect(() => {
    let disposed = false, discovering = false;
    const cleanups: Array<() => void> = [];
    const controller = new AbortController();
    const registered = new Set<string>();
    const changed = () => {
      for (const id of registered) ctx.agentWorkbench.forget(id);
      const active = ctx.layout.panelInfo.getSnapshot().activePanelId;
      if (active && registered.has(active)) ctx.layout.selectPanel(active);
    };
    window.addEventListener("gea-business-identity-changed", changed);
    const discover = async () => {
      if (disposed || discovering) return;
      discovering = true;
      discoveryError.set(null);
      try {
        const statusResponse = await fetch("/api/gea-proof/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!statusResponse.ok) throw Error(`HTTP ${statusResponse.status}`);
        const envelope = await statusResponse.json();
        if (!envelope.ok) throw Error(envelope.error ?? "GEA_STATUS_FAILED");
        if (!envelope.value?.htmlPlugins) return;
        const items = await request("plugins", undefined, controller.signal);
        controller.signal.throwIfAborted();
        for (const plugin of items) {
          // 已下架模块不注册面板；保留的演示页使用默认助手，不依赖独立 Agent 预设。
          if (plugin.retired === true) continue;
          const pages = Array.isArray(plugin.pages) && plugin.pages.length
            ? plugin.pages
            : [{ id: plugin.id, name: plugin.name, view: "", order: 20 }];
          if (disposed || pages.every((page: any) => registered.has(page.id))) continue;
          for (const page of pages) {
            if (registered.has(page.id)) continue;
            registered.add(page.id);
            cleanups.push(ctx.agentWorkbench.register({
              id: page.id,
              preset: plugin.presetHidden === true ? "auto-negotiation" : "gea-html-" + plugin.id,
              allowedPresets: plugin.mock ? ["auto-negotiation"] : plugin.pageAgents,
              scope: plugin.mock ? undefined : async () => {
                const scope = await identity.readScope(controller.signal);
                if (scope === null) throw Error("请先登录 GEA");
                return scope;
              },
            }));
          cleanups.push(
            ctx.slots.inject("main", () => {
              const a = ctx.slots.register(
                {
                  name: "main", inject: () => ({ hooks: { mainSessionId: ctx.uiSession.mainSessionId } }),
                  key: page.id,
                  label: () => businessMenuLabel(page.id, page.name),
                  order: page.order ?? 20,
                },
                (props: any) => <Frame {...props} plugin={{ ...plugin, workbenchId: page.id, pageView: page.view, name: page.name }} />,
              );
              return () => {
                a();
              };
            }),
          );
          }
        }
        return;
      } catch (error) {
        if (!disposed && !controller.signal.aborted)
          discoveryError.set(error instanceof Error ? error.message : String(error));
      } finally {
        discovering = false;
      }
    };
    retryDiscovery = () => { void discover(); };
    void discover();
    return () => {
      disposed = true;
      controller.abort();
      window.removeEventListener("gea-business-identity-changed", changed);
      retryDiscovery = () => {};
      discoveryError.set(null);
      cleanups.forEach((f) => f());
    };
  });
}

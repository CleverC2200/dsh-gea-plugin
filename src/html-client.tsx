import { selectedSession } from "./client/session-selection.ts";
import React, { useEffect, useRef, useState } from "react";
import { businessMenuLabel } from "./business-navigation.ts";
import { startPageBridgeClient } from "./page-bridge/client.ts";
import type { PageInteraction } from "../packages/page-interaction/src/client.ts";
export function registerHtmlClient(ctx: any, pageInteraction?: PageInteraction) {
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
  function Frame({ plugin, useSessions }: any) {
    const workbenchId = plugin.workbenchId ?? plugin.id;
    const session = useSessions(selectedSession),
      frame = useRef<HTMLIFrameElement>(null),
      [connection, setConnection] = useState<any>(null),
      [error, setError] = useState(""),
      [revision, setRevision] = useState(0),
      [opened, setOpened] = useState(false);
    const binding = useRef<any>(null);
    const readyBinding = useRef<Promise<any>>(Promise.resolve(null));
    const rebindPage = useRef<((value: any) => void) | null>(null);
    const registrations = useRef(new Map<string, any>());
    const pageContext = useRef<any>(undefined);
    useEffect(() => {
      let active = true;
      let hide = () => {};
      // 业务数据页面和右侧对话必须是同一个会话：有当前会话就显式交给公共工作台，
      // 否则工作台会给页面另建一个会话，页面租约和对话成了两个身份，模型读不到页面。
      // 还没有当前会话时不挡着，仍按老样子让工作台先建一个（建好后 session 会更新并重新绑定）。
      const opening = session
        ? ctx.agentWorkbench.open(workbenchId, "default", session)
        : ctx.agentWorkbench.open(workbenchId, "default");
      void opening
        .then(() => {
          if (active) {
            hide = ctx.agentWorkbench.showConversation(workbenchId);
            setOpened(true);
          }
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        });
      return () => {
        active = false;
        hide();
      };
    }, [workbenchId, session]);
    useEffect(() => {
      if (!session || !opened) {
        readyBinding.current = Promise.resolve(null);
        return;
      }
      const controller = new AbortController();
      let lease: string | undefined;
      setError("");
      const opening = request(plugin.id + "/open", { session }, controller.signal)
        .then((result) => {
          lease = result.lease;
          if (controller.signal.aborted) return null;
          const next = { ...result, session };
          binding.current = next;
          return Promise.all([
            ...[...registrations.current.values()].map(parameters => request(plugin.id + "/call", { lease, method: "register", parameters }, controller.signal)),
            ...(pageContext.current === undefined ? [] : [request(plugin.id + "/call", { lease, method: "context", parameters: pageContext.current }, controller.signal)]),
          ]).then(() => {
            if (controller.signal.aborted) return null;
            // A new conversation changes authority, never the mounted business page.
            setConnection((current: any) => current ?? next);
            rebindPage.current?.(next);
            return next;
          });
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
          return null;
        });
      readyBinding.current = opening;
      return () => {
        controller.abort();
        if (binding.current?.lease === lease) binding.current = null;
        if (lease)
          void request(plugin.id + "/call", { lease, method: "close" }).catch(
            () => {},
          );
      };
    }, [session, revision, opened]);
    useEffect(() => {
      if (!pageInteraction || !connection || !session || !frame.current) return;
      return pageInteraction.bindFrame({ frame: frame.current, sessionId: session, page: plugin.name, surface: `gea-html-${plugin.id}`, tool: "gea_plugin_page_apply" });
    }, [connection, session]);
    useEffect(() => {
      if (!connection) return;
      const controller = new AbortController(),
        port = new MessageChannel();
      // 页面桥：这一屏的"元素目录"由注入脚本在页面里扫出来，"改草稿"再交回页面执行。
      // 页面本身不用改；页面没报目录（还没渲染/被清空）时就当作没有能力。
      // 两种来源：页面自己报（新协议）优先，页面没实现时用宿主扫出来的（迁移期回退）。
      const reported = { elements: null as unknown[] | null };
      const scanned = { elements: null as unknown[] | null };
      const pendingApplies = new Map<
        string,
        (result: { applied: boolean; error?: string }) => void
      >();
      let connected = false,
        pollTimer: any;
      const call = async (
        method: string,
        parameters?: any,
        signal = controller.signal,
      ) => {
        const current = await readyBinding.current;
        if (!current || current !== binding.current) throw Error("页面会话连接暂不可用，请重试");
        return request(plugin.id + "/call", { lease: current.lease, method, parameters }, signal);
      };
      const pending = new Map<string, AbortController>();
      const fail = (e: Error) => {
        if (controller.signal.aborted) return;
        port.port1.postMessage({ type: "identity-changed" });
        controller.abort();
        setConnection(null);
        setError(e.message);
      };
      port.port1.onmessage = async (event) => {
        const m = event.data;
        if (!m || typeof m !== "object") return;
        try {
          if (m.type === "register") {
            const definition = { name: m.name, description: m.description };
            registrations.current.set(m.name, definition);
            await call("register", definition);
            return;
          }
          if (m.type === "invoked") {
            await call("reply", m);
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
              pageContext.current = context;
              const current = await readyBinding.current;
              if (!current || current !== binding.current) throw Error("页面会话连接暂不可用，请重试");
              await request(plugin.id + "/call", { lease: current.lease, method: "context", parameters: context });
              if (current !== binding.current) throw Error("会话已切换，请重新发送");
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
              result = { sent: true };
            } else if (["sql", "workspace", "access", "context"].includes(m.method)) {
              if (m.method === "context") pageContext.current = m.parameters;
              result = await call(
                m.method,
                m.parameters,
                AbortSignal.any([controller.signal, task.signal]),
              );
            } else throw Error("HTML_METHOD_NOT_ALLOWED");
            port.port1.postMessage({ type: "response", id: m.id, result });
          } finally {
            pending.delete(m.id);
          }
        } catch (e) {
          port.port1.postMessage({
            type: "response",
            id: m.id,
            error: (e as Error).message,
          });
        }
      };
      const attach = (event: MessageEvent) => {
        if (event.source !== frame.current?.contentWindow) return;
        // 第二代协议（页面桥）：页面报"这一屏有什么"，并把改动结果回填。
        if (event.data?.protocol === "gea-html-v2") {
          if (event.data.type === "catalog") {
            const elements = Array.isArray(event.data.elements)
              ? event.data.elements
              : [];
            const target = event.data.source === "page" ? reported : scanned;
            target.elements = elements.length ? elements : null;
          } else if (
            event.data.type === "applied" &&
            typeof event.data.toolCallId === "string"
          ) {
            const settle = pendingApplies.get(event.data.toolCallId);
            if (settle) {
              pendingApplies.delete(event.data.toolCallId);
              settle({
                applied: event.data.applied === true,
                ...(typeof event.data.error === "string"
                  ? { error: event.data.error }
                  : {}),
              });
            }
          }
          return;
        }
        if (event.data?.protocol !== "gea-html-v1") return;
        if (event.data.type === "navigate") {
          const panel = event.data.panel;
          if (typeof panel === "string" && /^inventory-[a-z]+$/.test(panel))
            ctx.layout.selectPanel(panel);
          return;
        }
        if (event.data.type !== "ready" || connected) return;
        connected = true;
        event.source!.postMessage(
          {
            protocol: "gea-html-v1",
            type: "connect",
            context: { plugin: plugin.id, session: binding.current?.session },
          },
          { targetOrigin: "*", transfer: [port.port2] },
        );
      };
      window.addEventListener("message", attach);
      port.port1.start();
      const createPageBridge = (current: any) => startPageBridgeClient({
        endpoint: "page-bridge",
        request: (endpoint, payload) => request(plugin.id + "/call", { lease: current.lease, method: endpoint, parameters: payload }),
        sessionId: current.session,
        // 页面自己报了元素就按自述算，否则是宿主扫出来的。
        pageSource: () => (reported.elements === null ? "dom-scan" : "self-report"),
        catalog: () => {
          const elements = reported.elements ?? scanned.elements;
          return elements === null ? null : { elements };
        },
        apply: (args, meta, signal) =>
          new Promise((resolve) => {
            const cancel = () => {
              if (!pendingApplies.delete(meta.toolCallId)) return;
              frame.current?.contentWindow?.postMessage(
                {
                  protocol: "gea-html-v2",
                  type: "cancel",
                  toolCallId: meta.toolCallId,
                },
                "*",
              );
            };
            const settle = (result: { applied: boolean; error?: string }) => {
              pendingApplies.delete(meta.toolCallId);
              signal.removeEventListener("abort", cancel);
              resolve(result);
            };
            pendingApplies.set(meta.toolCallId, settle);
            signal.addEventListener("abort", cancel, { once: true });
            frame.current?.contentWindow?.postMessage(
              {
                protocol: "gea-html-v2",
                type: "apply",
                toolCallId: meta.toolCallId,
                toolCallName: meta.toolCallName,
                args,
              },
              "*",
            );
          }),
      });
      let pageBridge = createPageBridge(binding.current ?? connection);
      rebindPage.current = current => { pageBridge(); pageBridge = createPageBridge(current); };
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
        pageBridge();
        controller.abort();
        clearTimeout(pollTimer);
        window.removeEventListener("message", attach);
        port.port1.close();
        port.port2.close();
        for (const task of pending.values()) task.abort();
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
  // Public manifest metadata uses DSH connection authentication; business reads additionally require GEA login.
  ctx.effect(() => {
    let disposed = false,
      timer: any;
    const cleanups: Array<() => void> = [];
    const registered = new Set<string>();
    const discover = async () => {
      try {
        const statusResponse = await fetch("/api/gea-proof/status", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          cache: "no-store",
        });
        if (!statusResponse.ok) return;
        const envelope = await statusResponse.json();
        if (!envelope.ok || !envelope.value?.htmlPlugins) return;
        const items = await request("plugins");
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
            }));
          cleanups.push(
            ctx.slots.inject("main", () => {
              const a = ctx.slots.register(
                {
                  name: "main",
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
      } catch {}
      if (!disposed) timer = setTimeout(discover, 5000);
    };
    void discover();
    return () => {
      disposed = true;
      clearTimeout(timer);
      cleanups.forEach((f) => f());
    };
  });
}

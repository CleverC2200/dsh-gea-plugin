import React, { useEffect, useRef, useState } from "react";
export function registerHtmlClient(ctx: any) {
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
    const session = useSessions((s: any) => s.current),
      frame = useRef<HTMLIFrameElement>(null),
      [connection, setConnection] = useState<any>(null),
      [error, setError] = useState(""),
      [revision, setRevision] = useState(0),
      [opened, setOpened] = useState(false);
    useEffect(() => {
      let active = true;
      let hide = () => {};
      void ctx.agentWorkbench
        .open(workbenchId, "default")
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
    }, [workbenchId]);
    useEffect(() => {
      if (!session || !opened) return;
      const controller = new AbortController();
      let lease: string | undefined;
      setConnection(null);
      setError("");
      void request(plugin.id + "/open", { session }, controller.signal)
        .then((result) => {
          lease = result.lease;
          if (!controller.signal.aborted) setConnection(result);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
      return () => {
        controller.abort();
        if (lease)
          void request(plugin.id + "/call", { lease, method: "close" }).catch(
            () => {},
          );
      };
    }, [session, revision, opened]);
    useEffect(() => {
      if (!connection) return;
      const controller = new AbortController(),
        port = new MessageChannel();
      let connected = false,
        pollTimer: any;
      const call = (
        method: string,
        parameters?: any,
        signal = controller.signal,
      ) =>
        request(
          plugin.id + "/call",
          { lease: connection.lease, method, parameters },
          signal,
        );
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
            await call("register", {
              name: m.name,
              description: m.description,
            });
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
              await call("context", context);
              const sent = await ctx.remote.session.prompt({
                sessionId: session,
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
            } else if (["sql", "workspace", "access", "context"].includes(m.method))
              result = await call(
                m.method,
                m.parameters,
                AbortSignal.any([controller.signal, task.signal]),
              );
            else throw Error("HTML_METHOD_NOT_ALLOWED");
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
        if (
          event.source !== frame.current?.contentWindow ||
          event.data?.protocol !== "gea-html-v1"
        )
          return;
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
            context: { plugin: plugin.id, session },
          },
          { targetOrigin: "*", transfer: [port.port2] },
        );
      };
      window.addEventListener("message", attach);
      port.port1.start();
      const poll = async () => {
        try {
          const events = await call("events");
          for (const event of events) port.port1.postMessage(event);
          if (!controller.signal.aborted) pollTimer = setTimeout(poll, 1000);
        } catch (e) {
          fail(e as Error);
        }
      };
      void poll();
      return () => {
        controller.abort();
        clearTimeout(pollTimer);
        window.removeEventListener("message", attach);
        port.port1.close();
        port.port2.close();
        for (const task of pending.values()) task.abort();
      };
    }, [connection, session]);
    return (
      <section
        style={{ height: "100%", display: "flex", flexDirection: "column" }}
      >
        {error ? (
          <p role="alert">
            {error}{" "}
            <button onClick={() => setRevision((x) => x + 1)}>重新连接</button>
          </p>
        ) : connection ? (
          <iframe
            key={connection.lease}
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
          const pages = Array.isArray(plugin.pages) && plugin.pages.length
            ? plugin.pages
            : [{ id: plugin.id, name: plugin.name, view: "", order: 20 }];
          if (disposed || pages.every((page: any) => registered.has(page.id))) continue;
          for (const page of pages) {
            if (registered.has(page.id)) continue;
            registered.add(page.id);
            cleanups.push(ctx.agentWorkbench.register({
              id: page.id,
              preset: "gea-html-" + plugin.id,
            }));
          cleanups.push(
            ctx.slots.inject("main", () => {
              const a = ctx.slots.register(
                {
                  name: "main",
                  key: page.id,
                  label: () => page.name,
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

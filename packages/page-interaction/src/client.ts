import React, { useEffect, useRef } from "react";
import { installReferenceDisplay } from "./reference-display.tsx";
import {
  PAGE_INTERACTION,
  REFERENCE_SOURCE,
  pageReference,
  serializeReference,
  type BoundReference,
} from "./reference.ts";

export type FrameBinding = {
  frame: HTMLIFrameElement;
  sessionId: string;
  page: string;
  surface: string;
  tool?: string;
  referenceLease?: () => string | undefined;
};
export type PageInteraction = {
  bindFrame(options: FrameBinding): () => void;
  mountTrigger(container: HTMLElement, sessionId?: string): () => void;
};

/** Uses the public DSH reference/input faces, without replacing the composer. */
export function installPageInteraction(ctx: any): PageInteraction {
  try {
    const existing = ctx.get("pageInteraction");
    if (existing) return existing;
  } catch {
    /* optional service */
  }
  installReferenceDisplay(ctx);
  let ready: any;
  type PickerBinding = {
    frame: HTMLIFrameElement;
    sessionId: string;
    selecting: boolean;
    available: boolean;
    send: (message: object) => void;
    configure: () => void;
  };
  const bindings = new Set<PickerBinding>();
  const triggers = new Set<HTMLButtonElement>();
  const selectedSession = () => ready?.uiSession.mainSessionId.getSnapshot();
  const currentPicker = () =>
    [...bindings]
      .reverse()
      .find(
        (binding) =>
          binding.available &&
          binding.sessionId === selectedSession() &&
          binding.frame.isConnected &&
          binding.frame.getClientRects().length > 0,
      );
  const updateTriggers = () => {
    if (!triggers.size) return;
    const binding = currentPicker();
    for (const button of triggers) {
      button.disabled =
        !binding ||
        Boolean(
          button.dataset.sessionId &&
            button.dataset.sessionId !== binding.sessionId,
        );
      button.setAttribute("aria-pressed", String(binding?.selecting === true));
      button.setAttribute(
        "aria-label",
        binding?.selecting ? "退出选择" : "选择内容",
      );
      button.title = binding?.selecting
        ? "退出选择（Esc）"
        : "选择内容（按住 Alt 临时选择，Esc 退出）";
    }
  };
  ctx.inject(["inputTriggers", "conversation", "sessions", "uiSession"], (scope: any) => {
    scope.effect(() =>
      scope.inputTriggers.registerSource({
        trigger: "@",
        name: REFERENCE_SOURCE,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: (ref: string) => serializeReference(JSON.parse(ref)),
          serialize: async (ref: string) => {
            return serializeReference(JSON.parse(ref));
          },
        },
      }),
    );
    ready = scope;
    scope.effect(() => {
      const down = (event: KeyboardEvent) => {
        const picker = currentPicker();
        if (!picker || event.isComposing) return;
        if (event.key === "Alt" && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          picker.send({ type: "hold-selection", held: true });
        }
        if (event.key === "Escape") {
          if (picker.selecting) event.preventDefault();
          picker.send({ type: "stop-selection", altHeld: event.altKey });
        }
      };
      const release = (transient = false) => {
        for (const picker of bindings)
          picker.send({
            type: transient ? "suspend-selection" : "hold-selection",
            held: false,
          });
      };
      const up = (event: KeyboardEvent) => {
        if (event.key === "Alt") release();
      };
      const blur = () => {
        if (typeof document === "undefined" || !document.hasFocus())
          release(true);
      };
      const visibility = () => {
        if (document.hidden) release(true);
      };
      window.addEventListener("keydown", down, true);
      window.addEventListener("keyup", up, true);
      window.addEventListener("blur", blur);
      if (typeof document !== "undefined")
        document.addEventListener("visibilitychange", visibility);
      return () => {
        window.removeEventListener("keydown", down, true);
        window.removeEventListener("keyup", up, true);
        window.removeEventListener("blur", blur);
        if (typeof document !== "undefined")
          document.removeEventListener("visibilitychange", visibility);
      };
    });
    updateTriggers();
    scope.effect(
      () => scope.uiSession.mainSessionId.subscribe(updateTriggers),
    );
    scope.effect(() => () => {
      if (ready === scope) ready = undefined;
    });
  });
  const api: PageInteraction = {
    mountTrigger(container, sessionId) {
      const button = document.createElement("button");
      button.type = "button";
      if (sessionId) button.dataset.sessionId = sessionId;
      button.setAttribute("aria-keyshortcuts", "Alt Escape");
      button.setAttribute("aria-label", "选择内容");
      button.setAttribute("data-page-selection-trigger", "");
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("width", "20");
      icon.setAttribute("height", "20");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(icon.namespaceURI, "path");
      path.setAttribute("d", "M3.5 3.5 21 11.5l-7.5 2-2 7.5L3.5 3.5Z");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.5");
      path.setAttribute("stroke-linejoin", "round");
      icon.append(path);
      button.append(icon);
      button.addEventListener("click", () =>
        currentPicker()?.send({ type: "toggle-selection" }),
      );
      container.append(button);
      triggers.add(button);
      for (const binding of bindings) binding.configure();
      updateTriggers();
      return () => {
        triggers.delete(button);
        button.remove();
        for (const binding of bindings) binding.configure();
      };
    },
    bindFrame({ frame, sessionId, page, surface, tool, referenceLease }) {
      const channel = crypto.randomUUID();
      let active = true;
      let generation: string | undefined;
      const bindingRequest = new AbortController();
      const requests = new Map<string, AbortController>();
      const send = (message: object) =>
        frame.contentWindow?.postMessage(
          { protocol: PAGE_INTERACTION, channel, ...message },
          "*",
        );
      const configure = () => {
        if (generation) send({ type: "configure", page, externalTrigger: triggers.size > 0 });
      };
      const binding: PickerBinding = {
        frame,
        sessionId,
        selecting: false,
        available: false,
        send,
        configure,
      };
      bindings.add(binding);
      updateTriggers();
      const receive = async (event: MessageEvent) => {
        if (
          event.source !== frame.contentWindow ||
          event.data?.protocol !== PAGE_INTERACTION
        )
          return;
        if (event.data.type === "ready") {
          configure();
          return;
        }
        if (!active || event.data.channel !== channel) return;
        if (event.data.type === "selection-state") {
          binding.selecting = event.data.active === true;
          binding.available = true;
          updateTriggers();
          return;
        }
        if (event.data.type === "selection-error") {
          const current = ready?.sessions.binding(sessionId);
          if (current)
            ready.conversation.input
              .for(current.ctx)
              .notify(
                "error",
                String(event.data.error || "引用未加入，请重试。"),
              );
          return;
        }
        if (event.data.type === "cancel-reference") {
          requests.get(event.data.requestId)?.abort();
          return;
        }
        if (
          event.data.type !== "reference" ||
          typeof event.data.requestId !== "string"
        )
          return;
        const requestId = event.data.requestId;
        const controller = new AbortController();
        requests.set(requestId, controller);
        const deadline = setTimeout(() => {
          if (!active || controller.signal.aborted) return;
          controller.abort();
          send({ type: "result", requestId, ok: false, error: "引用未加入，请重试。" });
        }, 5000);
        try {
          if (!ready || !generation || selectedSession() !== sessionId)
            throw Error("请先打开当前页面的对话，再加入提问。");
          const selected = pageReference(event.data.reference);
          if (!selected) throw Error("未读到选中内容，请重新选择。");
          const value: BoundReference = {
            ...selected,
            page,
            sessionId,
            surface,
            tool,
          };
          const response = await fetch("/api/page-interaction/reference", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...value, generation, lease: referenceLease?.() }),
            signal: controller.signal,
          });
          const receipt = await response.json();
          if (!active || controller.signal.aborted) return;
          if (!response.ok)
            throw Error(receipt.error || "引用未保存，请重试。");
          // The Host may rotate identity while a successful save response is delayed in transit.
          const bindingResponse = await fetch("/api/page-interaction/binding", {
            cache: "no-store", signal: controller.signal,
          });
          const currentBinding = await bindingResponse.json();
          if (!active || controller.signal.aborted) return;
          if (!bindingResponse.ok || currentBinding.generation !== generation)
            throw Error("登录身份已变化，请重新选择引用。");
          if (!ready || selectedSession() !== sessionId)
            throw Error("已切换对话，请在当前页面重新引用。");
          const binding = ready.sessions.binding(sessionId);
          if (!binding) throw Error("对话尚未就绪，请稍后重试。");
          const input = ready.conversation.input.for(binding.ctx);
          const state = input.state.getSnapshot();
          const inserted = input.insertReference(
            {
              source: REFERENCE_SOURCE,
              ref: JSON.stringify(receipt),
              label: receipt.label,
              appearance: "session",
              clipboardText: serializeReference(receipt),
            },
            {
              start: state.draft.length,
              end: state.draft.length,
              draftRev: state.draftRev,
            },
          );
          if (!inserted) throw Error("输入框正在发送，请稍后再加入提问。");
          send({ type: "result", requestId: event.data.requestId, ok: true });
        } catch (error) {
          if (!active || controller.signal.aborted) return;
          send({
            type: "result",
            requestId: event.data.requestId,
            ok: false,
            error:
              error instanceof Error ? error.message : "引用未加入，请重试。",
          });
        } finally {
          clearTimeout(deadline);
          requests.delete(requestId);
        }
      };
      const reloaded = () => {
        if (requests.size) {
          for (const controller of requests.values()) controller.abort();
          requests.clear();
          const current = ready?.sessions.binding(sessionId);
          if (current) ready.conversation.input.for(current.ctx).notify("error", "页面已重新加载，请重新选择引用。");
        }
        configure();
      };
      window.addEventListener("message", receive);
      frame.addEventListener("load", reloaded);
      void fetch("/api/page-interaction/binding", { cache: "no-store", signal: bindingRequest.signal })
        .then(async response => {
          const value = await response.json();
          if (!response.ok || typeof value.generation !== "string") throw Error("页面引用连接不可用，请重新打开页面。");
          if (!active) return;
          generation = value.generation;
          configure();
        })
        .catch(error => {
          if (!active) return;
          const current = ready?.sessions.binding(sessionId);
          if (current) ready.conversation.input.for(current.ctx).notify("error", String(error.message));
        });
      return () => {
        active = false;
        bindingRequest.abort();
        bindings.delete(binding);
        updateTriggers();
        for (const controller of requests.values()) controller.abort();
        requests.clear();
        send({ type: "disconnect" });
        window.removeEventListener("message", receive);
        frame.removeEventListener("load", reloaded);
      };
    },
  };
  ctx.provide("pageInteraction", api);
  ctx.inject(["slots"], (scope: any) => {
    if (!scope.slots?.inject) return;
    scope.slots.inject("conversation.input.left", () =>
      scope.slots.register(
        { name: "conversation.input.left", id: "page-selection", order: 50 },
        function SelectionControl({ sessionId }: { sessionId: string }) {
          const anchor = useRef<HTMLSpanElement>(null);
          useEffect(
            () =>
              anchor.current
                ? api.mountTrigger(anchor.current, sessionId)
                : undefined,
            [sessionId],
          );
          return React.createElement("span", {
            ref: anchor,
            className: "dspi-composer-trigger",
          });
        },
      ),
    );
    scope.effect(() => {
      const style = document.createElement("style");
      style.textContent =
        ".dspi-composer-trigger{display:inline-flex;align-items:center}.dspi-composer-trigger button{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#606977);cursor:pointer}.dspi-composer-trigger button:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f3f5)}.dspi-composer-trigger button[aria-pressed=true]{background:#fff1f1;color:#df1d28}.dspi-composer-trigger button:disabled{opacity:.4;cursor:default}.dspi-composer-trigger button:focus-visible{outline:2px solid #d0132c;outline-offset:2px}.dspi-composer-trigger svg{width:16px;height:16px}";
      document.head.append(style);
      return () => style.remove();
    });
  });
  return api;
}

export const inject = ["sessions", "conversation", "inputTriggers", "uiSession"];
export const apply = installPageInteraction;

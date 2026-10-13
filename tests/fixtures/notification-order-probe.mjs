/** Temporary CI observer: no DOM writes, no body/header/cookie capture. */
import { appendFileSync } from "node:fs";

const prefix = "[CI-NOTIFICATION-ORDER]";
export function notificationOrderProbe() {
  const output = process.env.GEA_NOTIFICATION_ORDER_RECEIPT;
  if (!output) throw Error("NOTIFICATION_ORDER_RECEIPT_REQUIRED");
  const start = performance.now();
  const mark = (stage, extra = {}) => {
    const record = { timestamp: new Date().toISOString(), elapsedMs: performance.now() - start, stage, ...extra };
    appendFileSync(output, JSON.stringify(record) + "\n", { mode: 0o600 });
    console.log(prefix, JSON.stringify(record));
  };
  return {
    mark,
    server(req, res, mode) {
      const endpoint = req.url.pathname.endsWith("/notifications") ? "list" : "detail";
      mark("notification-request", { endpoint, method: req.method, mode });
      res.once("finish", () => mark("notification-response", { endpoint, status: res.statusCode, mode }));
    },
    async watch(context, ui) {
      ui.on("console", (message) => {
        const text = message.text();
        if (!text.startsWith(prefix + " ")) return;
        const event = JSON.parse(text.slice(prefix.length + 1));
        mark("browser-observation", { event });
      });
      ui.on("close", () => mark("page-closed"));
      ui.on("crash", () => mark("page-crashed"));
      ui.on("framenavigated", (frame) => mark("frame-navigated", { mainFrame: frame === ui.mainFrame() }));
      ui.on("websocket", (socket) => {
        mark("websocket-open");
        socket.on("close", () => mark("websocket-closed"));
      });
      await context.addInitScript(({ prefix }) => {
        const documentId = crypto.randomUUID();
        const identities = new WeakMap();
        let nextId = 0;
        const id = (node) => {
          if (!node) return null;
          if (!identities.has(node)) identities.set(node, ++nextId);
          return identities.get(node);
        };
        const emit = (kind, value = {}) => console.debug(prefix + " " + JSON.stringify({
          documentId, browserElapsedMs: performance.now(), kind, ...value,
        }));
        let last;
        const observed = new Set();
        const sample = (kind) => {
          const inbox = document.querySelector(".gea-inbox");
          const drawer = document.querySelector(".gea-inbox-drawer");
          const button = document.querySelector('button[aria-label="返回消息列表"]');
          if (button) observed.add(button);
          const state = { inbox: id(inbox), drawer: id(drawer), button: id(button),
            drawerOpen: drawer?.hasAttribute("open") ?? false, buttonDisabled: button?.disabled ?? null,
            previousButtons: [...observed].map((node) => ({ id: id(node), connected: node.isConnected })) };
          const serialized = JSON.stringify(state);
          if (last === serialized) return;
          last = serialized;
          emit(kind, state);
        };
        new MutationObserver(() => sample("dom-change")).observe(document, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ["open", "hidden", "disabled"],
        });
        for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "close", "cancel"]) {
          document.addEventListener(type, (event) => {
            const target = event.target;
            const drawer = target instanceof Element ? target.closest(".gea-inbox-drawer") : null;
            if (!drawer) return;
            const button = target.closest('button[aria-label="返回消息列表"]');
            emit("drawer-event", { type, target: id(target), drawer: id(drawer), returnButton: id(button),
              trusted: event.isTrusted, defaultPrevented: event.defaultPrevented });
          }, true);
        }
        addEventListener("beforeunload", () => emit("document-beforeunload"));
        addEventListener("pagehide", () => emit("document-pagehide"));
        emit("document-created");
      }, { prefix });
      mark("browser-observer-installed");
    },
  };
}

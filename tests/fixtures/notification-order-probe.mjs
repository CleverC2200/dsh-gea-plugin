/** Temporary CI observer: no DOM writes, no body/header/cookie capture. */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

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
      const hash = (value) => typeof value === "string" ? createHash("sha256").update(value).digest("hex") : null;
      ui.on("response", async (response) => {
        const pathname = new URL(response.url()).pathname;
        if (pathname === "/api/gea-html/identity") {
          const observedAt = performance.now() - start;
          try {
            const projection = await response.json();
            mark("identity-response", { observedAt, status: response.status(), scopeHash: hash(projection.scope),
              subjectHash: hash(projection.subject), authenticated: typeof projection.status?.authenticated === "boolean" ? projection.status.authenticated : null });
          } catch {
            mark("identity-response-not-observed", { observedAt, status: response.status() });
          }
        } else if (["/api/agent-manage/resources", "/api/agent-manage/workspace", "/api/agent-workbench/page"].includes(pathname)) {
          mark("owner-api-response", { pathname, status: response.status() });
        }
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
        const digest = async (value) => typeof value === "string"
          ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
        let projectionKey;
        const ownerProjection = () => {
          const observedAt = performance.now();
          let association, presentationState = "not-observed";
          try {
            const record = JSON.parse(localStorage.getItem("agent-workbench.presentation.v2") ?? "null");
            if (record?.version === 2 && Array.isArray(record.selections)) {
              presentationState = "observed";
              association = record.selections.find((entry) => entry.page === "gea-inbox" && entry.active === true);
            }
          } catch { presentationState = "malformed"; }
          const sessions = [...document.querySelectorAll('[data-conversation-content=""][data-conversation-session]')].map((node) => ({
            node: id(node), session: node.getAttribute("data-conversation-session"), document: id(node.closest(".agent-workbench-document")),
          }));
          const current = { presentationState, activeAssociation: !!association, session: association?.sessionId,
            preset: association?.preset === "gea-readonly" ? "gea-readonly" : association?.preset ? "other" : null,
            scope: association?.ownerScope, subject: association?.subject, sessions };
          const key = JSON.stringify(current);
          if (key === projectionKey) return;
          projectionKey = key;
          void Promise.all([digest(current.session), digest(current.scope), digest(current.subject),
            Promise.all(sessions.map(async (entry) => ({ node: entry.node, document: entry.document, sessionHash: await digest(entry.session) })))])
            .then(([associationSessionHash, ownerScopeHash, subjectHash, conversationNodes]) => emit("owner-public-projection", {
              observedAt, presentationState, activeAssociation: current.activeAssociation, preset: current.preset,
              associationSessionHash, ownerScopeHash, subjectHash, conversationNodes,
              mainSessionOpened: "not-proved-by-association",
            })).catch(() => emit("owner-public-projection-not-observed", { observedAt }));
        };
        addEventListener("gea-business-identity-changed", (event) => {
          const observedAt = performance.now();
          void Promise.all([digest(event.detail?.scope), digest(event.detail?.subject)])
            .then(([scopeHash, subjectHash]) => emit("identity-change-public-event", { observedAt, scopeHash, subjectHash }))
            .catch(() => emit("identity-change-public-event-not-observed", { observedAt }));
        });
        let last;
        const observed = new Set();
        const sample = (kind) => {
          const inbox = document.querySelector(".gea-inbox");
          const drawer = document.querySelector(".gea-inbox-drawer");
          const button = document.querySelector('button[aria-label="返回消息列表"]');
          if (button) observed.add(button);
          ownerProjection();
          const state = { inbox: id(inbox), outerPage: id(inbox?.closest(".gea-native-page")), documentRoot: id(inbox?.closest(".agent-workbench-document")), drawer: id(drawer), button: id(button),
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

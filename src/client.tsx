/** GEA navigation and independent workbench mounted in the DSH application frame. */
import React, { useEffect, useRef, useState } from "react";
import type {
  HostObservable,
  InjectFace,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-api-remotes/client";
import type { LocaleSnapshot } from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import { zh, en, type CopyKey } from "./locales.ts";
import { Inbox } from "./inbox.tsx";
import shellCss from "./shell.css";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    geaProof: CopyKey;
  }
}

export const inject = ["slots", "layout", "locale", "uiWorkspace", "sessions"];
const INBOX = "gea-inbox" as MainPanelId;
const PANEL = "gea-proof" as MainPanelId;

/** Register a business-only center document beside the frame-owned native conversation. */
export function apply(ctx: Context): void {
  if (typeof ctx.layout.registerConversationPanel !== "function")
    throw new Error(
      "GEA_DSH_FORK_REQUIRED: this workbench requires the DSH conversation-panel extension",
    );
  ctx.effect(() => ctx.locale.register("geaProof", { zh, en }));
  const t = ctx.locale.bind("geaProof");
  const injected = {
    hooks: {
      geaLocale: {
        getSnapshot: () => ctx.locale.getSnapshot(),
        subscribe: (listener: () => void) => ctx.locale.subscribe(listener),
      } satisfies HostObservable<LocaleSnapshot>,
    },
  };
  function Workbench({
    useSessions,
    useGeaLocale,
  }: PropsRuntime<"main"> & InjectFace<typeof injected>) {
    const [authenticated, setAuthenticated] = useState(false);
    useEffect(() => {
      if (!authenticated) {
        return;
      }
      return ctx.layout.registerConversationPanel(PANEL);
    }, [authenticated]);
    const language = useGeaLocale((snapshot) => snapshot.active);
    const currentSession = useSessions((snapshot) => snapshot.current);
    const frame = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
      frame.current?.contentWindow?.postMessage(
        { type: "gea:session", sessionId: currentSession },
        window.location.origin,
      );
    }, [currentSession]);
    useEffect(() => {
      const onMessage = (event: MessageEvent) => {
        if (
          event.origin !== window.location.origin ||
          event.source !== frame.current?.contentWindow
        )
          return;
        const message: unknown = event.data;
        if (!message || typeof message !== "object" || !("type" in message))
          return;
        if (message.type === "gea:identity" && "authenticated" in message) {
          setAuthenticated(message.authenticated === true);
          if (message.authenticated !== true)
            (ctx.get("sessions") as unknown as ISessions).clear();
        }
        if (
          message.type === "gea:open-session" &&
          "sessionId" in message &&
          typeof message.sessionId === "string" &&
          /^session-[0-9a-f-]{36}$/.test(message.sessionId)
        ) {
          // Keep the business page selected; AppFrame projects this Session on the right.
          ctx.uiWorkspace.openSession(message.sessionId as SessionId);
          ctx.layout.selectPanel(PANEL);
        }
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, []);
    return (
      <>
        <style>{shellCss}</style>
        <iframe
          ref={frame}
          className={`gea-workbench-frame${authenticated ? "" : " gea-login-frame"}`}
          data-gea-workbench
          title={t("approvalTitle")}
          onLoad={() =>
            frame.current?.contentWindow?.postMessage(
              { type: "gea:session", sessionId: currentSession },
              window.location.origin,
            )
          }
          src={`/api/gea-proof/workbench?locale=${encodeURIComponent(language)}`}
        />
      </>
    );
  }
  function useIdentity() {
    const [name, setName] = useState("");
    useEffect(() => {
      const controller = new AbortController();
      void fetch("/api/gea-proof/status", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      })
        .then((response) => response.json())
        .then((result) => {
          if (result.ok) setName(result.value.user?.name ?? "");
        })
        .catch(() => {
          /* The avatar remains available without a GEA login. */
        });
      return () => controller.abort();
    }, []);
    return name;
  }
  function Navigation({ usePanelInfo }: PropsRuntime<"sidebar.workspaces">) {
    const activePanel = usePanelInfo((info) => info.activePanelId);
    return (
      <nav
        className="gea-shell-navigation"
        aria-label={t("businessNavigation")}
      >
        <style>{shellCss}</style>
        <div className="gea-shell-navigation-content">
          <button
            type="button"
            onClick={() => ctx.layout.selectPanel(INBOX)}
            className={activePanel === INBOX ? "is-active" : undefined}
          >
            <NavIcon kind="inbox" />
            <span>{t("messageInbox")}</span>
          </button>
          <div className="gea-shell-group">
            <NavIcon kind="plan" />
            <strong>{t("planManagement")}</strong>
          </div>
          <button
            type="button"
            onClick={() => ctx.layout.selectPanel(PANEL)}
            className={activePanel === PANEL ? "is-active" : undefined}
          >
            {t("demandForecastAgent")}
          </button>
        </div>
      </nav>
    );
  }
  function Brand({ usePanelInfo }: PropsRuntime<"sidebar.brand.mark">) {
    const business = usePanelInfo(
      (info) => info.activePanelId === PANEL || info.activePanelId === INBOX,
    );
    const switchPage = () => ctx.layout.selectPanel(business ? null : PANEL);
    return (
      <>
        <style>{shellCss}</style>
        <span
          className="gea-brand-switch"
          role="button"
          tabIndex={0}
          aria-label={t(business ? "switchToDsh" : "switchToBusiness")}
          onClick={(event) => {
            event.stopPropagation();
            switchPage();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              switchPage();
            }
          }}
        >
          <span className="gea-shell-logo">GEA</span>
        </span>
      </>
    );
  }
  function BrandName({ usePanelInfo }: PropsRuntime<"sidebar.brand.name">) {
    const business = usePanelInfo(
      (info) => info.activePanelId === PANEL || info.activePanelId === INBOX,
    );
    return (
      <span
        onClick={(event) => {
          event.stopPropagation();
          ctx.layout.selectPanel(business ? null : PANEL);
        }}
      >
        {t(business ? "geaBusiness" : "dshConversation")}
      </span>
    );
  }
  function UserAvatar() {
    const name = useIdentity();
    return (
      <>
        <style>{shellCss}</style>
        <span className="gea-user-avatar" aria-hidden="true">
          {name.slice(0, 1) || "G"}
        </span>
        <span>{name || t("signedOut")}</span>
      </>
    );
  }
  ctx.slots.inject("main", function* () {
    yield ctx.slots.register(
      { name: "main", key: PANEL, locale: "geaProof", inject: () => injected },
      Workbench,
    );
    yield ctx.slots.register(
      { name: "main", key: INBOX, locale: "geaProof" },
      () => (
        <>
          <style>{shellCss}</style>
          <Inbox t={t} />
        </>
      ),
    );
    ctx.layout.selectPanel(PANEL);
  });
  function NavigationMode({ usePanelInfo }: PropsRuntime<"shell.overlay">) {
    const business = usePanelInfo(
      (info) => info.activePanelId === PANEL || info.activePanelId === INBOX,
    );
    useEffect(() => {
      if (!business) return;
      return ctx.slots.register(
        { name: "sidebar.workspaces", locale: "geaProof", priority: -10 },
        Navigation,
      );
    }, [business]);
    return null;
  }
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "gea-navigation-mode", locale: "geaProof" },
      NavigationMode,
    ),
  );
  ctx.slots.inject("sidebar.brand.mark", () =>
    ctx.slots.register(
      { name: "sidebar.brand.mark", locale: "geaProof", priority: -10 },
      Brand,
    ),
  );
  ctx.slots.inject("sidebar.brand.name", () =>
    ctx.slots.register(
      { name: "sidebar.brand.name", locale: "geaProof", priority: -10 },
      BrandName,
    ),
  );
  ctx.slots.inject("settings.trigger", () =>
    ctx.slots.register(
      { name: "settings.trigger", locale: "geaProof", priority: -10 },
      UserAvatar,
    ),
  );
}

function NavIcon({ kind }: { kind: "inbox" | "plan" }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {kind === "inbox" ? (
        <>
          <path d="M6 17V9a6 6 0 0 1 12 0v8l2 2H4l2-2Z" />
          <path d="M10 22h4" />
        </>
      ) : (
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 4 16 4 16 0V5M4 10c0 4 16 4 16 0M4 15c0 4 16 4 16 0" />
        </>
      )}
    </svg>
  );
}

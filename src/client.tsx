import type {} from "@cleverc2200/dsh-agent-workbench/client";
/** 在 DSH 应用框架中挂载 GEA 导航和独立工作台。 */
import { createPortal } from "react-dom";
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
import { zh, en, type CopyKey } from "./client/locales.ts";
import { Inbox } from "./client/inbox.tsx";
import shellCss from "./client/shell.css";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    geaProof: CopyKey;
  }
}

export const inject = ["slots", "layout", "locale", "uiWorkspace", "sessions", "agentWorkbench"];
const INBOX = "gea-inbox" as MainPanelId;
const PANEL = "gea-proof" as MainPanelId;

/** 在框架管理的原生会话旁注册仅承载业务的中心文档。 */
export function apply(ctx: Context): void {
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
    const [sessionError, setSessionError] = useState("");
    useEffect(() => {
      if (!authenticated) {
        return;
      }
      const hide = ctx.agentWorkbench.showConversation(PANEL);
      void ctx.agentWorkbench.open(PANEL).catch(error => setSessionError(String(error.message)));
      return hide;
    }, [authenticated]);
    const language = useGeaLocale((snapshot) => snapshot.active);
    const currentSession = useSessions((snapshot) => snapshot.current);
    const frame = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
      frame.current?.contentWindow?.postMessage(
        { type: "gea:session", sessionId: currentSession ?? null },
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
          if (message.authenticated !== true) {
            ctx.agentWorkbench.forget(PANEL);
            (ctx.get("sessions") as unknown as ISessions).clear();
          }
        }
        if (
          message.type === "gea:open-session" &&
          "sessionId" in message &&
          typeof message.sessionId === "string" &&
          /^session-[0-9a-f-]{36}$/.test(message.sessionId)
        ) {
          // 保持业务页面选中；AppFrame 会把该 Session 投影到右侧。
          void ctx.agentWorkbench.open(PANEL, "default", message.sessionId as SessionId).catch(error => setSessionError(String(error.message)));
        }
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, []);
    return (
      <>
        <style>{shellCss}</style>
        {sessionError && <div role="alert">{sessionError}</div>}
        <div className="gea-workbench-shell">
          <iframe
            ref={frame}
            className={`gea-workbench-frame${authenticated ? "" : " gea-login-frame"}`}
            data-gea-workbench
            title={t("approvalTitle")}
            onLoad={() =>
              frame.current?.contentWindow?.postMessage(
                { type: "gea:session", sessionId: currentSession ?? null },
                window.location.origin,
              )
            }
            src={`/api/gea-proof/workbench?locale=${encodeURIComponent(language)}`}
          />
        </div>
      </>
    );
  }
  function useIdentity() {
    const [identity, setIdentity] = useState({ name: "", avatarUrl: "" });
    const updateIdentity = (authenticated: boolean, user: { name?: unknown; avatar?: unknown } | null | undefined) => {
      setIdentity({
        name: authenticated && typeof user?.name === "string" ? user.name : "",
        avatarUrl: authenticated && typeof user?.avatar === "string" ? user.avatar : "",
      });
    };
    useEffect(() => {
      const controller = new AbortController();
      let revision = 0;
      const onIdentity = (event: MessageEvent) => {
        const frame = document.querySelector<HTMLIFrameElement>('iframe[data-gea-workbench]');
        if (event.origin !== window.location.origin || !frame || event.source !== frame.contentWindow || event.data?.type !== "gea:identity") return;
        revision++;
        updateIdentity(event.data.authenticated === true, event.data);
      };
      window.addEventListener("message", onIdentity);
      void fetch("/api/gea-proof/status", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: "{}", signal: controller.signal,
      }).then(response => response.json()).then(result => {
        if (result.ok && revision === 0 && !controller.signal.aborted) updateIdentity(result.value.authenticated === true, result.value.user);
      }).catch(() => { /* 身份不可用时保持账户控件为未登录状态。 */ });
      return () => { controller.abort(); window.removeEventListener("message", onIdentity); };
    }, []);
    return identity;
  }
  let authChannel: BroadcastChannel | undefined;
  ctx.effect(() => {
    const channel = new BroadcastChannel("gea-auth");
    authChannel = channel;
    const signedOut = (event: MessageEvent) => {
      if (event.data === "signed-out") window.location.assign("/");
    };
    channel.addEventListener("message", signedOut);
    return () => { channel.removeEventListener("message", signedOut); channel.close(); authChannel = undefined; };
  });
  function Logout({ name }: { name: string }) {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const pending = useRef(false);
    if (!name) return null;
    const logout = async () => {
      if (pending.current) return;
      pending.current = true; setBusy(true); setFailed(false);
      try {
        const response = await fetch("/api/gea-proof/logout", {
          method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(10000),
        });
        const result = await response.json();
        if (!response.ok || result.ok !== true || result.value.authenticated !== false) throw new Error("LOGOUT_FAILED");
        authChannel?.postMessage("signed-out");
        window.location.assign("/");
      } catch { setFailed(true); setBusy(false); pending.current = false; }
    };
    return <div className="gea-logout-control">
      <style>{shellCss}</style>
      <button type="button" role="menuitem" className="gea-logout-button" title={t("logout")} aria-label={t("logout")} disabled={busy} onClick={() => void logout()}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M10 4H4v16h6M14 8l4 4-4 4M8 12h10" /></svg>
        <span>{t(busy ? "loggingOut" : "logout")}</span>
      </button>
      {failed && <span role="alert">{t("logoutFailed")}</span>}
    </div>;
  }
  function Navigation({
    usePanelInfo,
    wide,
    expandSidebar,
  }: PropsRuntime<"sidebar.workspaces">) {
    const activePanel = usePanelInfo((info) => info.activePanelId);
    if (!wide) {
      return (
        <nav className="gea-shell-navigation" aria-label={t("businessNavigation")}>
          <style>{shellCss}</style>
          <div className="gea-shell-navigation-content">
            <button
              type="button"
              className="gea-shell-menu-trigger"
              onClick={expandSidebar}
              title={t("openBusinessNavigation")}
              aria-label={t("openBusinessNavigation")}
            >
              <MenuIcon />
            </button>
          </div>
        </nav>
      );
    }
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
            title={t("messageInbox")}
            aria-label={t("messageInbox")}
            className={activePanel === INBOX ? "is-active" : undefined}
          >
            <span className="gea-shell-label">{t("messageInbox")}</span>
          </button>
          <div className="gea-shell-group" title={t("planManagement")}>
            <strong className="gea-shell-label">{t("planManagement")}</strong>
          </div>
          <button
            type="button"
            onClick={() => ctx.layout.selectPanel(PANEL)}
            title={t("demandForecastAgent")}
            aria-label={t("demandForecastAgent")}
            className={`gea-shell-child${activePanel === PANEL ? " is-active" : ""}`}
          >
            <span className="gea-shell-label">{t("demandForecastAgent")}</span>
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
  function UserAvatar({ wide }: PropsRuntime<"settings.trigger">) {
    const { name, avatarUrl } = useIdentity();
    const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
    useEffect(() => { setFailedAvatar(null); }, [avatarUrl]);
    const avatar = useRef<HTMLSpanElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const openSettings = useRef(false);
    const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null);
    // 原生插槽只提供按钮内容；保留设置动作，同时把鼠标和键盘激活转由账户菜单处理。
    useEffect(() => {
      const button = avatar.current?.closest("button");
      if (!button) return;
      trigger.current = button;
      const activate = (event: MouseEvent) => {
        if (openSettings.current) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const rect = button.getBoundingClientRect();
        setPosition(current => current ? null : { left: Math.min(rect.left, window.innerWidth - 212), bottom: window.innerHeight - rect.top + 6 });
      };
      button.addEventListener("click", activate);
      return () => { button.removeEventListener("click", activate); trigger.current = null; };
    }, []);
    useEffect(() => {
      const button = trigger.current;
      if (!button) return;
      const previous = ["aria-label", "aria-haspopup", "aria-expanded"].map(key => button.getAttribute(key));
      button.setAttribute("aria-label", t("accountMenu"));
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", String(position !== null));
      return () => { ["aria-label", "aria-haspopup", "aria-expanded"].forEach((key, index) => {
        const value = previous[index]; if (value === null) button.removeAttribute(key); else button.setAttribute(key, value!);
      }); };
    }, [position]);
    useEffect(() => {
      if (!position) return;
      menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
      const close = (event: PointerEvent) => {
        if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setPosition(null);
      };
      const resize = () => setPosition(null);
      document.addEventListener("pointerdown", close);
      window.addEventListener("resize", resize);
      window.addEventListener("blur", resize);
      return () => { document.removeEventListener("pointerdown", close); window.removeEventListener("resize", resize); window.removeEventListener("blur", resize); };
    }, [position]);
    return <>
      <style>{shellCss}</style>
      <span ref={avatar} className="gea-user-avatar" aria-hidden="true">
        {avatarUrl && failedAvatar !== avatarUrl
          ? <img key={avatarUrl} src={avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedAvatar(avatarUrl)} />
          : name.slice(0, 1) || "G"}
      </span>
      {wide && <span>{name || t("signedOut")}</span>}
      {position && createPortal(<div ref={menu} role="menu" aria-label={t("accountMenu")} className="gea-account-menu" style={position}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); setPosition(null); trigger.current?.focus(); }
          if (event.key === "Tab") setPosition(null);
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        <button type="button" role="menuitem" className="gea-logout-button" onClick={() => {
          setPosition(null); openSettings.current = true;
          try { trigger.current?.click(); } finally { openSettings.current = false; }
        }}><span aria-hidden="true">⚙</span><span>{t("settings")}</span></button>
        <Logout name={name} />
      </div>, document.body)}
    </>;
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
    yield ctx.agentWorkbench.register({ id: PANEL, preset: "gea-readonly" });
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
    useEffect(() => {
      if (!business) return;
      const hideConversationChrome = () => {
        const conversation = document.querySelector<HTMLElement>(
          ".AppFrame_rightbarCol [data-slot='main.conversation']",
        );
        if (!conversation) return;
        const hide = (element: Element | undefined) => element?.setAttribute("data-gea-hidden-session-chrome", "");
        const text = (element: Element) => element.textContent?.trim() ?? "";
        hide([...conversation.querySelectorAll("button")].find((element) => text(element) === "workspace"));
        for (const label of ["选择打开方式", "更多操作"]) {
          hide(conversation.querySelector(`button[aria-label='${label}']`) ?? undefined);
        }
        hide([...conversation.querySelectorAll("[role='tab']")].find((element) => text(element) === "轨迹"));
        hide([...conversation.querySelectorAll("*")].find((element) => element.children.length === 0 && text(element) === "需求预测"));
      };
      hideConversationChrome();
      const observer = new MutationObserver(hideConversationChrome);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => {
        observer.disconnect();
        document.querySelectorAll("[data-gea-hidden-session-chrome]").forEach((element) =>
          element.removeAttribute("data-gea-hidden-session-chrome"),
        );
      };
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

function MenuIcon() {
  return (
    <svg
      aria-hidden="true"
      data-nav-icon="menu"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="5" cy="6" r="1" />
      <circle cx="5" cy="12" r="1" />
      <circle cx="5" cy="18" r="1" />
      <path d="M9 6h11M9 12h11M9 18h11" />
    </svg>
  );
}

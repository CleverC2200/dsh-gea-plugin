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
import { AgentAvatar } from "./client/agent-avatar.tsx";
import { Inbox } from "./client/inbox.tsx";
import {registerHtmlClient} from "./html-client.tsx";
import {
  approvalConversation,
  branchStockConversation,
  deliveryOpsConversation,
  demandOpsConversation,
  fullChainStockConversation,
  homeConversation,
  inboxConversation,
  inventoryConversation,
  inventoryWorkbenchConversation,
  regionalPlanConversation,
  safetyStockConversation,
  type ConversationActionIcon,
  type ConversationActionTone,
  type ConversationPromptConfig,
} from "./client/conversation-prompts.ts";
import {BUSINESS_MENU_PRESET,isGeaBusinessPanel,registeredBusinessPanels,resolveBusinessMenu,type BusinessMenuSection} from "./business-navigation.ts";
import {BUSINESS_GROUP_ICON_PATHS,type BusinessGroupIcon} from "./client/business-icons.ts";
import brandLogo from "./client/brand-logo.png";
import shellCss from "./client/shell.css";
import workbenchCss from "./workbench/workbench.css";
import regionalPlanPrototype from "./workbench/prototypes/regional-plan-v9.html";
import { ApiLogCenter } from "./workbench/api-log-center.tsx";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    geaProof: CopyKey;
  }
}

export const inject = ["slots", "layout", "locale", "uiWorkspace", "sessions", "agentWorkbench", "remote", "remote.session"];
const INBOX = "gea-inbox" as MainPanelId;
const PANEL = "gea-proof" as MainPanelId;
const API_LOG_PANEL = "gea-api-log" as MainPanelId;
const REGIONAL_PLAN_PANEL = "gea-regional-plan" as MainPanelId;
type SidebarSection = BusinessMenuSection;
type SidebarSections = Record<SidebarSection, boolean>;

/** 展开侧栏：0.1.6 的按钮文案是「打开侧边栏」，旧版本是「展开侧边栏」，找不到文案就按类名找。 */
function nativeExpandSidebar(): void {
  const button =
    document.querySelector<HTMLButtonElement>("button[aria-label='展开侧边栏']") ??
    document.querySelector<HTMLButtonElement>("button[aria-label='打开侧边栏']") ??
    document.querySelector<HTMLButtonElement>("[class*='_sidebarCol'] button[class*='_toggle']");
  button?.click();
}

/** 在框架管理的原生会话旁注册仅承载业务的中心文档。 */
export function apply(ctx: Context): void {
  registerHtmlClient(ctx);
  ctx.effect(() => ctx.locale.register("geaProof", { zh, en }));
  const t = ctx.locale.bind("geaProof");
  // 左上角标题固定成品牌名：DSH 会随会话主题改写 document.title（窗口标题跟着变），这里把它按住。
  ctx.effect(() => {
    const fixed = t("geaBusiness");
    const applyTitle = () => {
      if (document.title !== fixed) document.title = fixed;
    };
    applyTitle();
    const observer = new MutationObserver(applyTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  });
  const injected = {
    hooks: {
      geaLocale: {
        getSnapshot: () => ctx.locale.getSnapshot(),
        subscribe: (listener: () => void) => ctx.locale.subscribe(listener),
      } satisfies HostObservable<LocaleSnapshot>,
    },
  };
  let workbenchAuthenticated = false;
  let hideWorkbenchConversation: (() => void) | undefined;
  function Workbench({
    useSessions,
    useGeaLocale,
  }: PropsRuntime<"main"> & InjectFace<typeof injected>) {
    const [authenticated, setAuthenticated] = useState(false);
    // 只有子文档明确上报「未登录」时才铺整屏登录遮罩；
    // 首次挂载还不知道登录态，直接铺遮罩会让切进业务面板时整屏闪一下。
    const [loginOverlay, setLoginOverlay] = useState(false);
    const [sessionError, setSessionError] = useState("");
    useEffect(() => {
      if (!authenticated) {
        workbenchAuthenticated = false;
        hideWorkbenchConversation?.();
        hideWorkbenchConversation = undefined;
        return;
      }
      workbenchAuthenticated = true;
      const hide = ctx.agentWorkbench.showConversation(PANEL);
      hideWorkbenchConversation = hide;
      void ctx.agentWorkbench.open(PANEL).catch(error => setSessionError(String(error.message)));
      return () => {
        hide();
        if (hideWorkbenchConversation === hide) hideWorkbenchConversation = undefined;
      };
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
          setLoginOverlay(message.authenticated !== true);
          workbenchAuthenticated = message.authenticated === true;
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
            className={`gea-workbench-frame${loginOverlay ? " gea-login-frame" : ""}`}
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
  async function apiLogRequest<T>(
    endpoint: string,
    payload: object = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch("/api/gea-proof/" + endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true)
      throw new Error(result.error?.message ?? result.error?.code ?? "GEA_REQUEST_FAILED");
    return result.value as T;
  }
  // 区域计划工作台：先内嵌业务侧原型（V9 事件线版，纯模拟数据，不连 GEA）。
  function RegionalPlanPage() {
    const [sessionError, setSessionError] = useState("");
    useEffect(() => {
      // 和其他业务页一样挂一个只读会话，让右侧会话区常驻。
      const hide = ctx.agentWorkbench.showConversation(REGIONAL_PLAN_PANEL);
      void ctx.agentWorkbench
        .open(REGIONAL_PLAN_PANEL)
        .catch((error) => setSessionError(String(error.message)));
      return () => hide();
    }, []);
    return (
      <>
        <style>{shellCss}</style>
        {sessionError && <div role="alert">{sessionError}</div>}
        <section className="gea-workbench-shell">
          <iframe
            className="gea-workbench-frame"
            title={t("regionalPlanWorkbench")}
            sandbox="allow-scripts"
            srcDoc={regionalPlanPrototype}
          />
        </section>
      </>
    );
  }
  function ApiLogPage() {
    const [environment, setEnvironment] = useState<"production" | "test">("production");
    useEffect(() => {
      const controller = new AbortController();
      void apiLogRequest<{ environment?: "production" | "test" }>("status", {}, controller.signal)
        .then((value) => {
          if (value.environment === "test" || value.environment === "production")
            setEnvironment(value.environment);
        })
        .catch(() => {});
      return () => controller.abort();
    }, []);
    return (
      <>
        <style>{shellCss}</style>
        <style>{workbenchCss}</style>
        <ApiLogCenter
          environment={environment}
          request={apiLogRequest}
          onClose={() => ctx.layout.selectPanel(PANEL)}
        />
      </>
    );
  }
  /** 业务待办页：和业务工作台一样自带右侧会话栏（否则整块对话框不出现）。 */
  function InboxPage() {
    useEffect(() => {
      const hide = ctx.agentWorkbench.showConversation(INBOX);
      void ctx.agentWorkbench.open(INBOX).catch(() => {
        /* 会话打不开时页面照常可看，不额外打扰用户。 */
      });
      return () => hide();
    }, []);
    return (
      <>
        <style>{shellCss}</style>
        <Inbox t={t} />
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
    sections,
    onToggleSection,
  }: PropsRuntime<"sidebar.workspaces"> & {
    sections?: SidebarSections;
    onToggleSection?: (section: SidebarSection) => void;
  }) {
    const [expanded, setExpanded] = useState<SidebarSections>({ supply: true, plan: true, inventory: true, orders: true });
    const open = sections ?? expanded;
    const activePanel = usePanelInfo((info) => info.activePanelId);
    const [panels,setPanels]=useState(()=>registeredBusinessPanels(ctx.slots.entries("main")));
    useEffect(()=>{const refresh=()=>setPanels(registeredBusinessPanels(ctx.slots.entries("main")));refresh();return ctx.slots.subscribe("main",refresh);},[]);
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
    const toggle = (section: SidebarSection) => {
      if (onToggleSection) return onToggleSection(section);
      setExpanded((value) => ({ ...value, [section]: !value[section] }));
    };
    const child = ({ id, title }: { id: string; title: string }) => (
      <button key={id} type="button" data-gea-business-entry={id} aria-current={activePanel === id ? "page" : undefined} className={`gea-shell-nav-child${activePanel === id ? " is-active" : ""}`} onClick={() => ctx.layout.selectPanel(id as MainPanelId)}><span className="gea-shell-label">{title}</span></button>
    );
    // 菜单分组与顺序按原型固定；没有接入页面的条目（如生产计划、订单履约）自动隐藏。
    const available = new Map<string, string>(panels.map((panel) => [panel.id, panel.title]));
    available.set(PANEL, t("salesPlan"));
    available.set(REGIONAL_PLAN_PANEL, t("regionalPlanWorkbench"));
    const menu = resolveBusinessMenu(BUSINESS_MENU_PRESET, available);
    return (
      <nav
        className="gea-shell-navigation"
        aria-label={t("businessNavigation")}
      >
        <style>{shellCss}</style>
        <div className="gea-shell-navigation-content">
          {menu.map((group) => (
            <div className="gea-shell-nav-section" key={group.key}>
              <button type="button" className="gea-shell-nav-heading" aria-expanded={open[group.key]} onClick={() => toggle(group.key)}>
                <NavIcon kind={group.icon as NavIconKind} /><span>{group.title}</span><Chevron open={open[group.key]} />
              </button>
              {open[group.key] && <div className="gea-shell-nav-children">{group.entries.map(child)}</div>}
            </div>
          ))}
        </div>
      </nav>
    );
  }
  function Brand() {
    // 品牌区只是标识，不再承担页面切换，也不触发 DSH 原生的「新建会话」。
    // 收起侧栏后点它就是「展开侧栏」，这样图标列里不用再单独放一个展开图标。
    const expandWhenCollapsed = (event: React.MouseEvent) => {
      event.stopPropagation();
      if (document.querySelector("[data-sidebar-collapsed]")) nativeExpandSidebar();
    };
    return (
      <>
        <style>{shellCss}</style>
        <span className="gea-brand-switch" title={t("openBusinessNavigation")} onClick={expandWhenCollapsed}>
          <img className="gea-shell-logo" src={brandLogo} alt="" />
        </span>
      </>
    );
  }
  function BrandName({ usePanelInfo }: PropsRuntime<"sidebar.brand.name">) {
    // 左上角品牌照原型固定成「思念 GEA + 一行说明」，不再随页面切文案。
    // 原型里「AI工作台」行右侧的「企业级」标签和新建小图标按评审意见去掉。
    return (
      <div className="gea-brand-copy" onClick={(event) => event.stopPropagation()}>
        <span className="gea-brand-title">{t("geaBusiness")}</span>
        <div className="gea-brand-subtitle">{t("brandSubtitle")}</div>
      </div>
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
      // 焦点不在菜单里时（切页签、切窗口后）Esc 也应该关掉账户菜单。
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        setPosition(null);
        trigger.current?.focus();
      };
      document.addEventListener("pointerdown", close);
      document.addEventListener("keydown", onKeyDown);
      window.addEventListener("resize", resize);
      window.addEventListener("blur", resize);
      return () => {
        document.removeEventListener("pointerdown", close);
        document.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("resize", resize);
        window.removeEventListener("blur", resize);
      };
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
      InboxPage,
    );
    yield ctx.slots.register(
      { name: "main", key: API_LOG_PANEL, locale: "geaProof" },
      ApiLogPage,
    );
    yield ctx.slots.register(
      { name: "main", key: REGIONAL_PLAN_PANEL, locale: "geaProof" },
      RegionalPlanPage,
    );
    yield ctx.agentWorkbench.register({ id: PANEL, preset: "gea-readonly" });
    yield ctx.agentWorkbench.register({ id: REGIONAL_PLAN_PANEL, preset: "gea-readonly" });
    // 业务待办页也要有自己的会话栏：不登记的话右侧对话框整块不出现。
    yield ctx.agentWorkbench.register({ id: INBOX, preset: "gea-readonly" });
    ctx.layout.selectPanel(PANEL);
  });
  function NavigationMode({
    usePanelInfo,
    useSessions,
    useSessionPendingInteraction,
    useWorkspaces,
  }: PropsRuntime<"shell.overlay">) {
    const activePanel = usePanelInfo((info) => info.activePanelId);
    const business = usePanelInfo(
      (info) => isGeaBusinessPanel(info.activePanelId, ctx.slots.entries("main")) || info.activePanelId === API_LOG_PANEL,
    );
    useEffect(() => {
      const frame = document.querySelector<HTMLElement>(".AppFrame_frame");
      frame?.classList.toggle("gea-api-fullscreen", activePanel === API_LOG_PANEL);
      // 业务页（含 HTML 插件页）共用同一套「欢迎区在上、对话框在下」的右栏布局；
      // 只按原生 data-conversation-beside-panel 判断会漏掉 HTML 插件页。
      frame?.classList.toggle("gea-business-shell", business && activePanel !== API_LOG_PANEL);
      return () => {
        frame?.classList.remove("gea-api-fullscreen");
        frame?.classList.remove("gea-business-shell");
      };
    }, [activePanel, business]);
    // 会话栏沿用「工作台在旁边」的停靠布局：输入框贴底、首页区块在流内。
    // 所有带会话栏的业务页（含 HTML 插件页和业务待办）都要停靠，
    // 否则欢迎区会绝对定位浮在输入框上面，输入框点不进去。
    useEffect(() => {
      const frame = document.querySelector<HTMLElement>(".AppFrame_frame");
      frame?.classList.toggle("gea-rail-docked", business && activePanel !== API_LOG_PANEL);
      return () => frame?.classList.remove("gea-rail-docked");
    }, [business, activePanel]);
    // 业务面板之间切换时，框架默认会用 400ms 动画改列宽，
    // 动画期间工作台跟着连续重排，看起来像页面闪动；切换瞬间先关掉这个动画。
    useEffect(() => {
      const frame = document.querySelector<HTMLElement>(".AppFrame_frame");
      if (!frame) return;
      frame.classList.add("gea-panel-switching");
      const timer = window.setTimeout(
        () => frame.classList.remove("gea-panel-switching"),
        400,
      );
      return () => {
        window.clearTimeout(timer);
        frame.classList.remove("gea-panel-switching");
      };
    }, [activePanel]);
    useEffect(() => {
      if (activePanel === API_LOG_PANEL) {
        hideWorkbenchConversation?.();
        hideWorkbenchConversation = undefined;
        return;
      }
      if (activePanel === PANEL && workbenchAuthenticated && !hideWorkbenchConversation)
        hideWorkbenchConversation = ctx.agentWorkbench.showConversation(PANEL);
    }, [activePanel]);
    const [region, setRegion] = useState<HTMLElement | null>(null);
    const [logoRow, setLogoRow] = useState<HTMLElement | null>(null);
    const [conversationHero, setConversationHero] = useState<HTMLElement | null>(null);
    const [homeHero, setHomeHero] = useState<HTMLElement | null>(null);
    const [railColumn, setRailColumn] = useState<HTMLElement | null>(null);
    // 左栏改成两个互斥抽屉：功能区在品牌下方从上往下展开，工作区贴底从下往上展开。
    const [drawer, setDrawer] = useState<"function" | "workspace" | "none">(
      () => (business ? "function" : "workspace"),
    );
    // 业务菜单各分组的展开状态由这里持有，切抽屉不会丢。
    const [sections, setSections] = useState<SidebarSections>({ supply: true, plan: true, inventory: true, orders: true });
    const previousBusiness = useRef(business);
    useEffect(() => {
      // 进业务页自动展开功能区；回到 AI 工作台保留用户自己选的抽屉，不强行切换。
      if (business && !previousBusiness.current) setDrawer("function");
      previousBusiness.current = business;
    }, [business]);
    useEffect(() => {
      const renameNewSession = () => {
        const button = document.querySelector<HTMLButtonElement>("button[class*='_newSession']");
        const label = button?.querySelector<HTMLElement>("[class*='_newSessionLabel']");
        if (!button || !label) return;
        if (label.textContent !== "AI工作台") label.textContent = "AI工作台";
        if (button.getAttribute("aria-label") !== "AI工作台") button.setAttribute("aria-label", "AI工作台");
      };
      renameNewSession();
      const observer = new MutationObserver(renameNewSession);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      const findRegions = () => {
        setRegion(
          document.querySelector<HTMLElement>("[class*='_regionArea']") ??
            document.querySelector<HTMLElement>('[data-slot="sidebar.workspaces"]')?.parentElement ??
            null,
        );
        setLogoRow(document.querySelector<HTMLElement>("[class*='_logoRow']"));
        setRailColumn(document.querySelector<HTMLElement>(".AppFrame_rightbarCol"));
        // 主页面（没有业务面板时）中心列就是 GEA 的主视觉；业务页时中心列是工作台 iframe。
        setHomeHero(
          document.querySelector<HTMLElement>(
            ".AppFrame_centerCol [data-slot='main.conversation'] [data-phase='hero'] [data-conversation-scroll]",
          ),
        );
        setConversationHero(document.querySelector<HTMLElement>(
          ".AppFrame_rightbarCol [data-slot='main.conversation'] [data-phase='hero']",
        ));
      };
      findRegions();
      const observer = new MutationObserver(findRegions);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      if (!region) return;
      region.setAttribute("data-gea-drawer", drawer);
      return () => region.removeAttribute("data-gea-drawer");
    }, [region, drawer]);
    // 会话搜索展开时，原生的搜索行要从「历史会话」标题右边一直铺到右边，
    // 这里把标题右边缘量出来给 CSS 用（中英文标题宽度不同，写死会压字）。
    useEffect(() => {
      if (!region || drawer !== "workspace") {
        region?.style.removeProperty("--gea-search-left");
        return;
      }
      const sync = () => {
        const slot = region.querySelector<HTMLElement>('[data-slot="sidebar.workspaces"]');
        const title = region.querySelector<HTMLElement>(".gea-drawer-workspace .gea-drawer-title");
        if (!slot || !title) return;
        // 量文字本身（Range）而不是盒子：标题盒子会随内边距变化，量盒子会来回抖。
        const range = document.createRange();
        range.selectNodeContents(title);
        const text = range.getBoundingClientRect();
        const right = text.width > 0 ? text.right : title.getBoundingClientRect().right;
        const left = Math.round(right - slot.getBoundingClientRect().left) + 6;
        region.style.setProperty("--gea-search-left", `${left}px`);
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(region, { childList: true, subtree: true, characterData: true });
      window.addEventListener("resize", sync);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", sync);
        region.style.removeProperty("--gea-search-left");
      };
    }, [region, drawer]);
    useEffect(() => {
      if (!business) return;
      const hideConversationChrome = () => {
        const conversation = document.querySelector<HTMLElement>(
          ".AppFrame_rightbarCol [data-slot='main.conversation']",
        );
        if (!conversation) return;
        const hide = (element: Element | null | undefined) => element?.setAttribute("data-gea-hidden-session-chrome", "");
        const text = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        // 每次重算前先撤掉上一轮的标记：首屏标记过的容器在会话开始后就是消息列表，
        // 不能让它一直停在被隐藏的状态（否则真实回复用户看不到）。
        for (const marked of conversation.querySelectorAll("[data-gea-hidden-session-chrome]"))
          marked.removeAttribute("data-gea-hidden-session-chrome");
        // 首屏（hero）才把原生欢迎区整段让开。0.1.6 的欢迎区是品牌行 + 工作区/预设选择器，
        // 业务外壳自己铺了这一屏；会话开始后这些兄弟节点是消息列表，必须保留。
        if (conversation.querySelector("[data-phase='hero']")) {
          const composer = conversation.querySelector("textarea, [contenteditable='true']");
          for (let node: Element | null = composer; node && node !== conversation; node = node.parentElement) {
            for (const sibling of [...(node.parentElement?.children ?? [])]) {
              if (sibling === node) break;
              if (sibling.querySelector(".gea-agent-welcome")) continue;
              hide(sibling);
            }
          }
        }
        hide(conversation.querySelector("[aria-label='选择工作区']"));
        hide(conversation.querySelector("[aria-label='需求预测']"));
        hide([...conversation.querySelectorAll("button, [role='button']")].find((element) => text(element) === "workspace"));
        for (const label of ["选择打开方式", "更多操作"]) {
          hide(conversation.querySelector(`button[aria-label='${label}']`));
        }
        hide([...conversation.querySelectorAll("[role='tab']")].find((element) => text(element) === "轨迹"));
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
    if (!region) return null;
    const expandSidebar = () => {
      // 不同内核版本把同一个按钮标成「打开侧边栏」或「展开侧边栏」，两种都认。
      document
        .querySelector<HTMLButtonElement>(
          "button[aria-label='打开侧边栏'], button[aria-label='展开侧边栏']",
        )
        ?.click();
    };
    // 工作区 only swaps the sidebar surface: the center document and the rail conversation stay.
    const toggleDrawer = (name: "function" | "workspace") =>
      setDrawer((value) => (value === name ? "none" : name));
    const writeComposer = (prompt: string) => {
      const conversation =
        document.querySelector<HTMLElement>(
          ".AppFrame_centerCol [data-slot='main.conversation'], .AppFrame_rightbarCol [data-slot='main.conversation']",
        ) ?? conversationHero;
      if (!conversation) return;
      const input = Array.from(
        conversation.querySelectorAll<HTMLElement>("textarea, [contenteditable='true']"),
      ).find((element) => element.getClientRects().length > 0 && !element.hasAttribute("disabled"));
      if (!input) return;
      if (input instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(input, prompt);
      } else {
        input.focus();
        document.execCommand("selectAll", false);
        if (!document.execCommand("insertText", false, prompt)) {
          input.replaceChildren(document.createTextNode(prompt));
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
        }
      }
      if (input instanceof HTMLTextAreaElement)
        input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      input.focus();
    };
    const drawerPortal = createPortal(
      <>
        {/* 两个抽屉上下挨着：业务工作台在上、历史会话紧跟其下，展开都往下走。 */}
        <div className="gea-sidebar-drawer gea-drawer-function">
          <button
            type="button"
            className="gea-sidebar-tab"
            aria-expanded={drawer === "function"}
            aria-controls="gea-panel-function"
            onClick={() => toggleDrawer("function")}
          >
            <span className="gea-drawer-title">{t("functionArea")}</span>
            <Chevron open={drawer === "function"} />
          </button>
        </div>
        <div className="gea-sidebar-drawer gea-drawer-workspace">
          <button
            type="button"
            className="gea-sidebar-tab"
            aria-expanded={drawer === "workspace"}
            aria-controls="gea-panel-workspace"
            onClick={() => toggleDrawer("workspace")}
          >
            <span className="gea-drawer-title">{t("workspaceArea")}</span>
            <Chevron open={drawer === "workspace"} />
          </button>
        </div>
        {/* 面板统一放在两行下面，这样两个标题始终挨着，展开都是往下长。 */}
        {drawer === "function" && (
          <div className="gea-sidebar-panel gea-panel-function" id="gea-panel-function">
            <Navigation
              usePanelInfo={usePanelInfo}
              useSessions={useSessions}
              useSessionPendingInteraction={useSessionPendingInteraction}
              useWorkspaces={useWorkspaces}
              wide
              expandSidebar={expandSidebar}
              sections={sections}
              onToggleSection={(section) => setSections((value) => ({ ...value, [section]: !value[section] }))}
            />
          </div>
        )}
      </>,
      region,
    );
    // 侧栏收起后只留图标列：点哪个先把侧栏展开，再打开对应的抽屉（和展开态一一对应）。
    const openDrawerFromRail = (name: "function" | "workspace") => {
      setDrawer(name);
      nativeExpandSidebar();
    };
    const newConversation = () => {
      setDrawer("workspace");
      nativeExpandSidebar();
      // 等原生侧栏渲染出来再触发它自己的「新建会话」，避免在收起态点到不存在的节点。
      window.setTimeout(
        () => document.querySelector<HTMLButtonElement>("button[class*='_newSession']")?.click(),
        150,
      );
    };
    const railItem = (label: string, icon: NavIconKind, selected: boolean, onClick: () => void) => (
      <button
        type="button"
        className={`gea-sidebar-rail-item${selected ? " is-active" : ""}`}
        title={label}
        aria-label={label}
        aria-current={selected ? "page" : undefined}
        onClick={onClick}
      >
        <NavIcon kind={icon} />
      </button>
    );
    const sidebarRail = createPortal(
      <div className="gea-sidebar-rail" data-gea-sidebar-rail>
        {railItem("新建对话", "newChat", false, newConversation)}
        {railItem(t("functionArea"), "apps", drawer === "function", () => openDrawerFromRail("function"))}
        {railItem(t("workspaceArea"), "folder", drawer === "workspace", () => openDrawerFromRail("workspace"))}
      </div>,
      region,
    );
    return (
      <>
        {sidebarRail}
        {drawerPortal}
        {logoRow && createPortal(
          <button
            type="button"
            className="gea-inbox-quick-action"
            aria-label={t("messageInbox")}
            title="业务代办"
            onClick={() => ctx.layout.selectPanel(INBOX)}
          >
            <NavIcon kind="bell" />
          </button>,
          logoRow,
        )}
        {railColumn && createPortal(<ConversationHead agent={conversationAgentFor(activePanel)} />, railColumn)}
        {conversationHero && createPortal(
          <AgentWelcome agent={conversationAgentFor(activePanel)} onPrompt={writeComposer} />,
          conversationHero,
        )}
        {!business && homeHero && createPortal(
          <GeaHomeHero
            copy={{
              label: t("geaBusiness"),
              eyebrow: t("homeEyebrow"),
              title: t("homeTitle"),
              description: t("homeDescription"),
            }}
          />,
          homeHero,
        )}
      </>
    );
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
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: API_LOG_PANEL,
        // 紧跟在核心「插件」(order 15) 之后，排在 Agent 预设(20)、软件更新(60)之前。
        order: 16,
        label: () => t("apiLog"),
        locale: "geaProof",
      },
      function ApiLogSettingsSection({ close }: PropsRuntime<"settings.section">) {
        useEffect(() => {
          close();
          ctx.layout.selectPanel(API_LOG_PANEL);
        }, [close]);
        return null;
      },
    ),
  );
}

function AgentWelcome({
  agent,
  onPrompt,
}: {
  agent: ConversationPromptConfig;
  onPrompt: (prompt: string) => void;
}) {
  return (
    <section className="gea-agent-welcome" aria-label={agent.name}>
      <div className="gea-agent-identity">
        <AgentAvatar className="gea-agent-avatar" />
        <h2>{agent.name}</h2>
        <p className="gea-agent-intro">{agent.intro}<b>{agent.boundary}</b></p>
      </div>
      <div className="gea-agent-block">
        <h3>常用功能</h3>
        <div className="gea-agent-actions">
          {agent.actions.map((action) => (
            <button key={action.label} type="button" onClick={() => onPrompt(action.prompt)}>
              <AgentActionIcon kind={action.icon} tone={action.tone} />
              <span className="gea-agent-action-copy">
                <span className="gea-agent-action-title">{action.label}</span>
                <span className="gea-agent-action-detail">{action.detail}</span>
              </span>
              <b className="gea-agent-action-arrow" aria-hidden="true">›</b>
            </button>
          ))}
        </div>
      </div>
      <div className="gea-agent-block gea-agent-prompts">
        <h3>你可以这样问</h3>
        {agent.prompts.map((prompt) => <button key={prompt} type="button" onClick={() => onPrompt(prompt)}>{prompt}</button>)}
      </div>
    </section>
  );
}

/**
 * AI 工作台主页面主视觉（原型 mid 区）。
 * 按评审只保留品牌引言（logo + 一句话），三张入口卡（常用功能/推荐问题/预警事件）已去掉。
 */
function GeaHomeHero({
  copy,
}: {
  copy: {
    label: string;
    eyebrow: string;
    title: string;
    description: string;
  };
}) {
  return (
    <section className="gea-home-hero" aria-label={copy.label}>
      <img className="gea-home-logo" src={brandLogo} alt="" width={81} height={81} />
      <p className="gea-home-eyebrow">{copy.eyebrow}</p>
      <h1 className="gea-home-title">{copy.title}</h1>
      <p className="gea-home-description">{copy.description}</p>
    </section>
  );
}

/** 会话栏顶部常驻头（原型 phead）：冻结在会话区上方，不随内容滚动。 */
function ConversationHead({ agent }: { agent: ConversationPromptConfig }) {
  return (
    <header className="gea-agent-head">
      <AgentAvatar className="gea-agent-head-avatar" />
      <span className="gea-agent-head-copy">
        <span className="gea-agent-head-name">{agent.name}</span>
        <span className="gea-agent-head-sub"><i aria-hidden="true" />{agent.headerSub}</span>
      </span>
    </header>
  );
}

/** 每个业务页配各自的会话助手：名字、常用功能、推荐提问都跟那一页的工作台对齐。 */
const BUSINESS_CONVERSATIONS: Record<string, ConversationPromptConfig> = {
  [PANEL]: approvalConversation,
  [REGIONAL_PLAN_PANEL]: regionalPlanConversation,
  "inventory-dealer": inventoryConversation,
  "inventory-apsdemand": demandOpsConversation,
  "inventory-apsdelivery": deliveryOpsConversation,
  "inventory-aqkc": safetyStockConversation,
  "inventory-fc": branchStockConversation,
  "inventory-personal": inventoryWorkbenchConversation,
  "inventory-qll": fullChainStockConversation,
};

function conversationAgentFor(panel: MainPanelId | null | undefined): ConversationPromptConfig {
  if (!panel) return homeConversation;
  if (panel === INBOX) return inboxConversation;
  return BUSINESS_CONVERSATIONS[panel] ?? homeConversation;
}

function AgentActionIcon({ kind, tone }: { kind: ConversationActionIcon; tone: ConversationActionTone }) {
  const paths: Record<ConversationActionIcon, React.ReactNode> = {
    chart: <><rect x="3" y="13" width="3" height="8" rx=".8" /><rect x="10" y="8" width="3" height="13" rx=".8" /><rect x="17" y="3" width="3" height="18" rx=".8" /></>,
    alert: <><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
    versions: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4" /></>,
    opinion: <><path d="M14 3H6a2 2 0 0 0-2 2v15a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M8 12h7M8 16h7" /></>,
    box: <><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></>,
    users: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c.6-3.2 2.6-4.8 6-4.8s5.4 1.6 6 4.8" /><path d="M16.5 5.6a3 3 0 0 1 0 5.6M18 15.4c1.7.4 2.7 1.7 3 3.6" /></>,
  };
  return (
    <svg className="gea-agent-action-icon" data-tone={tone} width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  );
}

type NavIconKind = "bot" | "bell" | "desktop" | "users" | "calendar" | "warehouse" | "grid" | "folder" | "apps" | "newChat" | BusinessGroupIcon;
function NavIcon({ kind }: { kind: NavIconKind }) {
  // 原型分组图标是填充路径（1024 viewBox），用 currentColor 跟随菜单文字色。
  if (kind === "synergy" || kind === "orders") {
    return (
      <svg className="gea-shell-nav-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 1024 1024" fill="currentColor">
        {/* 填充图标是满幅的，缩到线框图标同一墨迹尺寸（约 13px），避免看着比其它分组图标大一圈。 */}
        <g transform="translate(512 512) scale(0.75) translate(-512 -512)">
          {BUSINESS_GROUP_ICON_PATHS[kind].map((d, index) => <path key={index} d={d} />)}
        </g>
      </svg>
    );
  }
  const paths: Record<Exclude<NavIconKind, BusinessGroupIcon>, React.ReactNode> = {
    newChat: <><path d="M20 12a7.5 7.5 0 0 1-10.6 6.8L5 20l1.3-4.1A7.5 7.5 0 1 1 20 12Z" /><path d="M12 8.8v6.4M8.8 12h6.4" /></>,
    apps: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.4" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4" /></>,
    bot: <><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M12 4v3M8 12h.01M16 12h.01M9 18v2M15 18v2" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
    desktop: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M9 20h6M12 16v4" /></>,
    users: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.7-3 2.5-4.5 5.5-4.5s4.8 1.5 5.5 4.5M16 6.5a2.5 2.5 0 0 1 0 5M17 14.5c1.9.2 3.1 1.6 3.5 3.5" /></>,
    calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M8 14h2M14 14h2M8 17h2" /></>,
    warehouse: <><path d="m3 10 9-6 9 6v10H3z" /><path d="M8 20v-6h8v6M6 10h12" /></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    folder: <><path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4h4l2 2.5h9A1.5 1.5 0 0 1 21 8v10.5A1.5 1.5 0 0 1 19.5 20h-15A1.5 1.5 0 0 1 3 18.5Z" /></>,
  };
  return <svg className="gea-shell-nav-icon" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg className={`gea-shell-chevron${open ? " is-open" : ""}`} aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m7 10 5 5 5-5" /></svg>;
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

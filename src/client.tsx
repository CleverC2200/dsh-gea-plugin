import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import pickerScript from "../lib/page-interaction.txt";
import { injectPicker } from "../packages/page-interaction/src/inject.ts";
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
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-api-remotes/client";
import type { LocaleSnapshot } from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import { zh, en, type CopyKey } from "./client/locales.ts";
import {createSnapshotStore} from "@deepseek-ai/dsh-client-store";
import type {ILayout as WorkbenchLayout} from "@cleverc2200/dsh-agent-workbench/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import { AgentAvatar } from "./client/agent-avatar.tsx";
import { Inbox } from "./client/inbox.tsx";
import { DesktopNavigation, createNavigationSelection, type ReadyNavigation } from './client/desktop-navigation.tsx';
import {registerHtmlClient} from "./html-client.tsx";
import { createBusinessIdentityReader, type BusinessIdentityProjection } from "./business-identity-client.ts";
import { installPageInteraction } from "../packages/page-interaction/src/client.ts";
import {
  approvalConversation,
  branchStockConversation,
  categoryPlanConversation,
  customerStockConversation,
  deliveryOpsConversation,
  demandOpsConversation,
  fullChainStockConversation,
  homeConversation,
  inboxConversation,
  inventoryConversation,
  inventoryWorkbenchConversation,
  mpsPlanConversation,
  orderFulfillmentConversation,
  orderManagementConversation,
  regionalPlanConversation,
  safetyStockConversation,
  supplyCoordinationConversation,
  type ConversationPromptConfig,
} from "./client/conversation-prompts.ts";
import {BUSINESS_MENU_PRESET,MAIN_MENU,businessMenuTitle,isGeaBusinessPanel,registeredBusinessPanels,resolveBusinessMenu,type BusinessMenuSection} from "./business-navigation.ts";
import {BUSINESS_GROUP_ICON_PATHS,type BusinessGroupIcon} from "./client/business-icons.ts";
import brandLogo from "./client/brand-logo.png";
import shellCss from "./client/shell.css";
import workbenchCss from "./workbench/workbench.css";
import categoryPlanPrototype from "./workbench/prototypes/category-plan-v5.html";
import mpsPlanPrototype from "./workbench/prototypes/mps-plan-v0.html";
import regionalPlanPrototype from "./workbench/prototypes/regional-plan-v9.html";
import { ApiLogCenter } from "./workbench/api-log-center.tsx";

/**
 * 原型自带的右侧会话区（aside.chat）和外壳的「品类计划助手」会话栏内容重复，
 * 只在这里把原型的空列关掉，原型的其它交互与交付文件保持一致。
 * 其它业务页（含厂商发布的 HTML 插件页）都不自带会话区，会话一律由外壳承载。
 */
const categoryPlanDocument = categoryPlanPrototype.replace(
  "</head>",
  '<style data-gea-embed="single-conversation">.app{grid-template-columns:minmax(0,1fr)!important}aside.chat{display:none!important}.work-body{scrollbar-width:none}.work-body::-webkit-scrollbar{display:none}.boundary,.work-head-row>div:first-child{display:none!important}.work-head{height:58px;box-sizing:border-box;padding:8px 16px;background:#fff}.work-head-row{height:100%;align-items:center}.work-head-actions{margin-left:0}</style></head>',
);
/** 主生产计划（MPS）数字人原型：同样只关掉它自带的右侧会话列，会话统一由外壳承载。 */
const regionalPlanDocument = regionalPlanPrototype.replace(
  "</head>",
  '<style data-gea-embed="compact-header">.topbar>.brand{display:none!important}.wrap{padding-top:0!important}.topbar{height:58px;min-height:58px;box-sizing:border-box;flex:none;align-items:center!important;flex-wrap:nowrap;padding:8px 16px;border:0;border-bottom:1px solid var(--line);border-radius:0;box-shadow:none;margin-left:-16px;margin-right:-16px}.topctl{flex-wrap:nowrap;overflow-x:auto;width:100%}</style></head>',
);
const mpsPlanDocument = mpsPlanPrototype.replace(
  "</head>",
  '<style data-gea-embed="single-conversation">.ap-app{grid-template-columns:minmax(0,1fr)!important}aside.ap-dock{display:none!important}.ap-brando{display:none!important}.ap-page-tabs{height:58px;box-sizing:border-box;align-items:center;padding-top:8px;padding-bottom:7px}</style></head>',
);

const selectionDocuments = {
  regional: injectPicker(regionalPlanDocument, pickerScript),
  category: injectPicker(categoryPlanDocument, pickerScript),
  mps: injectPicker(mpsPlanDocument, pickerScript),
};

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    geaProof: CopyKey;
  }
}

export const inject = ["slots", "uiSession", "layout", "locale", "uiWorkspace", "sessions", "agentWorkbench", "theme", "remote", "remote.session"];
const INBOX = "gea-inbox" as MainPanelId;
const PANEL = "gea-proof" as MainPanelId;
const API_LOG_PANEL = "gea-api-log" as MainPanelId;
const REGIONAL_PLAN_PANEL = "gea-regional-plan" as MainPanelId;
const CATEGORY_PLAN_PANEL = "plan-region-category" as MainPanelId;
const MPS_PLAN_PANEL = "plan-category-production" as MainPanelId;
type SidebarSection = BusinessMenuSection;
type SidebarSections = Record<SidebarSection, boolean>;

/** 在框架管理的原生会话旁注册仅承载业务的中心文档。 */
export function apply(ctx: Context): void {
  const layout = ctx.layout as WorkbenchLayout;
  const navigation = createSnapshotStore({drawer: "function" as "function" | "workspace" | "none", historyPanel: null as MainPanelId | null, linkedSession: null as SessionId | null, error: ""});
  const pageInteraction = installPageInteraction(ctx);
  const readBusinessIdentityScope = createBusinessIdentityReader();
  ctx.provide("geaIdentity", {
    getSnapshot: readBusinessIdentityScope.getSnapshot,
    subscribe: readBusinessIdentityScope.subscribe,
    readScope: readBusinessIdentityScope.readScope,
  });
  ctx.effect(() => readBusinessIdentityScope.start());
  registerHtmlClient(ctx, pageInteraction, ctx.geaIdentity);
  ctx.effect(() => ctx.locale.register("geaProof", { zh, en }));
  const t = ctx.locale.bind("geaProof");
  const navigationSelection = createNavigationSelection();
  /** 当前"这一页菜单叫什么"，给宿主上报用：优先用页面自己的标题，其次用原型目录名。 */
  const menuTitleOf = (menu: string | null | undefined): string =>
    businessMenuTitle(
      menu ?? MAIN_MENU,
      registeredBusinessPanels(ctx.slots.entries("main")),
      {
        [PANEL]: t("salesPlan"),
        [REGIONAL_PLAN_PANEL]: t("regionalPlanWorkbench"),
        [CATEGORY_PLAN_PANEL]: t("categoryPlanWorkbench"),
        [MPS_PLAN_PANEL]: t("mpsPlanWorkbench"),
        [INBOX]: t("businessInbox"),
      },
    );
  /**
   * 上报菜单状态字段（默认主对话，点菜单时带菜单名）。宿主只认这一份事实：
   * 主对话不交页面证据，业务菜单才交对应页面的上下文。
   * 上报失败就退化成主对话（会少给页面证据），所以失败重试一次，不静默丢。
   */
  const reportSurface = (
    sessionId: string | null | undefined,
    menu: string | null | undefined,
    attempt = 1,
  ): void => {
    if (!sessionId) return;
    const value = menu ?? MAIN_MENU;
    void apiLogRequest("surface", {
      sessionId,
      menu: value,
      title: menuTitleOf(value),
    }).catch(() => {
      if (attempt < 2)
        window.setTimeout(
          () => reportSurface(sessionId, value, attempt + 1),
          1500,
        );
    });
  };
  /** 页面与会话均就绪后才完成导航，取消或超时会撤销当前等待。 */
  const openNavigation = async (target: ReadyNavigation, signal: AbortSignal) => {
    if (![PANEL,INBOX].includes(target.panel as MainPanelId)) throw Error('NAVIGATION_TARGET_UNSUPPORTED');
    let clear = () => {};
    const arrival = new Promise<void>((resolve,reject) => {
      const cancel = () => {if(navigationSelection.getSnapshot()?.receipt===target.receipt)navigationSelection.set(null);reject(Error('NAVIGATION_REQUEST_CANCELLED'));};
      const timer = setTimeout(()=>{navigationSelection.set(null);reject(Error('NAVIGATION_TARGET_UNAVAILABLE'));},30000);
      clear = () => {clearTimeout(timer);};
      signal.addEventListener('abort',cancel,{once:true});
      navigationSelection.set({...target,visible:resolve,failed:reject});
      if (signal.aborted) cancel();
    });
    try {await Promise.all([ctx.agentWorkbench.open(target.panel as MainPanelId),arrival]);signal.throwIfAborted();}
    catch(error) {if(navigationSelection.getSnapshot()?.receipt===target.receipt)navigationSelection.set(null);throw error;}
    finally {clear();}
  };
  const injected = {
    hooks: {
      mainSessionId: ctx.uiSession.mainSessionId,
      geaLocale: {
        getSnapshot: () => ctx.locale.getSnapshot(),
        subscribe: (listener: () => void) => ctx.locale.subscribe(listener),
      } satisfies HostObservable<LocaleSnapshot>,
    },
  };
  const openMountedWorkbench = async (panel: MainPanelId, mounted: () => boolean) => {
    const current = () => mounted() && ctx.layout.panelInfo.getSnapshot().activePanelId === panel;
    if (!current()) return false;
    const opened = await ctx.agentWorkbench.open(panel);
    return current() && opened !== false;
  };
  const useBusinessIdentityRevision = () => {
    const [revision, setRevision] = useState(0);
    useEffect(() => {
      const changed = () => {
        setRevision(value => value + 1);
      };
      window.addEventListener("gea-business-identity-changed", changed);
      return () => window.removeEventListener("gea-business-identity-changed", changed);
    }, []);
    return revision;
  };
  type MainSessionProps = Pick<InjectFace<typeof injected>, "useMainSessionId">;
  function Workbench({
    useMainSessionId,
    useGeaLocale,
  }: PropsRuntime<"main"> & InjectFace<typeof injected>) {
    const identity = React.useSyncExternalStore(ctx.geaIdentity.subscribe, ctx.geaIdentity.getSnapshot);
    const authenticated = identity.state === "confirmed" && identity.status?.authenticated === true;
    const loginOverlay = identity.state === "confirmed" && !authenticated;
    const identityRevision = useBusinessIdentityRevision();
    const [opened, setOpened] = useState(false);
    const incoming = React.useSyncExternalStore(navigationSelection.subscribe,navigationSelection.getSnapshot);
    useEffect(() => {if (opened && incoming?.panel === PANEL) incoming.visible();},[opened,incoming]);
    // Host身份或子文档明确未登录后才铺遮罩，初次未知时保持页面稳定。
    const [sessionError, setSessionError] = useState("");
    useEffect(() => {
      setOpened(false);
      setSessionError("");
      if (!authenticated) return;
      let mounted = true;
      let hide = () => {};
      void openMountedWorkbench(PANEL, () => mounted).then(opened => {
        if (!mounted) return;
        if (!opened) { setSessionError("页面会话切换未完成，请重新打开业务页"); return; }
        hide = ctx.agentWorkbench.showConversation(PANEL);
        setOpened(true);
      }).catch(error => { if (mounted) setSessionError(String(error.message)); });
      return () => {
        mounted = false;
        hide();
      };
    }, [authenticated, identityRevision]);
    const language = useGeaLocale((snapshot) => snapshot.active);
    const currentSession = useMainSessionId(id => id);
    const frame = useRef<HTMLIFrameElement>(null);
    useEffect(() => {
      if (!frame.current || !currentSession || !opened) return;
      return pageInteraction.bindFrame({ frame: frame.current, sessionId: currentSession, page: t("salesPlan"), surface: "gea-workbench", tool: "gea_workbench_apply" });
    }, [currentSession, opened, identity.scope]);
    useEffect(() => {
      frame.current?.contentWindow?.postMessage(
        { type: "gea:session", sessionId: opened ? currentSession ?? null : null },
        window.location.origin,
      );
    }, [currentSession, opened]);
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
        if (message.type === "gea:identity")
          void readBusinessIdentityScope.refresh().catch(() => {});
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
    useEffect(() => {
      frame.current?.contentWindow?.postMessage({ type: "gea:identity-snapshot", snapshot: identity }, window.location.origin);
    }, [identity]);
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
            onLoad={() => {
              frame.current?.contentWindow?.postMessage({ type: "gea:session", sessionId: opened ? currentSession ?? null : null }, window.location.origin);
              frame.current?.contentWindow?.postMessage({ type: "gea:identity-snapshot", snapshot: identity }, window.location.origin);
            }}
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
  /** All embedded workbenches share the same conversation + page selection wiring. */
  function PrototypeWorkbench({panel,title,document:html,useMainSessionId}: PropsRuntime<"main"> & MainSessionProps & {panel:MainPanelId;title:string;document:string}) {
    const identityRevision = useBusinessIdentityRevision();
    const [sessionError,setSessionError]=useState("");
    const [opened,setOpened]=useState(false);
    const session=useMainSessionId(id => id);
    const frame=useRef<HTMLIFrameElement>(null);
    useEffect(()=>{
      let live=true;
      setOpened(false);setSessionError("");
      const hide=ctx.agentWorkbench.showConversation(panel);
      void openMountedWorkbench(panel, () => live).then(opened=>{if(live)setOpened(opened);}).catch(error=>{if(live)setSessionError(String(error.message));});
      return ()=>{live=false;hide();};
    },[panel, identityRevision]);
    useEffect(()=>{
      if(!opened||!session||!frame.current)return;
      return pageInteraction.bindFrame({frame:frame.current,sessionId:session,page:`${title}（原型）`,surface:panel});
    },[opened,session,panel,title]);
    return <><style>{shellCss}</style>{sessionError&&<div role="alert">{sessionError}</div>}
      <section className="gea-workbench-shell"><iframe ref={frame} className="gea-workbench-frame" title={title} sandbox="allow-scripts" srcDoc={html}/></section>
    </>;
  }
  function RegionalPlanPage(props:PropsRuntime<"main"> & MainSessionProps) {
    return <PrototypeWorkbench {...props} panel={REGIONAL_PLAN_PANEL} title={t("regionalPlanWorkbench")} document={selectionDocuments.regional}/>;
  }
  function CategoryPlanPage(props:PropsRuntime<"main"> & MainSessionProps) {
    return <PrototypeWorkbench {...props} panel={CATEGORY_PLAN_PANEL} title={t("categoryPlanWorkbench")} document={selectionDocuments.category}/>;
  }
  function MpsPlanPage(props:PropsRuntime<"main"> & MainSessionProps) {
    return <PrototypeWorkbench {...props} panel={MPS_PLAN_PANEL} title={t("mpsPlanWorkbench")} document={selectionDocuments.mps}/>;
  }
  function ApiLogPage() {
    useEffect(() => layout.registerFullscreenPanel(API_LOG_PANEL), []);
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
    const identityRevision = useBusinessIdentityRevision();
    const incoming = React.useSyncExternalStore(navigationSelection.subscribe,navigationSelection.getSnapshot);
    useEffect(() => {
      const hide = ctx.agentWorkbench.showConversation(INBOX);
      let mounted = true;
      void openMountedWorkbench(INBOX, () => mounted).catch(() => {
        /* 会话打不开时页面照常可看，不额外打扰用户。 */
      });
      return () => { mounted = false; hide(); };
    }, [identityRevision]);
    return (
      <>
        <style>{shellCss}</style>
        <Inbox t={t} navigation={incoming?.panel === INBOX ? incoming : null} />
      </>
    );
  }
  function useIdentity() {
    const identity = React.useSyncExternalStore(ctx.geaIdentity.subscribe, ctx.geaIdentity.getSnapshot);
    const user = identity.state === "confirmed" && identity.status?.authenticated ? identity.status.user : null;
    return { name: user?.name ?? "", avatarUrl: user?.avatar ?? "" };
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
    useMainSessionId,
    wide,
    expandSidebar,
    sections,
    onToggleSection,
  }: PropsRuntime<"sidebar.workspaces"> & MainSessionProps & {
    sections?: SidebarSections;
    onToggleSection?: (section: SidebarSection) => void;
  }) {
    const [expanded, setExpanded] = useState<SidebarSections>({ supply: true, plan: true, inventory: true, orders: true });
    const open = sections ?? expanded;
    const activePanel = usePanelInfo((info) => info.activePanelId);
    const session = useMainSessionId(id => id);
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
    // 点菜单＝把"这个对话现在在哪一页"报给宿主，由宿主同时加载该菜单的上下文。
    const child = ({ id, title, disabled }: { id: string; title: string; disabled: boolean }) => (
      <button key={id} type="button" disabled={disabled} data-gea-business-entry={id} aria-current={activePanel === id ? "page" : undefined} className={`gea-shell-nav-child${activePanel === id ? " is-active" : ""}`} onClick={() => { reportSurface(session ?? null, id); ctx.layout.selectPanel(id as MainPanelId); }}><span className="gea-shell-label">{title}</span></button>
    );
    // 菜单分组与顺序按原型固定；没有接入页面的条目（如生产计划、订单履约）自动隐藏。
    const available = new Map<string, string>(panels.map((panel) => [panel.id, panel.title]));
    available.set(PANEL, t("salesPlan"));
    available.set(REGIONAL_PLAN_PANEL, t("regionalPlanWorkbench"));
    available.set(CATEGORY_PLAN_PANEL, t("categoryPlanWorkbench"));
    available.set(MPS_PLAN_PANEL, t("mpsPlanWorkbench"));
    const menu = resolveBusinessMenu(BUSINESS_MENU_PRESET, available);
    return (
      <nav
        className="gea-shell-navigation"
        aria-label={t("businessNavigation")}
      >
        <style>{shellCss}</style>
        <div className="gea-shell-navigation-content">
          {menu.map((group) => (
            <div className={`gea-shell-nav-section${group.flat ? " is-flat" : ""}`} key={group.key}>
              {!group.flat && <button type="button" className="gea-shell-nav-heading" aria-expanded={open[group.key]} onClick={() => toggle(group.key)}>
                <NavIcon kind={group.icon as NavIconKind} /><span>{group.title}</span><Chevron open={open[group.key]} />
              </button>}
              {(group.flat || open[group.key]) && <div className="gea-shell-nav-children">{group.entries.map(child)}</div>}
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
      layout.expandSidebar();
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
      { name: "main", key: REGIONAL_PLAN_PANEL, locale: "geaProof", inject: () => injected },
      RegionalPlanPage,
    );
    yield ctx.slots.register(
      { name: "main", key: CATEGORY_PLAN_PANEL, locale: "geaProof", inject: () => injected },
      CategoryPlanPage,
    );
    yield ctx.slots.register(
      { name: "main", key: MPS_PLAN_PANEL, locale: "geaProof", inject: () => injected },
      MpsPlanPage,
    );
    const nativePages = [PANEL, REGIONAL_PLAN_PANEL, CATEGORY_PLAN_PANEL, MPS_PLAN_PANEL, INBOX];
    const controller = new AbortController();
    const scope = async () => (await ctx.geaIdentity.readScope(controller.signal)) ?? "gea:anonymous";
    for (const id of nativePages) yield ctx.agentWorkbench.register({ id, preset: "gea-readonly", scope });
    const changed = () => {
      for (const id of nativePages) ctx.agentWorkbench.forget(id);
      const active = ctx.layout.panelInfo.getSnapshot().activePanelId;
      if (active && nativePages.includes(active)) ctx.layout.selectPanel(active);
    };
    window.addEventListener("gea-business-identity-changed", changed);
    yield () => {
      controller.abort();
      window.removeEventListener("gea-business-identity-changed", changed);
    };
    ctx.agentWorkbench.selectDefault(PANEL);
  });
  function NavigationLifecycle({useMainSessionId, usePanelInfo, useGeaLocale}: PropsRuntime<"shell.overlay"> & MainSessionProps & InjectFace<{hooks: {geaLocale: HostObservable<LocaleSnapshot>}}>) {
    const activePanel = usePanelInfo(info => info.activePanelId);
    const session = useMainSessionId(id => id);
    const wasBusiness = useRef(false);
    const locale = useGeaLocale(value => value);
    useEffect(() => layout.registerDocumentTitle(t("geaBusiness")), [locale]);
    useEffect(() => {
      const business = isGeaBusinessPanel(activePanel, ctx.slots.entries("main"));
      const state = navigation.getSnapshot();
      if (business && !wasBusiness.current && !state.historyPanel) navigation.set({...state, drawer: "function"});
      wasBusiness.current = business;
    }, [activePanel]);
    useEffect(() => { reportSurface(session ?? null, activePanel ?? null); }, [session, activePanel]);
    useEffect(() => {
      const state = navigation.getSnapshot();
      if (!state.historyPanel || !session || session === state.linkedSession) return;
      navigation.set({...state, linkedSession: session});
      void ctx.agentWorkbench.open(state.historyPanel, "gea-history", session)
        .then(committed => { if (committed === false) throw Error("当前会话不能绑定到此业务页"); })
        .catch(error => navigation.set({...navigation.getSnapshot(), error: error.message}));
    }, [session]);
    useEffect(() => {
      const state = navigation.getSnapshot();
      if (activePanel && state.historyPanel && activePanel !== state.historyPanel)
        navigation.set({...state, historyPanel: null});
    }, [activePanel]);
    return null;
  }

  function SidebarNavigation(props: PropsRuntime<"sidebar.navigation"> & MainSessionProps) {
    const state = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
    const selectDrawer = (drawer: typeof state.drawer) => {
      navigation.set({...state, drawer: state.drawer === drawer ? "none" : drawer, historyPanel: null});
    };
    const startSession = () => { navigation.set({...state, drawer: "workspace", historyPanel: null}); props.startSession(); };
    const expand = (drawer: typeof state.drawer) => { navigation.set({...state, drawer}); props.expandSidebar(); };
    if (!props.wide) return <nav className="gea-sidebar-rail" aria-label={t("businessNavigation")}>
      <style>{shellCss}</style>
      <button aria-label={t("startConversation")} onClick={startSession}><NavIcon kind="newChat"/></button>
      <button aria-label={t("functionArea")} onClick={() => expand("function")}><NavIcon kind="apps"/></button>
      <button aria-label={t("workspaceArea")} onClick={() => expand("workspace")}><NavIcon kind="folder"/></button>
    </nav>;
    return <div className="gea-sidebar-navigation">
      <style>{shellCss}</style>
      <button type="button" className="gea-sidebar-tab" aria-label={t("aiWorkbench")} onClick={startSession}><NavIcon kind="newChat"/><span>{t("aiWorkbench")}</span></button>
      <button type="button" className="gea-sidebar-tab" aria-expanded={state.drawer === "function"} onClick={() => selectDrawer("function")}><span>{t("functionArea")}</span><Chevron open={state.drawer === "function"}/></button>
      <button type="button" className="gea-sidebar-tab" aria-expanded={state.drawer === "workspace"} onClick={() => selectDrawer("workspace")}><span>{t("workspaceArea")}</span><Chevron open={state.drawer === "workspace"}/></button>
      <div className="gea-sidebar-browser">
        {state.drawer === "function" && <Navigation {...props} wide={props.wide} expandSidebar={props.expandSidebar}/>}
        <div hidden={state.drawer !== "workspace"}>{props.renderWorkspaces()}</div>
      </div>
    </div>;
  }

  function BusinessConversationToolbar({usePanelInfo, useMainSessionId}: PropsRuntime<"shell.conversation.toolbar"> & MainSessionProps) {
    const activePanel = usePanelInfo(info => info.activePanelId);
    const session = useMainSessionId(id => id);
    const presentation = React.useSyncExternalStore(layout.shellPresentation.subscribe, layout.shellPresentation.getSnapshot);
    const state = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot);
    if (!activePanel || !isGeaBusinessPanel(activePanel, ctx.slots.entries("main"))) return null;
    return <ConversationToolbar view={presentation.conversationView} onViewChange={view => layout.setConversationView(view)} error={state.error}
      onHistory={() => { navigation.set({...state, drawer: "workspace", historyPanel: activePanel, linkedSession: session ?? null}); layout.expandSidebar(); }}
      onNewConversation={() => {
        navigation.set({...state, historyPanel: null, error: ""});
        void ctx.agentWorkbench.open(activePanel, `gea-new-${crypto.randomUUID()}`)
          .then(committed => { if (committed === false) throw Error("页面会话切换未完成"); })
          .catch(error => navigation.set({...navigation.getSnapshot(), error: error.message}));
      }}/>
  }

  function Welcome({usePanelInfo, inputActions}: PropsRuntime<"conversation.hero.content">) {
    const activePanel = usePanelInfo(info => info.activePanelId);
    return <div className="gea-welcome-content"><style>{shellCss}</style>
      {activePanel ? <AgentWelcome agent={conversationAgentFor(activePanel)} onFill={prompt => inputActions?.setDraft(prompt)}/> :
        <GeaHomeHero copy={{label: t("geaBusiness"), eyebrow: t("homeEyebrow"), title: t("homeTitle"), description: t("homeDescription")}}/>}
    </div>;
  }

  ctx.slots.inject("sidebar.navigation", () => ctx.slots.register({name: "sidebar.navigation", locale: "geaProof", inject: () => injected}, SidebarNavigation));
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({name: "sidebar.footer.action", id: "gea-inbox", locale: "geaProof"}, function InboxShortcut() {
    return <button className="gea-inbox-quick-action" aria-label={t("messageInbox")} onClick={() => ctx.layout.selectPanel(INBOX)}><NavIcon kind="bell"/></button>;
  }));
  ctx.slots.inject("conversation.chat.running.text", () => ctx.slots.register({name: "conversation.chat.running.text", locale: "geaProof"}, function WaitingText({duration}: PropsRuntime<"conversation.chat.running.text">) {
    return duration === undefined ? t("thinking") : t("thinkingFor").replace("{duration}", duration);
  }));
  ctx.slots.inject("shell.conversation.toolbar", () => ctx.slots.register({name: "shell.conversation.toolbar", locale: "geaProof", inject: () => injected}, BusinessConversationToolbar));
  ctx.slots.inject("conversation.header.content", () => ctx.slots.register({name: "conversation.header.content"}, function HeaderContent({usePanelInfo, renderDefault}: PropsRuntime<"conversation.header.content">) {
    const panel = usePanelInfo(info => info.activePanelId);
    return isGeaBusinessPanel(panel, ctx.slots.entries("main")) ? null : renderDefault();
  }));
  ctx.slots.inject("conversation.hero.content", () => ctx.slots.register({name: "conversation.hero.content", locale: "geaProof"}, Welcome));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {name:'shell.overlay',id:'gea-identity-sync-notice'},
    function IdentitySyncNotice() {
      const identity = React.useSyncExternalStore(ctx.geaIdentity.subscribe, ctx.geaIdentity.getSnapshot);
      return identity.error ? <div role="alert" data-gea-identity-error style={{position:"fixed",top:12,left:"50%",transform:"translateX(-50%)",zIndex:2200,maxWidth:"min(680px, calc(100vw - 24px))",padding:"10px 16px",borderRadius:8,background:"var(--dsw-alias-container-base, #fff)",color:"var(--dsw-alias-label-primary, #20232a)",boxShadow:"0 4px 20px #0003"}}>GEA 身份同步暂不可用：{identity.error}</div> : null;
    },
  ));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {name:'shell.overlay',id:'gea-desktop-navigation',locale:'geaProof'},
    () => <DesktopNavigation t={t} open={openNavigation} login={()=>ctx.layout.selectPanel(PANEL)} />,
  ));
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      { name: "shell.overlay", id: "gea-navigation-lifecycle", locale: "geaProof", inject: () => injected },
      NavigationLifecycle,
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

declare module "@deepseek-ai/cordis" {
  interface Context {
    geaIdentity: BusinessIdentityProjection;
  }
}

function AgentWelcome({
  agent,
  onFill,
}: {
  agent: ConversationPromptConfig;
  onFill: (prompt: string) => void;
}) {
  return (
    <section className="gea-agent-welcome" aria-label={agent.name}>
      <div className="gea-agent-identity">
        <AgentAvatar className="gea-agent-avatar" />
        <h2>{agent.name}</h2>
        <p className="gea-agent-intro">{agent.intro}<b>{agent.boundary}</b></p>
      </div>
      <div className="gea-agent-block gea-agent-prompts">
        <h3>你可以这样问</h3>
        {agent.prompts.map((prompt) => <button key={prompt} type="button" onClick={() => onFill(prompt)}>{prompt}</button>)}
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

type ConversationView = "center" | "split" | "chat";

/** The three layout choices share one toolbar, even when either content column is hidden. */
function ConversationToolbar({
  view,
  onViewChange,
  onHistory,
  onNewConversation,
  error,
}: {
  view: ConversationView;
  onViewChange: (view: ConversationView) => void;
  onHistory: () => void;
  onNewConversation: () => void;
  error: string;
}) {
  const choices: { view: ConversationView; label: string; icon: React.ReactNode }[] = [
    { view: "center", label: "中间区域最大，隐藏会话区", icon: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></> },
    { view: "split", label: "同时显示中间区域和会话区", icon: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 3v18" /></> },
    { view: "chat", label: "会话区最大，隐藏中间区域", icon: <path d="M4 4h16v13H9l-5 4V4Zm4 4h8m-8 4h6" /> },
  ];
  return <div className="gea-conversation-toolbar" role="toolbar" aria-label="对话区视图与会话操作">
    <div className="gea-conversation-view-switch" role="group" aria-label="区域显示方式">
      {choices.map((choice) => <button key={choice.view} type="button" aria-label={choice.label} title={choice.label} aria-pressed={view === choice.view} onClick={() => onViewChange(choice.view)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{choice.icon}</svg>
      </button>)}
    </div>
    <button type="button" className="gea-conversation-toolbar-action" aria-label="历史对话" title="历史对话" onClick={onHistory}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10a9 9 0 1 1 0 4M3 4v6h6M12 7v5l3 2" /></svg>
    </button>
    <button type="button" className="gea-conversation-toolbar-action" aria-label="新建对话" title="新建对话" onClick={onNewConversation}>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 7v10M7 12h10" /></svg>
    </button>
    {error && <span className="gea-conversation-toolbar-error" role="alert" title={error}>新建对话失败</span>}
  </div>;
}

/** 每个业务页配各自的会话助手：名字、介绍、推荐提问都跟那一页的工作台对齐。 */
const BUSINESS_CONVERSATIONS: Record<string, ConversationPromptConfig> = {
  [PANEL]: approvalConversation,
  [REGIONAL_PLAN_PANEL]: regionalPlanConversation,
  [CATEGORY_PLAN_PANEL]: categoryPlanConversation,
  [MPS_PLAN_PANEL]: mpsPlanConversation,
  "inventory-dealer": inventoryConversation,
  "inventory-apsdemand": demandOpsConversation,
  "inventory-apsdelivery": deliveryOpsConversation,
  "inventory-aqkc": safetyStockConversation,
  "inventory-fc": branchStockConversation,
  "inventory-personal": inventoryWorkbenchConversation,
  "inventory-qll": fullChainStockConversation,
  "inventory-apsplan": supplyCoordinationConversation,
  "inventory-customer": customerStockConversation,
  "inventory-orderworkbench": orderManagementConversation,
  "inventory-orderfulfillment": orderFulfillmentConversation,
};

function conversationAgentFor(panel: MainPanelId | null | undefined): ConversationPromptConfig {
  if (!panel) return homeConversation;
  if (panel === INBOX) return inboxConversation;
  return BUSINESS_CONVERSATIONS[panel] ?? homeConversation;
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

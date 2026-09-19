/** 独立认证文档中的 GEA 原审批工作台。 */
import { RegionalApprovalResubmitDialog } from './original/workbenches/regionalApproval/RegionalApprovalResubmitDialog.tsx';
import type { GeaSalesPlanPeriod } from './original/contracts.ts';
import { createWorkflowLoader } from "./workflow-loader.ts";
import "@arco-design/web-react/dist/css/arco.css";
import React, { useCallback, useEffect, useRef, useState } from "react";
import i18next from "i18next";
import {
  RegionalApprovalWorkbench,
  WorkbenchSessionProvider,
  bindWorkbenchHost,
  BackendHttpError,
  type WorkbenchHost,
  type RegionalApprovalWorkbenchContext,
} from "./original/index.ts";
import commonEn from "./original/en-US.json" with { type: "json" };
import commonZh from "./original/zh-CN.json" with { type: "json" };
import { salesPlan } from "./original/bridge.ts";
import type { Business, Preview } from "../host/business.ts";
import type { CopyKey } from "../client/locales.ts";
import "./workbench.css";
import logo from "./gea-logo.png";
import { ApiLogCenter } from "./api-log-center.tsx";

type HtmlPlugin = { id: string; label: string; group: string; url: string };
const HTML_PLUGINS: HtmlPlugin[] = [
  { id: "inventory-apsboard", label: "产销协同看板", group: "产销协同", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/bb0ebb159dd3ceb08f829dc928896ba5ea6bb18a/packages/inventory-apsboard-0.1.0-preview.9.zip" },
  { id: "inventory-apsdemand", label: "需求运营管理", group: "产销协同", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/bb0ebb159dd3ceb08f829dc928896ba5ea6bb18a/packages/inventory-apsdemand-0.1.0-preview.9.zip" },
  { id: "inventory-apsdelivery", label: "交付运营管理", group: "产销协同", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/bb0ebb159dd3ceb08f829dc928896ba5ea6bb18a/packages/inventory-apsdelivery-0.1.0-preview.9.zip" },
  { id: "inventory-personal", label: "库存管理工作台", group: "库存管理", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/bb0ebb159dd3ceb08f829dc928896ba5ea6bb18a/packages/inventory-personal-0.2.7-preview.1.zip" },
  { id: "inventory-aqkc", label: "安全库存", group: "库存管理", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/36b3723b0fa734c22c609249448682fef945c3e5/packages/inventory-aqkc-0.2.6-preview.1.zip" },
  { id: "inventory-dealer", label: "经销商库存", group: "库存管理", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/36b3723b0fa734c22c609249448682fef945c3e5/packages/inventory-dealer-0.2.6-preview.1.zip" },
  { id: "inventory-fc", label: "分仓库存", group: "库存管理", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/36b3723b0fa734c22c609249448682fef945c3e5/packages/inventory-fc-0.2.6-preview.1.zip" },
  { id: "inventory-qll", label: "全链路库存", group: "库存管理", url: "http://100.100.6.191:20656/chenyonghao/dsh-plugin-releases/raw/36b3723b0fa734c22c609249448682fef945c3e5/packages/inventory-qll-0.2.6-preview.1.zip" },
];

function ShellIcon({ name }: { name: "home" | "robot" | "users" | "calendar" | "box" | "settings" | "plus" | "history" | "send" | "menu" }) {
  const paths: Record<string, string> = {
    home: "M3 10.5 12 3l9 7.5V21H14v-6h-4v6H3z",
    robot: "M8 9h8a3 3 0 0 1 3 3v6H5v-6a3 3 0 0 1 3-3Zm4-6v3M8 14h.01M16 14h.01M8 18v2m8-2v2",
    users: "M16 20v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1m6-9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7a3 3 0 0 1 0 6m3 10v-1a4 4 0 0 0-3-3.87",
    calendar: "M5 4h14a2 2 0 0 1 2 2v13H3V6a2 2 0 0 1 2-2Zm3-2v4m8-4v4M3 9h18",
    box: "M4 7 12 3l8 4v10l-8 4-8-4V7Zm0 0 8 4 8-4M12 11v10",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v3m0 13v3M4.93 4.93l2.12 2.12m9.9 9.9 2.12 2.12M3 12h3m12 0h3M4.93 19.07l2.12-2.12m9.9-9.9 2.12-2.12",
    plus: "M12 5v14M5 12h14",
    history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2",
    send: "m3 4 18 8-18 8 3-8-3-8Zm3 8h15",
    menu: "M4 6h16M4 12h16M4 18h16",
  };
  return <svg className="gea-shell-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

type Status = ReturnType<Business["status"]>;
type Translate = (key: CopyKey) => string;
type AnalysisScope = "summary" | "details";
type VisibleWorkbenchContext = {
  format: "gea-workbench-visible-v1";
  sequence: number;
  view: "regional-approval";
  scope: {
    month: string;
    planType: string;
    approvalStage: string;
    dimension: string | null;
  };
  visibleRows: Array<Record<string, string | number | null>>;
  selectedPlanIds: string[];
  pagination: { page: number; pageSize: number; total: number };
  evidence: {
    source: "gea-user-session";
    completeness: "paged-queue";
    queryState: "success";
    dataVersion: string;
  };
};

function visibleWorkbenchContext(
  context: RegionalApprovalWorkbenchContext,
  sequence: number,
): VisibleWorkbenchContext | undefined {
  if (
    context.evidence.source !== "gea-user-session" ||
    context.evidence.completeness !== "paged-queue" ||
    context.evidence.queryState !== "success"
  )
    return undefined;
  const rows = context.visibleEntities
    .filter((entity) => entity.source === "gea")
    .map((entity) => ({
      planId: entity.id,
      organization: entity.organizationKey,
      planTypeCode: entity.planTypeCode ?? null,
      approvalState: String(entity.approvalState),
      status: entity.status ?? null,
      versionId: entity.versionId ?? null,
      seq: entity.seq ?? null,
      dealerCode: entity.dealerCode ?? null,
      orgCode: entity.orgCode ?? null,
      provinceCode: entity.provinceCode ?? null,
      areaCode: entity.areaCode ?? null,
      currentQty: entity.currentQty ?? null,
      currentAmount: entity.currentAmount ?? null,
      targetAmount: entity.targetAmount ?? null,
      skuCount: entity.skuCount ?? null,
      submitter: entity.submitter ?? null,
      returnReason: entity.returnReason ?? null,
    }));
  return {
    format: "gea-workbench-visible-v1",
    sequence,
    view: "regional-approval",
    scope: {
      month: context.scope.month,
      planType: context.scope.planType,
      approvalStage: context.scope.approvalStage,
      dimension: context.scope.dimension ?? null,
    },
    visibleRows: rows,
    selectedPlanIds: [...new Set(
      context.selectedEntities
        .filter((entity) => entity.source === "gea")
        .map((entity) => entity.id),
    )].sort(),
    pagination: context.pagination,
    evidence: {
      source: "gea-user-session",
      completeness: "paged-queue",
      queryState: "success",
      dataVersion: context.evidence.dataVersion,
    },
  };
}
const locale = i18next.createInstance();
const language = (
  new URLSearchParams(window.location.search).get("locale") ??
  navigator.language
).startsWith("zh")
  ? "zh-CN"
  : "en-US";
void locale.init({
  lng: language,
  fallbackLng: "en-US",
  initImmediate: false,
  resources: {
    "zh-CN": { translation: { common: commonZh } },
    "en-US": { translation: { common: commonEn } },
  },
  interpolation: { escapeValue: false },
});

async function rpc<T>(
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
  if (!response.ok || result.ok !== true) {
    const code = result.error?.code ?? "GEA_REQUEST_FAILED";
    const upstreamStatus = /^GEA_HTTP_([45]\d{2})$/.exec(code)?.[1];
    const status =
      code === "LOGIN_REQUIRED"
        ? 401
        : upstreamStatus
          ? Number(upstreamStatus)
          : response.ok
            ? 502
            : response.status;
    throw new BackendHttpError({
      method: "POST",
      path: endpoint,
      status,
      body: { code: endpoint === "workflow/config" ? "GEA_WORKFLOW_LOAD_FAILED" : code, error: result.error?.message ?? code, details: result.error?.details },
    });
  }
  return result.value;
}
function query<T>(
  kind: string,
  input: { signal?: AbortSignal } = {},
): Promise<T> {
  const { signal, ...fields } = input;
  return rpc<T>("workbench/query", { kind, query: fields }, signal);
}
const unavailable = async (): Promise<never> => {
  throw new Error("GEA_WRITE_ADAPTER_NOT_CONNECTED");
};
const loadWorkflow = createWorkflowLoader((signal) => rpc("workflow/config", {}, signal));
const host: WorkbenchHost = {
  salesPlan: {
    draft: { invoke: ({signal, ...input}) => rpc("sales-plan/draft", input, signal) },
    periods: { invoke: async (input) => {
      await loadWorkflow(input?.signal);
      return query("periods", input);
    } },
    list: { invoke: (input) => query("list", input) },
    detail: { invoke: (input) => query("detail", input) },
    versions: { invoke: (input) => query("versions", input) },
    logs: { invoke: (input) => query("logs", input) },
    versionSkus: { invoke: (input) => query("versionSkus", input) },
    compare: { invoke: (input) => query("compare", input) },
    action: { invoke: (input) => rpc("sales-plan/action", input) },
    submit: { invoke: (input) => rpc("sales-plan/submit", input) },
  },
  modelInference: {
    invoke: ({ signal, ...input }) => rpc("model/advice", input, signal),
  },
};
bindWorkbenchHost(host);
const resubmitClient = {
  detail: host.salesPlan.detail,
  versionSkus: host.salesPlan.versionSkus,
  submit: host.salesPlan.submit,
  currentUser: { invoke: async () => {
    const state = await rpc<Status>('status');
    if (!state.user) throw new Error('LOGIN_REQUIRED');
    return { id: state.user.id, username: state.user.username };
  } },
};

function requestErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof BackendHttpError) {
    if (error.code === "GEA_REQUEST_TIMEOUT") return t("requestTimeout");
    if (error.code === "GEA_NETWORK_ERROR") return t("networkError");
    if (error.code === "SNAPSHOT_TOO_LARGE") return t("analysisTooLarge");
    if (error.status === 401) return t("loginExpired");
    if (error.status === 403) return t("forbidden");
    if (error.code.startsWith("STALE_")) return t("stale");
  }
  return t("retry");
}

/** 只挂载真实 GEA 数据；未认证或查询失败时绝不切换到 fixture。 */
export function WorkbenchPage({ t }: { t: Translate }) {
  const [status, setStatus] = useState<Status>();
  const directApiLog = new URLSearchParams(window.location.search).get("view") === "api-log";
  const initialView = new URLSearchParams(window.location.search).get("plugin") ?? "workbench";
  const [shellView, setShellView] = useState<"plugin" | "workbench">(initialView === "workbench" ? "workbench" : "plugin");
  const [selectedPlugin, setSelectedPlugin] = useState<HtmlPlugin>(HTML_PLUGINS.find((plugin) => plugin.id === initialView) ?? HTML_PLUGINS[0]);
  const pluginFrame = useRef<HTMLIFrameElement>(null);
  const [apiLogOpen, setApiLogOpen] = useState(directApiLog);
  const [workbenchRevision, setWorkbenchRevision] = useState(0);
  const [resubmit, setResubmit] = useState<{ planId: string; versionId: string; period: GeaSalesPlanPeriod }>();
  useEffect(() => {
    setResubmit(undefined);
    if (!directApiLog) setApiLogOpen(false);
  }, [directApiLog, status?.environment, status?.user?.id]);
  const [qr, setQr] = useState<{ image: string; loginId: string }>();
  const [expired, setExpired] = useState(false);
  const [qrRefresh, setQrRefresh] = useState(0);
  const [modelState, setModelState] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [analysisScope, setAnalysisScope] = useState<AnalysisScope>("summary");
  const [preview, setPreview] = useState<Preview>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    window.parent.postMessage(
      {
        type: "gea:identity",
        avatar: status?.authenticated ? (status.user?.avatar ?? "") : "",
        authenticated: status?.authenticated === true,
        name: status?.authenticated ? (status.user?.name ?? "") : "",
        avatarUrl: status?.authenticated ? (status.user?.avatar ?? "") : "",
      },
      window.location.origin,
    );
  }, [status]);
  const notifyPluginIdentity = useCallback(() => {
    pluginFrame.current?.contentWindow?.postMessage(
      {
        type: "gea:identity",
        authenticated: status?.authenticated === true,
        name: status?.user?.name ?? "",
        avatarUrl: status?.user?.avatar ?? "",
        environment: status?.environment,
      },
      "*",
    );
  }, [status]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== window.parent ||
        event.data?.type !== "gea:session"
      )
        return;
      const value = event.data.sessionId;
      if (
        value === null ||
        (typeof value === "string" && /^session-[0-9a-f-]{36}$/.test(value))
      )
        setSessionId(value);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const request = useRef<AbortController>();
  const selectionRef = useRef("");
  const contextSequence = useRef(0);
  const contextRef = useRef("");
  const [conversationContext, setConversationContext] =
    useState<VisibleWorkbenchContext>();
  const onContextChange = useCallback(
    (context: RegionalApprovalWorkbenchContext) => {
      const nextSequence = contextSequence.current + 1;
      const nextContext = visibleWorkbenchContext(context, nextSequence);
      const nextKey = nextContext
        ? JSON.stringify({ ...nextContext, sequence: 0 })
        : '';
      if (nextKey !== contextRef.current) {
        contextRef.current = nextKey;
        contextSequence.current = nextSequence;
        setConversationContext(
          nextContext,
        );
      }
      const ids =
        context.evidence.source === "gea-user-session" &&
        context.evidence.queryState === "success"
          ? context.selectedEntities
              .filter((entity) => entity.source === "gea")
              .map((entity) => entity.id)
          : [];
      const selectedIds = [...new Set(ids)].sort();
      const key = JSON.stringify({
        selectedIds,
        scope: context.scope,
        evidence: context.evidence,
        selectedVersions: context.selectedEntities.map((entity) => [
          entity.id,
          entity.versionId,
          entity.seq,
          entity.status,
        ]),
      });
      if (key !== selectionRef.current) {
        selectionRef.current = key;
        setSelection(selectedIds);
        setPreview(undefined);
        request.current?.abort();
        setBusy(false);
      }
    },
    [],
  );
  useEffect(() => {
    if (!sessionId) return;
    // 首次进入时 live 查询可能还在加载；不要把一个暂时为空的快照当成最终结果。
    // conversationContext 一旦产生会立即触发本 effect，后续分页/筛选也会持续同步。
    if (!conversationContext) return;
    const controller = new AbortController();
    void rpc(
      "workbench/context",
      { sessionId, context: conversationContext ?? null },
      controller.signal,
    ).catch(() => {
      // 上下文同步失败不能影响审批工作台；下一次上下文变化会自动重试。
    });
    return () => controller.abort();
  }, [conversationContext, sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void rpc<Status>("status", {}, controller.signal)
      .then(setStatus)
      .catch((error) => {
        if (!controller.signal.aborted) setError(requestErrorMessage(error, t));
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!qr) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await rpc<Status & { status: string }>(
          "login/poll",
          { loginId: qr.loginId },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (value.status === "authenticated") {
          setStatus(value);
          setQr(undefined);
          return;
        }
        if (value.status === "expired") {
          setExpired(true);
          return;
        }
        timer = setTimeout(poll, 1000);
      } catch (error) {
        if (!controller.signal.aborted) setError(requestErrorMessage(error, t));
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [qr]);
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      await work(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(requestErrorMessage(error, t));
        if (error instanceof BackendHttpError && error.status === 401)
          setStatus((previous) =>
            previous ? { ...previous, authenticated: false } : previous,
          );
      }
    } finally {
      if (request.current === controller) setBusy(false);
    }
  };
  useEffect(() => {
    if (!status || status.authenticated) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError("");
    setQr(undefined);
    setExpired(false);
    void rpc<{ image: string; loginId: string }>(
      "login/start",
      { environment: status.environment },
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setQr(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(requestErrorMessage(error, t));
      })
      .finally(() => {
        if (request.current === controller) setBusy(false);
      });
    return () => controller.abort();
  }, [status?.authenticated, status?.environment, qrRefresh]);
  useEffect(() => {
    setModelState("");
    if (!status?.authenticated || status.mode !== "model") return;
    const controller = new AbortController();
    setModelState(t("modelDiscovering"));
    void rpc<{ models: string[]; selected: string; selectedName: string }>(
      "model/discover",
      {},
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setModelState(t("modelDiscovered") + value.selectedName);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          const code = error instanceof BackendHttpError ? error.code : "";
          setModelState(
            code === "LOGIN_REQUIRED"
              ? "请先登录 GEA 后再使用个人模型"
              : t("modelFailed") + (code || requestErrorMessage(error, t)),
          );
        }
      });
    return () => controller.abort();
  }, [status?.authenticated, status?.environment]);
  if (!status?.authenticated)
    return (
      <main className="gea-login-page">
        <section className="gea-login-card" aria-label="GEA">
          <img
            className="gea-login-logo"
            src={logo}
            alt="GEA"
            width="56"
            height="56"
          />
          <h2>{t("welcomeLogin")}</h2>
          <p>{t("scanInstructions")}</p>
          <div className={`gea-login-qr${expired ? " is-expired" : ""}`} aria-busy={busy || (!status && !error)}>
            {qr ? (
              <img src={qr.image} alt={t("login")} width="220" height="220" />
            ) : (
              <div className="gea-qr-placeholder" role="status">
                {!error && <span className="gea-wait-dots" aria-hidden="true"><i /><i /><i /></span>}
                <span>{t(error ? "qrUnavailable" : "qrPreparing")}</span>
              </div>
            )}
            {expired && <div className="gea-qr-expired"><p>{t("qrExpired")}</p></div>}
          </div>
          <p className="gea-login-status" role="status" aria-live="polite">
            {qr && !expired && !error && <span className="gea-ready-dot" aria-hidden="true" />}
            {qr && !error ? t(expired ? "qrExpiredHint" : "qrWaiting") : null}
          </p>
          <fieldset disabled={busy || !status} className="gea-environments">
            <legend>{t("environment")}</legend>
            {(status?.environments ?? ["production", "test"]).map(
              (environment) => (
                <label key={environment}>
                  <input
                    type="radio"
                    name="environment"
                    value={environment}
                    checked={status?.environment === environment}
                    onChange={() => {
                      setStatus((previous) =>
                        previous
                          ? {
                              ...previous,
                              environment: environment as Status["environment"],
                              authenticated: false,
                            }
                          : previous,
                      );
                      setQr(undefined);
                      setExpired(false);
                      setPreview(undefined);
                      setSelection([]);
                      setSessionId(null);
                    }}
                  />
                  <span>
                    {t(environment === "production" ? "production" : "test")}
                  </span>
                </label>
              ),
            )}
          </fieldset>
          <button
            type="button"
            className="gea-login-submit"
            disabled={busy || !status}
            onClick={() => setQrRefresh((value) => value + 1)}
          >
            {busy ? t("qrPreparing") : t("refreshQr")}
          </button>
          {error && <p role="alert">{error}</p>}
          <aside className="gea-login-tip">
            <strong>{t("loginTipTitle")}</strong>
            <p>{t("loginTip")}</p>
          </aside>
          <footer>{t("loginFooter")}</footer>
        </section>
      </main>
    );
  return (
    <div className="gea-workbench-document">
      {apiLogOpen ? (
        <ApiLogCenter
          environment={status.environment}
          request={rpc}
          onClose={() => setApiLogOpen(false)}
        />
      ) : (
        <div className="gea-shell">
          <aside className="gea-shell-sidebar">
            <div className="gea-brand"><span className="gea-brand-mark">思</span><span>GEA平台</span></div>
            <button className="gea-collapse" type="button" aria-label="收起导航"><ShellIcon name="menu" /></button>
            <nav className="gea-primary-nav" aria-label="主导航">
              <button type="button" className="gea-nav-item is-active"><ShellIcon name="robot" /><span>AI工作台</span></button>
              <button type="button" className="gea-nav-item"><ShellIcon name="calendar" /><span>业务待办</span></button>
              <button type="button" className="gea-nav-item"><ShellIcon name="users" /><span>客户管理</span><span className="gea-nav-chevron">⌄</span></button>
              <button type="button" className="gea-nav-item"><ShellIcon name="box" /><span>计划管理</span><span className="gea-nav-chevron">⌄</span></button>
            </nav>
            <div className="gea-nav-section-label">插件工作区</div>
            <nav className="gea-plugin-nav" aria-label="插件导航">
              <button type="button" className={`gea-plugin-nav-item ${shellView === "workbench" ? "is-active" : ""}`} onClick={() => setShellView("workbench")}>业务工作台</button>
              {HTML_PLUGINS.map((plugin) => (
                <button key={plugin.id} type="button" className={`gea-plugin-nav-item ${shellView === "plugin" && selectedPlugin.id === plugin.id ? "is-active" : ""}`} onClick={() => { setSelectedPlugin(plugin); setShellView("plugin"); }}>
                  <span className="gea-plugin-dot" />{plugin.label}
                </button>
              ))}
            </nav>
            <div className="gea-sidebar-footer"><div className="gea-user-avatar">{status.user?.name?.slice(0, 1) ?? "刘"}</div><div><strong>{status.user?.name ?? "当前用户"}</strong><span>{status.user?.tenantId ?? "已登录"}</span></div><ShellIcon name="settings" /></div>
          </aside>
          <main className="gea-shell-main">
            <header className="gea-shell-header"><div><span className="gea-breadcrumb">AI工作台</span><span className="gea-breadcrumb-separator">/</span><strong>{shellView === "plugin" ? selectedPlugin.label : "产销协同工作台 V0.2"}</strong></div><div className="gea-shell-header-actions"><span className="gea-session-state"><i />{status.environment === "production" ? "正式环境" : "测试环境"}</span><button type="button" className="gea-icon-button" aria-label="历史记录"><ShellIcon name="history" /></button><button type="button" className="gea-icon-button" aria-label="新建"><ShellIcon name="plus" /></button></div></header>
            <section className="gea-plugin-stage" aria-label="插件内容">
              {shellView === "plugin" ? <iframe ref={pluginFrame} onLoad={notifyPluginIdentity} title={selectedPlugin.label} src={selectedPlugin.url} sandbox="allow-scripts allow-same-origin allow-forms" /> : (
                <WorkbenchSessionProvider value={{ conversationId: sessionId }}>
                  <div className="gea-original-workbench">
                    <RegionalApprovalWorkbench
                      key={workbenchRevision}
                      stateScope={`gea-dsh:${status.environment}:${status.user?.tenantId}:${status.user?.id}`}
                      t={locale.t.bind(locale)} onContextChange={onContextChange} queryClient={salesPlan} detailClient={salesPlan}
                      permissionCodes={status.permissionCodes} liveActionsEnabled={true}
                      liveActionClient={{ action: { invoke: (input) => rpc("sales-plan/action", input) } }}
                      onResubmit={(planId, versionId, period) => setResubmit({ planId, versionId, period })} automaticAnalysisEnabled={true}
                    />
                  </div>
                  {resubmit && <RegionalApprovalResubmitDialog key={resubmit.versionId} {...resubmit} client={resubmitClient} connected={status?.resubmitConnected === true} t={locale.t.bind(locale)} onClose={() => setResubmit(undefined)} onSucceeded={() => { setSelection([]); setWorkbenchRevision(value => value + 1); }} />}
                </WorkbenchSessionProvider>
              )}
            </section>
          </main>
          <aside className="gea-assistant-panel">
            <div className="gea-assistant-tabs"><button type="button" className="is-active"><ShellIcon name="robot" /></button><button type="button">对话</button><button type="button">...</button></div>
            <div className="gea-assistant-content"><div className="gea-assistant-avatar">思</div><h2>开启你的AI工作方式</h2><p>可直接输入问题，也可以引用当前插件的数据继续追问。</p><div className="gea-assistant-label">常见问法</div>{["生成本周产销协同会议摘要", "哪些基地订单满足率未达目标？", "水控缺货的根因和措施？", "哪些库存组合超过12天？", "列出本周到期任务"].map((question) => <button key={question} type="button" className="gea-suggestion" onClick={() => setModelState(question)}><span>{question}</span><b>→</b></button>)}</div>
            <div className="gea-assistant-compose"><button type="button" aria-label="添加上下文"><ShellIcon name="plus" /></button><input value={modelState} onChange={(event) => setModelState(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") setModelState(""); }} placeholder="输入问题"/><button type="button" className="gea-send-button" aria-label="发送" onClick={() => setModelState("")}><ShellIcon name="send" /></button></div>
          </aside>
        </div>
      )}
    </div>
  );
}

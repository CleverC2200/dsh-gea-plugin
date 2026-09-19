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
        <>
          <WorkbenchSessionProvider value={{ conversationId: sessionId }}>
            <div className="gea-original-workbench">
              <RegionalApprovalWorkbench
                key={workbenchRevision}
                stateScope={`gea-dsh:${status.environment}:${status.user?.tenantId}:${status.user?.id}`}
                t={locale.t.bind(locale)}
                onContextChange={onContextChange}
                queryClient={salesPlan}
                detailClient={salesPlan}
                permissionCodes={status.permissionCodes}
                liveActionsEnabled={true}
                liveActionClient={{ action: { invoke: (input) => rpc("sales-plan/action", input) } }}
                onResubmit={(planId, versionId, period) => setResubmit({ planId, versionId, period })}
                automaticAnalysisEnabled={true}
              />
            </div>
            {resubmit && <RegionalApprovalResubmitDialog key={resubmit.versionId} {...resubmit}
              client={resubmitClient} connected={status?.resubmitConnected === true} t={locale.t.bind(locale)}
              onClose={() => setResubmit(undefined)} onSucceeded={() => { setSelection([]); setWorkbenchRevision(value => value + 1); }} />}
          </WorkbenchSessionProvider>
        </>
      )}
    </div>
  );
}

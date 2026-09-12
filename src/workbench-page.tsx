/** GEA's original approval workbench in a standalone, authenticated document. */
import { RegionalApprovalResubmitDialog } from './workbench-original/workbenches/regionalApproval/RegionalApprovalResubmitDialog.tsx';
import type { GeaSalesPlanPeriod } from './workbench-original/contracts.ts';
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
} from "./workbench-original/index.ts";
import commonEn from "./workbench-original/en-US.json" with { type: "json" };
import commonZh from "./workbench-original/zh-CN.json" with { type: "json" };
import { salesPlan } from "./workbench-original/bridge.ts";
import type { Business, Preview } from "./business.ts";
import type { CopyKey } from "./locales.ts";
import "./workbench.css";
import logo from "./gea-logo.png";

type Status = ReturnType<Business["status"]>;
type Translate = (key: CopyKey) => string;
type AnalysisScope = "summary" | "details";
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
      body: { code, error: result.error?.message ?? code, details: result.error?.details },
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
    submit: { invoke: unavailable },
  },
  modelInference: {
    invoke: async () => ({
      status: "failed",
      provider_id: "gea-analysis",
      model: "",
    }),
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

/** Mount only real GEA data; unauthenticated and failed queries never switch to fixtures. */
export function WorkbenchPage({ t }: { t: Translate }) {
  const [status, setStatus] = useState<Status>();
  const [workbenchRevision, setWorkbenchRevision] = useState(0);
  const [resubmit, setResubmit] = useState<{ planId: string; versionId: string; period: GeaSalesPlanPeriod }>();
  useEffect(() => setResubmit(undefined), [status?.environment, status?.user?.id]);
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
        authenticated: status?.authenticated === true,
        name: status?.authenticated ? (status.user?.name ?? "") : "",
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
  const onContextChange = useCallback(
    (context: RegionalApprovalWorkbenchContext) => {
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
          <h2>{t("login")}</h2>
          <p>{t("scanInstructions")}</p>
          {qr && (
            <div className="gea-login-qr">
              <img src={qr.image} alt={t("login")} width="220" height="220" />
              {expired && <p role="status">{t("expired")}</p>}
            </div>
          )}
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
            {busy ? t("busy") : t("refreshQr")}
          </button>
          {error && <p role="alert">{error}</p>}
          <footer>{t("loginFooter")}</footer>
        </section>
      </main>
    );
  return (
    <div className="gea-workbench-document">
      <WorkbenchSessionProvider value={{ conversationId: sessionId }}>
        <div className="gea-original-workbench">
          <RegionalApprovalWorkbench
            key={workbenchRevision}
            stateScope={`gea-dsh:${status.environment}:${status.user?.tenantId}:${status.user?.id}`}
            t={locale.t.bind(locale)}
            onContextChange={onContextChange}
            queryClient={salesPlan}
            detailClient={salesPlan}
            liveActionsEnabled={true}
            liveActionClient={{ action: { invoke: (input) => rpc("sales-plan/action", input) } }}
            onResubmit={(planId, versionId, period) => setResubmit({ planId, versionId, period })}
            automaticAnalysisEnabled={false}
          />
        </div>
        {resubmit && <RegionalApprovalResubmitDialog key={resubmit.versionId} {...resubmit}
          client={resubmitClient} connected={false} t={locale.t.bind(locale)}
          onClose={() => setResubmit(undefined)} onSucceeded={() => { setSelection([]); setWorkbenchRevision(value => value + 1); }} />}
      </WorkbenchSessionProvider>

    </div>
  );
}

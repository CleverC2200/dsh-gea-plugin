/** GEA's original approval workbench in a standalone, authenticated document. */
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
      body: { code, error: result.error?.message ?? code },
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
const host: WorkbenchHost = {
  salesPlan: {
    periods: { invoke: (input) => query("periods", input) },
    list: { invoke: (input) => query("list", input) },
    detail: { invoke: (input) => query("detail", input) },
    versions: { invoke: (input) => query("versions", input) },
    logs: { invoke: (input) => query("logs", input) },
    versionSkus: { invoke: (input) => query("versionSkus", input) },
    compare: { invoke: (input) => query("compare", input) },
    action: { invoke: unavailable },
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

function requestErrorMessage(error: unknown, t: Translate): string {
  if (error instanceof BackendHttpError) {
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
  const [qr, setQr] = useState<{ image: string; loginId: string }>();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [analysisScope, setAnalysisScope] = useState<AnalysisScope>("summary");
  const [preview, setPreview] = useState<Preview>();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
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
                      void run(async (signal) => {
                        const value = await rpc<Status>(
                          "environment/select",
                          { environment },
                          signal,
                        );
                        if (!signal.aborted) setStatus(value);
                      });
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
            onClick={() =>
              void run(async (signal) => {
                setExpired(false);
                setQr(undefined);
                const value = await rpc<{ image: string; loginId: string }>(
                  "login/start",
                  { environment: status?.environment },
                  signal,
                );
                if (!signal.aborted) setQr(value);
              })
            }
          >
            {busy ? t("busy") : t("login")}
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
            stateScope={`gea-dsh:${status.environment}:${status.user?.name ?? "user"}`}
            t={locale.t.bind(locale)}
            onContextChange={onContextChange}
            queryClient={salesPlan}
            detailClient={salesPlan}
            liveActionsEnabled={false}
            automaticAnalysisEnabled={false}
          />
        </div>
      </WorkbenchSessionProvider>
      <div className="gea-analysis-toolbar">
        <span>
          {t("selectedCount")} {selection.length}
        </span>
        <label>
          {t("analysisScope")}
          <select
            value={analysisScope}
            aria-label={t("analysisScope")}
            aria-describedby="gea-analysis-scope-help"
            onChange={(event) => {
              request.current?.abort();
              setAnalysisScope(event.currentTarget.value as AnalysisScope);
              setPreview(undefined);
              setBusy(false);
              setError("");
            }}
          >
            <option value="summary">{t("analysisSummaryScope")}</option>
            <option value="details">{t("analysisDetailsScope")}</option>
          </select>
        </label>
        <span id="gea-analysis-scope-help">{t("analysisScopeHelp")}</span>
        <button
          type="button"
          onClick={() => {
            setQr(undefined);
            setPreview(undefined);
            setSessionId(null);
            void run(async (signal) => {
              const value = await rpc<Status>(
                "environment/select",
                { environment: status.environment },
                signal,
              );
              if (!signal.aborted) setStatus(value);
            });
          }}
        >
          {t("changeEnvironment")}
        </button>
        <button
          type="button"
          disabled={busy || !selection.length}
          onClick={() =>
            void run(async (signal) => {
              setPreview(undefined);
              const value = await rpc<Preview>(
                "workbench/prepare",
                { planIds: selection, scope: analysisScope },
                signal,
              );
              if (!signal.aborted) setPreview(value);
            })
          }
        >
          {t("preview")}
        </button>
        {preview && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async (signal) => {
                const value = await rpc<{ sessionId: string }>(
                  "submit",
                  { previewId: preview.previewId },
                  signal,
                );
                if (!signal.aborted) {
                  setSessionId(value.sessionId);
                  window.parent.postMessage(
                    { type: "gea:open-session", sessionId: value.sessionId },
                    window.location.origin,
                  );
                  setPreview(undefined);
                }
              })
            }
          >
            {t(status.mode === "model" ? "analysis" : "receipt")}
          </button>
        )}
        {preview && (
          <details>
            <summary>
              {t("previewTitle")} · {preview.bytes} B
            </summary>
            <pre>{preview.prompt}</pre>
          </details>
        )}
        {error && <span role="alert">{error}</span>}
      </div>
    </div>
  );
}

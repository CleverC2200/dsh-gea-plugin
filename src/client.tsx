/** Sales-plan page composed into the standard dsh Web navigation and Session UI. */
import React, { useEffect, useRef, useState } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {
  Business,
  Collection,
  Detail,
  Page as PlanPage,
  Preview,
  Row,
} from "./business.ts";
import { zh, en, type CopyKey } from "./locales.ts";
import css from "./client.css";
import {
  ForecastAssistantSurface,
  organizationValueFor,
  organizationValuesFor,
  type OrganizationView,
} from "./forecast-surface.tsx";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    geaProof: CopyKey;
  }
}
type Translate = (key: CopyKey) => string;
type Status = ReturnType<Business["status"]>;
type Filters = {
  periodId: string;
  planTypeCode: string;
  status: string;
  pageNo: number;
};
type Qr = { image: string; loginId: string; expiresIn: number };
class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fixed authenticated Fetch transport; generic values correspond to the Host endpoint declarations. */
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
  if (!response.ok)
    throw new RequestError(
      "HOST_HTTP_" + response.status,
      "HOST_HTTP_" + response.status,
    );
  const result: {
    ok: boolean;
    value: T;
    error?: { code: string; message: string };
  } = await response.json();
  if (result.ok !== true)
    throw new RequestError(
      result.error?.code ?? "INVALID_HOST_RESPONSE",
      result.error?.message ?? "INVALID_HOST_RESPONSE",
    );
  return result.value;
}

function Fields({
  row,
  fields,
  t,
}: {
  row: Row | null;
  fields: CopyKey[];
  t: Translate;
}) {
  return (
    <dl className="gea-fields">
      {fields.map((key) => (
        <div key={key}>
          <dt>{t(key)}</dt>
          <dd>{row?.[key] == null ? t("unknown") : String(row[key])}</dd>
        </div>
      ))}
    </dl>
  );
}
function Coverage({ value, t }: { value: Collection; t: Translate }) {
  return (
    <p className="gea-meta">
      {t(value.coverage === "unknown" ? "unknownCoverage" : value.coverage)} ·{" "}
      {t("returned")} {value.returned} / {value.total ?? t("unknown")} ·{" "}
      {t("fetchedAt")} {value.fetchedAt}
    </p>
  );
}

export const inject = [
  "slots",
  "layout",
  "locale",
  "connection",
  "uiWorkspace",
];

/** Register locale-owned navigation and a page whose request generations discard obsolete results. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register("geaProof", { zh, en }));
  const t: Translate = ctx.locale.bind("geaProof");
  function Page() {
    const [status, setStatus] = useState<Status>();
    const [qr, setQr] = useState<Qr>();
    const [qrState, setQrState] = useState<"pending" | "expired" | "failed">(
      "pending",
    );
    const [periods, setPeriods] = useState<Collection>();
    const [data, setData] = useState<PlanPage>();
    const [filters, setFilters] = useState<Filters>({
      periodId: "",
      planTypeCode: "",
      status: "",
      pageNo: 1,
    });
    const [selected, setSelected] = useState<string>();
    const [detail, setDetail] = useState<Detail>();
    const [versions, setVersions] = useState<Collection>();
    const [versionId, setVersionId] = useState<string>();
    const [skus, setSkus] = useState<Collection>();
    const [skuIds, setSkuIds] = useState<string[]>([]);
    const [includeDetail, setIncludeDetail] = useState(false);
    const [includeSkus, setIncludeSkus] = useState(false);
    const [preview, setPreview] = useState<Preview>();
    const [sessionId, setSessionId] = useState<SessionId>();
    const [organizationView, setOrganizationView] =
      useState<OrganizationView>("all");
    const [organizationValue, setOrganizationValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<RequestError>();
    const active = useRef<AbortController | undefined>(undefined);
    const login = useRef<AbortController | undefined>(undefined);
    const submitting = useRef(false);
    const row = data?.records.find((row) => row.planId === selected);
    const organizationValues = data ? organizationValuesFor(data.records, organizationView) : [];
    const visibleRecords =
      data?.records.filter((record) => {
        if (organizationView === "all" || !organizationValue) return true;
        return organizationValueFor(record, organizationView) === organizationValue;
      }) ?? [];
    const selection =
      data && row ? { queryId: data.queryId, planId: row.planId } : undefined;

    const clearPreview = () => {
      setPreview(undefined);
      setSessionId(undefined);
    };
    const clearExtras = () => {
      setDetail(undefined);
      setVersions(undefined);
      setVersionId(undefined);
      setSkus(undefined);
      setSkuIds([]);
      setIncludeDetail(false);
      setIncludeSkus(false);
      clearPreview();
    };
    const clearQuery = () => {
      setData(undefined);
      setSelected(undefined);
      setOrganizationView("all");
      setOrganizationValue("");
      clearExtras();
    };
    const cancel = () => {
      active.current?.abort();
      setBusy(false);
    };
    const fail = (error: unknown) => {
      const failure =
        error instanceof RequestError
          ? error
          : new RequestError("GEA_NETWORK_ERROR", t("retry"));
      setError(failure);
      if (["GEA_HTTP_401", "LOGIN_REQUIRED"].includes(failure.code)) {
        clearQuery();
        setPeriods(undefined);
        setQr(undefined);
        setStatus((old) =>
          old
            ? {
                ...old,
                authenticated: false,
                loginState: "expired",
                user: null,
              }
            : old,
        );
      }
      if (
        ["STALE_SELECTION", "STALE_PREVIEW", "STALE_LOGIN"].includes(
          failure.code,
        )
      )
        clearQuery();
    };
    const run = async (work: (signal: AbortSignal) => Promise<void>) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError(undefined);
      try {
        await work(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) fail(error);
      } finally {
        if (active.current === controller) setBusy(false);
      }
    };

    useEffect(() => {
      const controller = new AbortController();
      void rpc<Status>("status", {}, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) setStatus(value);
        })
        .catch((error) => {
          if (!controller.signal.aborted) fail(error);
        });
      return () => {
        controller.abort();
        active.current?.abort();
        login.current?.abort();
      };
    }, []);
    useEffect(() => {
      if (!qr || qrState !== "pending") return;
      const controller = new AbortController();
      login.current = controller;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const result = await rpc<
            Status & { status: "authenticated" | "pending" | "expired" }
          >("login/poll", { loginId: qr.loginId }, controller.signal);
          if (controller.signal.aborted) return;
          if (result.status === "authenticated") {
            setStatus(result);
            setQr(undefined);
          } else if (result.status === "expired") setQrState("expired");
          else timer = setTimeout(poll, 2500);
        } catch (error) {
          if (!controller.signal.aborted) {
            fail(error);
            setQrState("failed");
          }
        }
      };
      timer = setTimeout(poll, 500);
      return () => {
        controller.abort();
        clearTimeout(timer);
      };
    }, [qr, qrState]);

    const query = (next = filters) => {
      clearQuery();
      setFilters(next);
      void run(async (signal) => {
        const value = await rpc<PlanPage>("plans", next, signal);
        if (signal.aborted) return;
        setData(value);
        setSelected(value.records[0]?.planId as string | undefined);
      });
    };
    const changeFilters = (value: Partial<Filters>) => {
      cancel();
      clearQuery();
      setFilters((old) => ({ ...old, ...value, pageNo: 1 }));
    };
    const openSession = (id: SessionId) => {
      ctx.uiWorkspace.openSession(id);
      ctx.layout.selectPanel(null);
    };
    const submit = () => {
      if (sessionId) {
        openSession(sessionId);
        return;
      }
      if (!preview || submitting.current) return;
      submitting.current = true;
      void run(async (signal) => {
        try {
          const value = await rpc<{ sessionId: SessionId }>(
            "submit",
            { previewId: preview.previewId },
            signal,
          );
          if (!signal.aborted) {
            setSessionId(value.sessionId);
            openSession(value.sessionId);
          }
        } finally {
          submitting.current = false;
        }
      });
    };
    const errorHelp: CopyKey =
      error?.code === "GEA_HTTP_403"
        ? "forbidden"
        : error?.code === "SNAPSHOT_TOO_LARGE"
          ? "tooLarge"
          : error?.code.startsWith("STALE_")
            ? "stale"
            : ["GEA_HTTP_401", "LOGIN_REQUIRED"].includes(error?.code ?? "")
              ? "loginExpired"
              : "retry";

    return (
      <div className="gea-page">
        <style>{css}</style>
        <main className="gea-content">
          <header>
            <h1>{t("title")}</h1>
            <p>{t("intro")}</p>
          </header>
          <section className="gea-section" aria-label={t("login")}>
            <div className="gea-toolbar">
              <strong>
                {status?.authenticated
                  ? `${t("signedIn")}：${status.user?.name}`
                  : t(
                      status?.loginState === "expired"
                        ? "loginExpired"
                        : "signedOut",
                    )}
              </strong>
              <button
                disabled={busy}
                onClick={() => {
                  login.current?.abort();
                  clearQuery();
                  setPeriods(undefined);
                  setQr(undefined);
                  setStatus((old) =>
                    old ? { ...old, authenticated: false, user: null } : old,
                  );
                  void run(async (signal) => {
                    const value = await rpc<Qr>("login/start", {}, signal);
                    if (!signal.aborted) {
                      setQr(value);
                      setQrState("pending");
                    }
                  });
                }}
              >
                {t("login")}
              </button>
            </div>
            <p className="gea-meta">
              {t("environment")}：{status?.source ?? t("unknown")}
            </p>
            <p className="gea-meta">{t("loginHelp")}</p>
            <p className="gea-mode">
              {status?.mode === "model"
                ? `${t("modelMode")} · ${status.provider} / ${status.model}`
                : t("receiptMode")}
            </p>
            {qr && (
              <div className="gea-qr">
                <img
                  src={qr.image}
                  width="256"
                  height="256"
                  alt={t("pending")}
                />
                <p role="status">
                  {t(
                    qrState === "expired"
                      ? "expired"
                      : qrState === "failed"
                        ? "failure"
                        : "pending",
                  )}
                </p>
              </div>
            )}
          </section>
          <form
            className="gea-filters"
            onSubmit={(event) => {
              event.preventDefault();
              query();
            }}
          >
            <label>
              {t("period")}
              <select
                disabled={!status?.authenticated || busy}
                value={filters.periodId}
                onChange={(event) =>
                  changeFilters({ periodId: event.target.value })
                }
              >
                <option value="">{t("all")}</option>
                {periods?.records.map((row) => (
                  <option
                    key={String(row.periodId)}
                    value={String(row.periodId)}
                  >
                    {row.periodMonth ?? row.periodId} ·{" "}
                    {row.planTypeCode ?? t("unknown")} ·{" "}
                    {row.status ?? t("unknown")}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!status?.authenticated || busy}
              onClick={() => {
                setPeriods(undefined);
                void run(async (signal) => {
                  const value = await rpc<Collection>("periods", {}, signal);
                  if (!signal.aborted) setPeriods(value);
                });
              }}
            >
              {t("periods")}
            </button>
            <label>
              {t("planTypeCode")}
              <input
                value={filters.planTypeCode}
                onChange={(event) =>
                  changeFilters({ planTypeCode: event.target.value })
                }
                placeholder={t("all")}
                maxLength={32}
              />
            </label>
            <label>
              {t("status")}
              <input
                value={filters.status}
                onChange={(event) =>
                  changeFilters({ status: event.target.value })
                }
                placeholder={t("all")}
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={12}
              />
            </label>
            <button
              className="gea-primary"
              disabled={!status?.authenticated || busy}
              type="submit"
            >
              {t("query")}
            </button>
          </form>
          {periods && <Coverage value={periods} t={t} />}
          {busy && (
            <p role="status" className="gea-meta">
              {t("busy")}
            </p>
          )}
          {error && (
            <div role="alert" className="gea-error">
              <strong>{t(errorHelp)}</strong>
              <p>{error.message}</p>
            </div>
          )}
          {!data && !busy && <p className="gea-empty">{t("noQuery")}</p>}
          {data && (
            <section className="gea-section gea-live-section" aria-label={t("live")}>
              <ForecastAssistantSurface
                rows={visibleRecords}
                selectedRow={row ?? null}
                selectedVersionId={versionId ?? row?.versionId?.toString()}
                analysisMode={status?.mode === "model" ? "model" : "receipt"}
                view={organizationView}
                organizationOptions={organizationValues}
                organizationValue={organizationValue}
                canSend={Boolean(preview) && !busy}
                onSend={submit}
                onOrganizationValueChange={(value) => {
                  setOrganizationValue(value);
                  if (organizationView === "all") return;
                  const next = data.records.find(
                    (record) => organizationValueFor(record, organizationView) === value,
                  );
                  if (next && next.planId !== selected) {
                    cancel();
                    clearExtras();
                    setSelected(String(next.planId));
                  } else if (!next) {
                    cancel();
                    clearExtras();
                    setSelected(undefined);
                  }
                }}
                onViewChange={(next) => {
                  setOrganizationView(next);
                  const nextValues = next === "all" ? [] : organizationValuesFor(data.records, next);
                  const nextValue = next !== "all"
                    ? nextValues[0] ?? ""
                    : "";
                  setOrganizationValue(nextValue);
                  if (next !== "all") {
                    const nextRecord = data.records.find(
                      (record) => organizationValueFor(record, next) === nextValue,
                    );
                    if (nextRecord && nextRecord.planId !== selected) {
                      cancel();
                      clearExtras();
                      setSelected(String(nextRecord.planId));
                    } else if (!nextRecord) {
                      cancel();
                      clearExtras();
                      setSelected(undefined);
                    }
                  }
                }}
                t={t}
              />
              <div className="gea-toolbar">
                <h2>{t("live")}</h2>
                <span className="gea-meta">
                  {t("total")} {data.total} · {t("returned")}{" "}
                  {data.records.length} · {t("page")} {data.current}
                </span>
              </div>
              <p className="gea-meta">
                {t("fetchedAt")} {data.fetchedAt} · {t("period")}{" "}
                {data.query.periodId || t("all")} · {t("planTypeCode")}{" "}
                {data.query.planTypeCode || t("all")} · {t("status")}{" "}
                {data.query.status || t("all")}
              </p>
              <div className="gea-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {(
                        [
                          "select",
                          "planId",
                          "dealer",
                          "planTypeCode",
                          "currentQty",
                          "currentAmount",
                          "updatedAt",
                        ] as CopyKey[]
                      ).map((key) => (
                        <th key={key}>{t(key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRecords.map((record) => (
                      <tr
                        key={String(record.planId)}
                        aria-selected={record.planId === selected}
                      >
                        <td>
                          <input
                            type="radio"
                            name="gea-plan"
                            aria-label={`${t("select")} ${record.planId}`}
                            checked={record.planId === selected}
                            onChange={() => {
                              cancel();
                              clearExtras();
                              setSelected(String(record.planId));
                            }}
                          />
                        </td>
                        <td>
                          {record.planId ?? t("unknown")}
                          <small>
                            {t("versionId")} {record.versionId ?? t("unknown")}
                          </small>
                        </td>
                        <td>
                          {record.orgName ?? record.dealerName ?? record.dealerCode ?? t("unknown")}
                          <small>
                            {record.provinceName ?? record.areaName ?? t("unknown")}
                          </small>
                        </td>
                        <td>
                          {record.planTypeCode ?? t("unknown")}
                          <small>{t("status")} {record.status ?? t("unknown")}</small>
                        </td>
                        <td>
                          {record.currentQty ?? t("unknown")} / {record.targetQty ?? t("unknown")}
                        </td>
                        <td>
                          {record.currentAmount ?? t("unknown")} / {record.targetAmount ?? t("unknown")}
                        </td>
                        <td>{record.updatedAt ?? t("unknown")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!visibleRecords.length && (
                <p className="gea-empty">{t("empty")}</p>
              )}
              <div className="gea-toolbar gea-actions">
                <div className="gea-toolbar">
                  <button
                    disabled={busy || data.current <= 1}
                    onClick={() =>
                      query({ ...filters, pageNo: data.current - 1 })
                    }
                  >
                    {t("previous")}
                  </button>
                  <button
                    disabled={busy || data.current * data.size >= data.total}
                    onClick={() =>
                      query({ ...filters, pageNo: data.current + 1 })
                    }
                  >
                    {t("next")}
                  </button>
                </div>
                {selection && (
                  <div className="gea-toolbar">
                    <button
                      disabled={busy}
                      onClick={() => {
                        setDetail(undefined);
                        setIncludeDetail(false);
                        clearPreview();
                        void run(async (signal) => {
                          const value = await rpc<Detail>(
                            "detail",
                            selection,
                            signal,
                          );
                          if (!signal.aborted) {
                            setDetail(value);
                            setIncludeDetail(true);
                          }
                        });
                      }}
                    >
                      {t("detail")}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setVersions(undefined);
                        setVersionId(undefined);
                        setSkus(undefined);
                        setIncludeSkus(false);
                        clearPreview();
                        void run(async (signal) => {
                          const value = await rpc<Collection>(
                            "versions",
                            selection,
                            signal,
                          );
                          if (!signal.aborted) setVersions(value);
                        });
                      }}
                    >
                      {t("versions")}
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}
          {detail && (
            <section className="gea-section">
              <h2>{t("currentDetail")}</h2>
              <p className="gea-meta">{t("detailHelp")}</p>
              <Fields
                row={detail.currentVersion}
                fields={[
                  "planId",
                  "id",
                  "seq",
                  "status",
                  "targetQty",
                  "targetAmount",
                  "returnReason",
                  "updatedAt",
                ]}
                t={t}
              />
              <p className="gea-meta">
                {t("fetchedAt")} {detail.fetchedAt}
              </p>
              <label className="gea-check">
                <input
                  type="checkbox"
                  checked={includeDetail}
                  onChange={(event) => {
                    setIncludeDetail(event.target.checked);
                    clearPreview();
                  }}
                />
                {t("includeDetail")}
              </label>
            </section>
          )}
          {versions && (
            <section className="gea-section">
              <h2>{t("chooseVersion")}</h2>
              <Coverage value={versions} t={t} />
              <div className="gea-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {(
                        [
                          "select",
                          "id",
                          "seq",
                          "status",
                          "targetQty",
                          "targetAmount",
                          "updatedAt",
                        ] as CopyKey[]
                      ).map((key) => (
                        <th key={key}>{t(key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {versions.records.map((record) => (
                      <tr
                        key={String(record.id)}
                        aria-selected={record.id === versionId}
                      >
                        <td>
                          <input
                            type="radio"
                            name="gea-version"
                            aria-label={`${t("select")} ${record.id}`}
                            checked={record.id === versionId}
                            onChange={() => {
                              cancel();
                              setVersionId(String(record.id));
                              setSkus(undefined);
                              setSkuIds([]);
                              setIncludeSkus(false);
                              clearPreview();
                            }}
                          />
                        </td>
                        {(
                          [
                            "id",
                            "seq",
                            "status",
                            "targetQty",
                            "targetAmount",
                            "updatedAt",
                          ] as const
                        ).map((key) => (
                          <td key={key}>{record[key] ?? t("unknown")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!versions.records.length && <p>{t("noVersions")}</p>}
              {versionId && (
                <div className="gea-actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      setSkus(undefined);
                      setSkuIds([]);
                      setIncludeSkus(false);
                      clearPreview();
                      void run(async (signal) => {
                        const value = await rpc<Collection>(
                          "skus",
                          { ...selection, versionId },
                          signal,
                        );
                        if (!signal.aborted) {
                          setSkus(value);
                          setSkuIds(value.records.map((row) => String(row.id)));
                          setIncludeSkus(true);
                        }
                      });
                    }}
                  >
                    {t("skus")}
                  </button>
                  <span className="gea-meta">
                    {t("selectedVersion")} {versionId}
                  </span>
                </div>
              )}
            </section>
          )}
          {skus && (
            <section className="gea-section">
              <h2>
                {t("selectedVersion")} {versionId} · SKU
              </h2>
              <Coverage value={skus} t={t} />
              <div className="gea-toolbar">
                <label className="gea-check">
                  <input
                    type="checkbox"
                    checked={includeSkus}
                    onChange={(event) => {
                      setIncludeSkus(event.target.checked);
                      clearPreview();
                    }}
                  />
                  {t("includeSkus")}
                </label>
                <label className="gea-check">
                  <input
                    type="checkbox"
                    checked={
                      skuIds.length === skus.records.length &&
                      skus.records.length > 0
                    }
                    onChange={(event) => {
                      setSkuIds(
                        event.target.checked
                          ? skus.records.map((row) => String(row.id))
                          : [],
                      );
                      clearPreview();
                    }}
                  />
                  {t("allSkus")}
                </label>
                <span>
                  {t("selectedCount")} {skuIds.length}
                </span>
              </div>
              <div className="gea-table-scroll gea-skus">
                <table>
                  <thead>
                    <tr>
                      <th>{t("select")}</th>
                      {skuColumns.map((key) => (
                        <th key={key}>{t(key)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {skus.records.map((record) => (
                      <tr key={String(record.id)}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`${t("select")} ${record.skuCode ?? record.id}`}
                            checked={skuIds.includes(String(record.id))}
                            onChange={(event) => {
                              setSkuIds((old) =>
                                event.target.checked
                                  ? [...old, String(record.id)]
                                  : old.filter((id) => id !== record.id),
                              );
                              clearPreview();
                            }}
                          />
                        </td>
                        {skuColumns.map((key) => (
                          <td key={key}>{record[key] ?? t("unknown")}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!skus.records.length && <p>{t("noSkus")}</p>}
            </section>
          )}
          {selection && (
            <div className="gea-actions">
              <button
                className="gea-primary"
                disabled={busy}
                onClick={() => {
                  clearPreview();
                  void run(async (signal) => {
                    const value = await rpc<Preview>(
                      "prepare",
                      {
                        ...selection,
                        includeDetail,
                        ...(versionId ? { versionId } : {}),
                        ...(includeSkus ? { skuIds } : {}),
                      },
                      signal,
                    );
                    if (!signal.aborted) setPreview(value);
                  });
                }}
              >
                {t("preview")}
              </button>
            </div>
          )}
          {preview && (
            <section className="gea-section gea-preview">
              <h2>{t("previewTitle")}</h2>
              <p>{t("previewHelp")}</p>
              <Fields
                row={row ?? null}
                fields={[
                  "planId",
                  "versionId",
                  "planTypeCode",
                  "currentQty",
                  "targetQty",
                  "currentAmount",
                  "targetAmount",
                ]}
                t={t}
              />
              <p>
                {t("selectedVersion")} {versionId ?? t("unknown")} ·{" "}
                {t("selectedCount")} SKU {includeSkus ? skuIds.length : 0}
              </p>
              {(!includeDetail || !versionId || !includeSkus) && (
                <p className="gea-meta">
                  {t("missing")}：
                  {[
                    !includeDetail && t("missingDetail"),
                    !versionId && t("missingVersion"),
                    !includeSkus && t("missingSkus"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              <p className="gea-meta">
                {t("bytes")} {preview.bytes} / {preview.limitBytes}
              </p>
              <details>
                <summary>{t("fullInput")}</summary>
                <pre>{preview.prompt}</pre>
              </details>
              <div className="gea-actions">
                <button
                  className="gea-primary"
                  disabled={busy}
                  onClick={submit}
                >
                  {t(
                    sessionId
                      ? "openSession"
                      : status?.mode === "model"
                        ? "analysis"
                        : "receipt",
                  )}
                </button>
              </div>
              <p className="gea-meta">{t("sessionHelp")}</p>
            </section>
          )}
        </main>
      </div>
    );
  }
  function Icon({ size = 18 }: { size?: number }) {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 8h8M8 12h8M8 16h4" />
      </svg>
    );
  }
  ctx.slots.inject("main", () =>
    ctx.slots.register(
      { name: "main", key: "gea-proof", locale: "geaProof" },
      Page,
    ),
  );
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      {
        name: "sidebar.panellist",
        id: "gea-proof",
        label: () => t("title"),
        order: 5,
        locale: "geaProof",
      },
      Icon,
    ),
  );
}
const skuColumns: CopyKey[] = [
  "id",
  "skuCode",
  "materialDescription",
  "productCategName",
  "baseQty",
  "qty",
  "price",
  "amt",
  "amtBase",
  "regionConfirmedQty",
  "regionConfirmedAmount",
  "provinceConfirmedQty",
  "provinceConfirmedAmount",
  "areaConfirmedQty",
  "areaConfirmedAmount",
  "categoryConfirmedQty",
  "categoryConfirmedAmount",
];
